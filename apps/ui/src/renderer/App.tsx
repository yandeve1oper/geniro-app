import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import type { CliKind } from '../shared/contracts';
import type { DaemonHandle, DaemonMigration } from '../shared/contracts';
import { AgentIdentityContext, agentShortName } from './agent-identity';
import { Chats } from './chats/Chats';
import { REMOTE_HISTORY_PAGE } from './chats/use-chat-run';
import { useNextWaitingShortcut } from './chats/use-next-waiting-shortcut';
import {
  nextWaiting,
  owedCount,
  type WaitReading,
  waitsOnUser,
} from './chats/waiting';
import { WaitingStatus } from './chats/waiting-status';
import { AppUsageButton } from './components/app-usage-button';
import { AvatarImageLoaderContext } from './components/avatar-images';
import { BottomTabBar } from './components/bottom-tab-bar';
import { ConnectionBanner } from './components/connection-banner';
import { EmptyState } from './components/empty-state';
import { type AppView, NavRail } from './components/nav-rail';
import { StartupScreen } from './components/startup-screen';
import { TitleBar } from './components/title-bar';
import { cn } from './components/ui/utils';
import { useLatestCallback } from './components/use-latest-callback';
import { useNarrowViewport } from './components/use-narrow-viewport';
import { usePhoneBackEntry } from './components/use-phone-back-entry';
import { useSidebarCollapsed } from './components/use-sidebar-collapsed';
import { WindowDragStrip } from './components/window-drag-strip';
import { createDaemonApis } from './daemon-api';
import { DaemonClient } from './daemon-client';
import { DebugPanel } from './debug/debug-panel';
import { reportUiErrors } from './debug/report-ui-errors';
import type { KnowledgeRequest } from './knowledge/Knowledge';
import { projectPlace } from './knowledge/knowledge-text';
import { useKnowledgeCounts } from './knowledge/use-knowledge';
import type { FirstLaunch, TeamLaunch } from './onboarding/first-launch';
import { Onboarding } from './onboarding/Onboarding';
import type { ProjectsRequest } from './projects/Projects';
import { isRemoteRuntime } from './remote/remote-session';
import { ResourceAlertStrip } from './resource-alerts/resource-alert-strip';
import { useResourceAlerts } from './resource-alerts/use-resource-alerts';
import { formatRoute, parseRoute, type Route } from './routing';
import { answerLineFlush } from './stats/line-flush';
import { TerminalPanel } from './terminal/terminal-panel';
import { useTerminalShortcut } from './terminal/use-terminal-shortcut';
import {
  newTerminalFolder,
  useTerminalTabs,
} from './terminal/use-terminal-tabs';
import { footerUpdate } from './updates/update-status';
import { useUpdateState } from './updates/use-update-state';
import { useAppProcesses } from './use-app-processes';
import {
  CapabilitiesContext,
  useAgentIdentities,
  useCapabilities,
} from './use-capabilities';

// Code-split the conditionally-rendered views: Teams and Settings each bring
// their own tree — eager imports would put both in the startup chunk of the
// always-mounted shell.
const Teams = lazy(() =>
  import('./teams/Teams').then((m) => ({ default: m.Teams })),
);
import type { SettingsSection } from './settings/Settings';
import { useCliUpdatesAvailable } from './settings/use-cli-updates-available';
import { useMemoryWaitingCount } from './settings/use-memory-waiting-count';

const Settings = lazy(() =>
  import('./settings/Settings').then((m) => ({ default: m.Settings })),
);
const Stats = lazy(() =>
  import('./stats/Stats').then((m) => ({ default: m.Stats })),
);
const Tasks = lazy(() =>
  import('./tasks/Tasks').then((m) => ({ default: m.Tasks })),
);
const Projects = lazy(() =>
  import('./projects/Projects').then((m) => ({ default: m.Projects })),
);
const Knowledge = lazy(() =>
  import('./knowledge/Knowledge').then((m) => ({ default: m.Knowledge })),
);

type Phase = 'loading' | 'onboarding' | 'ready';

/**
 * What the title bar says for a view that is not a document.
 *
 * Only Chats has a name of its own to show (the open thread); the other three
 * are places rather than things, so the bar states where you are — which is
 * what the OS strip used to do with the app's name and nothing else.
 */
const VIEW_TITLE: Record<AppView, string> = {
  chats: 'Chats',
  teams: 'Teams',
  tasks: 'Tasks',
  projects: 'Projects',
  knowledge: 'Knowledge',
  stats: 'Stats',
  settings: 'Settings',
};

/**
 * The address for this shell's current state — the write half of the hash
 * sync in `App`.
 *
 * `openRunId` is the thread CHATS reports as open, never `threadRequest`.
 * Those look interchangeable and are opposites: the request is inbound and
 * one-shot (Chats clears it through `onRunOpened` the moment it honours it,
 * and a click in its own sidebar never sets it), so an address built from it
 * names a thread for one render and nothing afterwards — which is no address
 * at all for a link meant to be copied and sent.
 *
 * `teams`/`tasks` pick their own open item internally (the builder's
 * selection, the board's project), so from here they are addressed by view
 * alone. `projects` is addressed by the project its page reports on show.
 */
function currentRoute(
  view: AppView,
  openRunId: string | null,
  shownProjectId: string | null,
  shownDocumentId: string | null,
): Route {
  switch (view) {
    case 'chats':
      return { view: 'chats', runId: openRunId };
    case 'teams':
      return { view: 'teams', slug: null };
    case 'tasks':
      return { view: 'tasks', projectId: null };
    case 'projects':
      return { view: 'projects', projectId: shownProjectId };
    case 'knowledge':
      return { view: 'knowledge', documentId: shownDocumentId };
    case 'settings':
      return { view: 'settings' };
    case 'stats':
      return { view: 'stats' };
  }
}

export function App(): React.JSX.Element {
  // Read once, before the first render decides anything: a pasted link must
  // land on its own view/thread from the FIRST paint, which only a lazy
  // `useState` initialiser can do — a `useEffect` runs after that paint.
  const [initialRoute] = useState(() => parseRoute(window.location.hash));
  const [phase, setPhase] = useState<Phase>('loading');
  const [guideOpen, setGuideOpen] = useState(false);
  const [chatLaunch, setChatLaunch] = useState<CliKind | null>(null);
  const [teamLaunch, setTeamLaunch] = useState<TeamLaunch | null>(null);
  // A library team the chat screen asked the builder to open.
  const [teamRequest, setTeamRequest] = useState<string | null>(null);
  const [view, setView] = useState<AppView>(
    () => initialRoute?.view ?? 'chats',
  );
  /**
   * A thread another view asked to have opened, held until `Chats` takes it.
   *
   * The board's cards each carry a run — a task IS a conversation with an
   * agent — and "open the thread this card is being worked in" therefore has
   * to cross two screens. It is App state for the same reason the view is:
   * `Chats` owns which run is active but not which SCREEN is on show, and a
   * jump has to do both. The same split the notification path already uses,
   * except that one is two independent listeners on one main-process event and
   * this one has no event to share, so the run id travels as a prop and is
   * cleared by the callback once opened.
   *
   * A pasted `#/chats/<runId>` link seeds this the same way: it is a request
   * to open that thread, which `Chats` takes exactly as it takes one from
   * `Tasks`.
   */
  const [threadRequest, setThreadRequest] = useState<string | null>(() =>
    initialRoute?.view === 'chats' ? initialRoute.runId : null,
  );
  /**
   * The thread `Chats` reports as OPEN — the outbound twin of the request
   * above, and the only one of the two the address may be built from.
   *
   * Seeded from a deep link so the first paint's address already names the
   * thread being opened; `Chats` overwrites it the moment it has one.
   */
  const [openRunId, setOpenRunId] = useState<string | null>(() =>
    initialRoute?.view === 'chats' ? initialRoute.runId : null,
  );
  /** Inbound and one-shot, like `threadRequest`: open this thread's processes. */
  const [processesRequest, setProcessesRequest] = useState<string | null>(null);
  /** Inbound and one-shot, like `threadRequest`; `shownProjectId` is its outbound twin. */
  const [projectRequest, setProjectRequest] = useState<ProjectsRequest | null>(
    () =>
      initialRoute?.view === 'projects' && initialRoute.projectId !== null
        ? { projectId: initialRoute.projectId }
        : null,
  );
  const [shownProjectId, setShownProjectId] = useState<string | null>(() =>
    initialRoute?.view === 'projects' ? initialRoute.projectId : null,
  );
  const [boardProjectRequest, setBoardProjectRequest] = useState<string | null>(
    null,
  );
  /** Inbound and one-shot; `shownDocumentId` is its outbound twin. */
  const [knowledgeRequest, setKnowledgeRequest] =
    useState<KnowledgeRequest | null>(() =>
      initialRoute?.view === 'knowledge' && initialRoute.documentId !== null
        ? { documentId: initialRoute.documentId }
        : null,
    );
  const [shownDocumentId, setShownDocumentId] = useState<string | null>(() =>
    initialRoute?.view === 'knowledge' ? initialRoute.documentId : null,
  );
  const [knowledgePlace, setKnowledgePlace] = useState<string | null>(null);
  /** Every thread's wait, ranked, as `Chats` reports it. */
  const [waiting, setWaiting] = useState<readonly WaitReading[]>([]);
  // Teams mounts lazily on first visit, then stays mounted (hidden) like
  // Chats — unmounting on nav used to silently discard every unsaved builder
  // edit when the user glanced at Chats/Settings mid-composition.
  const [teamsMounted, setTeamsMounted] = useState(false);
  // Same latch, same reason: the board holds a selected project, a scroll
  // position and a half-finished drag, none of which survive a remount.
  const [tasksMounted, setTasksMounted] = useState(false);
  /**
   * Which pane Settings opens on — HERE rather than inside Settings because
   * another screen can ask for one: Settings is unmounted while hidden, so a
   * section it remembered privately would be forgotten between visits and,
   * worse, could not be set from outside at all.
   */
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('general');
  if (view === 'teams' && !teamsMounted) {
    setTeamsMounted(true);
  }
  if (view === 'tasks' && !tasksMounted) {
    setTasksMounted(true);
  }
  const [connected, setConnected] = useState(false);
  const [handle, setHandle] = useState<DaemonHandle | null>(null);
  /**
   * Why the daemon is not answering, in its own words. Held even while a retry
   * is in flight — clearing it on every attempt would blank the one sentence
   * explaining the failure several times a second, since Socket.IO retries on
   * its own schedule.
   */
  const [connectionError, setConnectionError] = useState<string | null>(null);
  /**
   * Why the daemon could not be STARTED — the supervisor's own reason, while
   * no handle has ever arrived. Kept apart from `connectionError`: a start
   * still in flight is not a failure and the startup screen says so, while a
   * socket that dropped after the daemon answered is the banner's business.
   */
  const [startError, setStartError] = useState<string | null>(null);
  /** When the shell began waiting for a daemon — the startup screen's clock. */
  const [waitingSince, setWaitingSince] = useState(() => Date.now());
  /** The data migration a starting daemon is running, as the supervisor reports it. */
  const [migrating, setMigrating] = useState<DaemonMigration | null>(null);
  const handleRef = useRef<DaemonHandle | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  /**
   * Whether the user has pressed the rail's update control this launch.
   *
   * The only thing that turns a failed install into something the status row
   * reports: a background CHECK that could not reach GitHub is not a fault
   * they asked about. There is no longer a DISMISSED version beside it — the
   * offer lives in the status row now, at the size of the row, so there is
   * nothing to wave away and nothing interrupting a view to be waved away from.
   */
  const [updateEngaged, setUpdateEngaged] = useState(false);
  const sidebar = useSidebarCollapsed();
  const narrowViewport = useNarrowViewport();
  /**
   * Whether the Chats screen is showing a DETAIL page on a phone — an open
   * thread or the new-chat composer, reported up by `Chats` — which decides
   * what the title bar names.
   */
  const [chatsPhoneDetail, setChatsPhoneDetail] = useState(false);
  /**
   * Bumped when the Chats tab is pressed while Chats is on show: the phone's
   * way back to the chat list, since the tab bar is its only navigation.
   */
  const [chatsHomeSignal, setChatsHomeSignal] = useState(0);
  /**
   * Whether Settings shows a SECTION rather than its list of sections, on a
   * phone. Here rather than inside Settings for `settingsSection`'s reason:
   * Settings is unmounted while hidden, and a jump from another screen
   * ("Manage fast actions") must land in the section, not on the list.
   */
  const [settingsSectionOpen, setSettingsSectionOpen] = useState(false);
  const [memoryFocus, setMemoryFocus] = useState<string | null>(null);
  /** Leaves the section for the list — see `usePhoneBackEntry`. */
  const settingsBack = usePhoneBackEntry(
    'settings',
    narrowViewport && view === 'settings' && settingsSectionOpen,
    () => setSettingsSectionOpen(false),
  );
  /**
   * What the open chat is called, reported UP by `Chats`.
   *
   * The title bar spans the window, above the columns, so the name of the thing
   * on screen has to reach it from the view that knows it. Null until a chat is
   * open — the landing view is not a document and says so by name.
   */
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const terminals = useTerminalTabs();
  /** The open thread's folder, reported up by `Chats` — where a new terminal starts. */
  const [chatFolder, setChatFolder] = useState<string | null>(null);
  const update = useUpdateState();
  const clientRef = useRef<DaemonClient | null>(null);
  // One set of clients per launch handle. Built here rather than inside the
  // panel so a toggle does not construct five API objects, and so the UI error
  // reporter below can share them.
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );
  // The app's ONE capabilities read, provided around every view — the whole
  // answer, and the agent identities out of it — so no screen reads it again.
  const capabilities = useCapabilities(apis?.capabilities ?? null);
  const loadAvatarImage = useLatestCallback(
    async (id: string): Promise<string> => {
      if (apis === null) {
        throw new Error('daemon unavailable');
      }
      return (await apis.teams.getTeamAvatar({ id })).dataUri;
    },
    [apis],
  );
  /** Whether the title bar's usage panel is open — the only time it polls. */
  const [usageOpen, setUsageOpen] = useState(false);
  const appProcesses = useAppProcesses(apis, usageOpen);
  const agentIdentities = useAgentIdentities(capabilities.capabilities);

  /**
   * The menu bar's Clear Agent Cache: forget, then RELOAD.
   *
   * The reload is the whole of the renderer's half. `useAgentVocabulary`
   * caches per hook INSTANCE — the composer holds three, the graph inspector
   * three more — so the daemon forgetting is only half a press, and a reload
   * drops every one of them along with the rest of this window's state. It
   * also replaced the confirmation line this first shipped with, on the
   * report: "нам не нужно вот это добавлять… просто должен перезагружать".
   * A reload is its own confirmation, and it costs the composer's unsent text,
   * which is the trade the row is understood to make.
   *
   * ONLY after the daemon has answered, and never on a failure: reloading
   * first would refill the caches from the daemon that has not cleared them
   * yet, and reloading after one would hide the failure behind a window that
   * looks like it worked. A failure goes to the daemon's log instead, which is
   * where every other renderer failure goes.
   */
  const clearAgentCaches = useLatestCallback((): void => {
    if (!apis) {
      // No daemon, so no cache to clear — and the connection banner is already
      // on screen saying so.
      return;
    }
    void apis.agents
      .clearAgentCaches()
      .then(() => window.location.reload())
      .catch((err: unknown) => {
        void apis.diagnostics
          .recordUiLog({
            uiLogDto: {
              level: 'error',
              message: `clearing the agent cache failed: ${err instanceof Error ? err.message : String(err)}`,
              context: { kind: 'clear-agent-cache' },
            },
          })
          .catch(() => undefined);
      });
  }, [apis]);

  useEffect(
    () => window.geniro.onClearAgentCaches(clearAgentCaches),
    [clearAgentCaches],
  );

  // A quit asks every window to post the line measurements it still holds, before the daemon stops
  // (`main/line-measurement-flush.ts`). Answered here, in the always-mounted shell, so a window with
  // nothing to post answers at once rather than waiting out main's bound.
  useEffect(() => window.geniro.onFlushLineMeasurements(answerLineFlush), []);

  const attachDaemon = useLatestCallback((daemonHandle: DaemonHandle): void => {
    // The launch's start answers twice — the `onDaemonRestarted` push and the
    // mount's own `ensureDaemon`, which joins that same start — and a second
    // attach of one handle would only drop a socket that is already opening.
    const held = handleRef.current;
    if (
      held !== null &&
      held.host === daemonHandle.host &&
      held.port === daemonHandle.port &&
      held.token === daemonHandle.token
    ) {
      return;
    }
    handleRef.current = daemonHandle;
    setStartError(null);
    setMigrating(null);
    // Published for the DevTools extension's Geniro panel, which runs in an
    // extension origin with no preload and no module graph of ours — its only
    // channel to this page is `inspectedWindow.eval`, so the host, port and
    // per-launch token have to be reachable from a plain global. Re-published
    // on every attach because a daemon restart rotates the token, and a panel
    // holding the old one would be silently unauthorised.
    //
    // Not a leak: this is a loopback session token the renderer already holds
    // and sends on every request, in a window only this app loads.
    (window as unknown as { __geniroDaemon: DaemonHandle }).__geniroDaemon =
      daemonHandle;
    clientRef.current?.close();
    setConnected(false);
    const client = new DaemonClient(daemonHandle, {
      onOpen: () => {
        setConnected(true);
        // Cleared only on a connection that actually OPENED — the one event
        // that proves the previous reason no longer holds.
        setConnectionError(null);
      },
      onClose: (reason) => {
        setConnected(false);
        setConnectionError(`The connection dropped (${reason}).`);
      },
      onError: (message) => {
        setConnected(false);
        setConnectionError(message);
      },
    });
    clientRef.current = client;
    client.connect();
    setHandle(daemonHandle);
  }, []);

  const connectDaemon = useLatestCallback(async (): Promise<void> => {
    setReconnecting(true);
    try {
      // Always ENSURES, on mount as on a Retry. On mount the launch's own start
      // is usually still in flight, and `ensureDaemon` joins it rather than
      // starting a second — so its answer is the one signal for both endings:
      // the handle once the daemon listens, or the supervisor's reason when it
      // gave up. Reading the handle instead answered "none" mid-boot, which
      // the window used to show as a red "not connected" on every launch.
      attachDaemon(await window.geniro.ensureDaemon());
    } catch (err) {
      setConnected(false);
      const reason =
        err instanceof Error
          ? err.message
          : 'Could not reach the local engine.';
      if (handleRef.current === null) {
        setStartError(reason);
      } else {
        setConnectionError(reason);
      }
    } finally {
      setReconnecting(false);
    }
  }, [attachDaemon]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribeRestart = window.geniro.onDaemonRestarted(attachDaemon);
    const unsubscribeMigrating = window.geniro.onDaemonMigrating(setMigrating);
    void window.geniro.getStatus().then((status) => {
      if (cancelled) {
        return;
      }
      setMigrating(status.daemon.migrating);
      if (status.onboardingComplete) {
        setPhase('ready');
      } else {
        setPhase('onboarding');
      }
      void connectDaemon();
    });
    return () => {
      cancelled = true;
      unsubscribeRestart();
      unsubscribeMigrating();
      clientRef.current?.close();
    };
  }, [attachDaemon, connectDaemon]);

  const handleOnboardingDone = useLatestCallback(
    (destination?: FirstLaunch): void => {
      setGuideOpen(false);
      setPhase('ready');
      if (destination?.route === 'team' && destination.agent) {
        setTeamLaunch({ ...destination, agent: destination.agent });
        setView('teams');
      } else if (destination?.route === 'chat' && destination.agent) {
        setThreadRequest(null);
        setChatLaunch(destination.agent);
        setView('chats');
      }
      if (!handle) {
        void connectDaemon();
      }
    },
    [connectDaemon, handle],
  );

  // This window's uncaught errors go to the daemon's log, so they outlive the
  // console and sit in order beside what the daemon was doing.
  useEffect(() => {
    if (!apis) {
      return;
    }
    return reportUiErrors(apis);
  }, [apis]);

  // A clicked notification is always about a CHAT, so it brings the chat view
  // with it — main has already raised the window, and landing the user on
  // Settings with a raised window would be a banner that went nowhere. Which
  // thread it opens is `Chats`' own listener on the same channel; it is split
  // that way because the view is app state and the active run is not.
  useEffect(
    () => window.geniro.onNotificationActivated(() => setView('chats')),
    [],
  );

  // ⌥⌘L opens the debug drawer, and since the title bar's trigger was removed
  // it is the only thing that does — which is the point rather than a gap: the
  // panel is a developer's answer to "what just happened", and it had been
  // occupying a slot in the one band every user sees. Settings' Diagnostics
  // section names the chord, so it is documented where somebody looking for it
  // would go.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // `event.code`, not `event.key`: with Alt held, macOS rewrites the key
      // for an `l` to `¬`, so matching on the character never fires.
      if (event.altKey && event.metaKey && event.code === 'KeyL') {
        event.preventDefault();
        setDebugOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { toggle: toggleTerminal } = terminals;
  useTerminalShortcut(
    useLatestCallback(
      () => toggleTerminal(view === 'chats' ? chatFolder : null),
      [toggleTerminal, chatFolder, view],
    ),
  );

  /** The reading the last jump went to — where the cycle continues from. */
  const lastJumpRef = useRef<WaitReading | null>(null);
  const jumpToNextWaiting = useLatestCallback(() => {
    // The cycle continues only from the thread on show: from the board, or
    // after the user wandered to another thread, it starts at the longest wait.
    const onShow = view === 'chats' ? openRunId : null;
    const cursor =
      waiting.find(
        (reading) => reading.runId === onShow && waitsOnUser(reading.state),
      ) ?? (lastJumpRef.current?.runId === onShow ? lastJumpRef.current : null);
    const next = nextWaiting(waiting, cursor);
    // Re-opening the thread on show would reload its transcript and lose the
    // place the user scrolled to, for nothing.
    if (next === null || next.runId === onShow) {
      return;
    }
    lastJumpRef.current = next;
    setThreadRequest(next.runId);
    setView('chats');
  }, [waiting, view, openRunId]);
  useNextWaitingShortcut(jumpToNextWaiting);
  // A thread opened any other way ends the cycle: coming back to the last
  // jump's thread by hand later starts again at the longest wait.
  useEffect(() => {
    if (openRunId !== lastJumpRef.current?.runId) {
      lastJumpRef.current = null;
    }
  }, [openRunId]);
  const knowledgeCounts = useKnowledgeCounts(apis, clientRef.current);
  const memoryWaiting = useMemoryWaitingCount(apis, clientRef.current);
  const cliUpdatesAvailable = useCliUpdatesAvailable();
  const agentName = useLatestCallback(
    (kind: string): string => agentShortName(agentIdentities, kind),
    [agentIdentities],
  );
  const resourceAlerts = useResourceAlerts({
    apis,
    client: clientRef.current,
    agentName,
  });
  const navCounts = useMemo(
    () => ({
      chats: owedCount(waiting),
      knowledge: knowledgeCounts?.waiting ?? 0,
      settings: (memoryWaiting ?? 0) + cliUpdatesAvailable,
    }),
    [waiting, knowledgeCounts, memoryWaiting, cliUpdatesAvailable],
  );
  const waitingByRun = useMemo(
    () => new Map(waiting.map((reading) => [reading.runId, reading.state])),
    [waiting],
  );

  /**
   * Keep the address bar naming the open view/thread. `history.replaceState`
   * rather than `location.hash =` or `pushState`: assigning the hash raises a
   * `hashchange` this same state would then read back as an incoming
   * navigation — a feedback loop — and `pushState` would put every thread a
   * click merely passed through onto the back stack.
   */
  const lastWrittenHashRef = useRef<string | null>(null);
  useEffect(() => {
    const hash = formatRoute(
      currentRoute(view, openRunId, shownProjectId, shownDocumentId),
    );
    if (hash !== window.location.hash) {
      // `history.state` is kept: it carries the phone back-entry marks
      // (`components/use-phone-back-entry.ts`).
      history.replaceState(history.state, '', hash);
    }
    lastWrittenHashRef.current = hash;
  }, [view, openRunId, shownProjectId, shownDocumentId]);

  // A link pasted into this SAME already-open tab fires `hashchange` rather
  // than a reload, so this is what makes that act like a navigation. Guarded
  // against the write above by comparing against the hash THIS component
  // last wrote: `replaceState` does not itself raise `hashchange`, but the
  // comparison keeps this listener inert even if that ever stopped holding.
  useEffect(() => {
    const onHashChange = (): void => {
      const hash = window.location.hash;
      if (hash === lastWrittenHashRef.current) {
        return;
      }
      const route = parseRoute(hash);
      if (!route) {
        // Unrecognised — leave the app on whatever view it is already on
        // rather than blanking it.
        return;
      }
      setView(route.view);
      if (route.view === 'chats') {
        setThreadRequest(route.runId);
      }
      if (route.view === 'projects') {
        setProjectRequest({ projectId: route.projectId });
      }
      if (route.view === 'knowledge' && route.documentId !== null) {
        setKnowledgeRequest({ documentId: route.documentId });
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Both of these render before the shell exists, so neither has a top row of
  // its own to drag the window by — see `WindowDragStrip`.
  if (phase === 'loading') {
    // The same screen the shell shows while the daemon starts, so the first
    // paint does not swap one waiting message for another a moment later.
    return (
      <>
        <WindowDragStrip />
        <StartupScreen since={waitingSince} migrating={migrating} />
      </>
    );
  }

  // Until the first daemon answers, the views have nothing to draw — every one
  // of them is daemon calls. Settings is the exception, because a start that
  // failed may be fixed there (an agent's binary path, the inspector switch).
  const showStartup = handle === null && view !== 'settings';

  if (phase === 'onboarding') {
    return (
      <>
        <WindowDragStrip />
        <CapabilitiesContext.Provider value={capabilities}>
          <Onboarding
            onDone={handleOnboardingDone}
            identities={agentIdentities}
          />
        </CapabilitiesContext.Provider>
      </>
    );
  }

  return (
    <CapabilitiesContext.Provider value={capabilities}>
      <AgentIdentityContext.Provider value={agentIdentities}>
        <AvatarImageLoaderContext.Provider value={loadAvatarImage}>
          <div className="flex h-full flex-col">
            {/* ONE band across the window, above the columns — see `title-bar.tsx`
          for why it is not three rows in three columns any more. */}
            <TitleBar
              title={
                // No chat exists to name until the daemon answers.
                view !== 'chats' || showStartup
                  ? VIEW_TITLE[view]
                  : narrowViewport && !chatsPhoneDetail
                    ? // The phone's chat LIST page names the place, like
                      // every other tab, rather than a chat nobody opened.
                      VIEW_TITLE.chats
                    : (chatTitle ?? 'New chat')
              }
              // The offer, resolved HERE from main's one state so the bar renders it
              // rather than deciding it — including `canInstall`, main's own answer
              // about this install (read-only volume, another account, a translocated
              // copy), so the control only appears where pressing it can work.
              //
              // NOTHING in a browser reached through the LAN gateway: install and
              // relaunch are both `denyRemotely` (they swap and restart the app on
              // the MAC), so a phone could only ever press a dead control — and on a
              // phone the bar's trailing edge belongs to the run-details opener,
              // which the version was drawn straight over.
              update={
                isRemoteRuntime()
                  ? { kind: 'none' }
                  : footerUpdate(update.state, updateEngaged)
              }
              onInstallUpdate={() => {
                setUpdateEngaged(true);
                void update.install();
              }}
              onRelaunchUpdate={() => void update.relaunch()}
              // Not on a phone, for the usage control's reason below — and a
              // phone has no keyboard for the chord the line names.
              waiting={
                narrowViewport || showStartup ? null : (
                  <WaitingStatus
                    readings={waiting}
                    onJump={jumpToNextWaiting}
                  />
                )
              }
              // Not on a phone, for the update control's reason: the bar's
              // trailing edge there belongs to the run-details opener, which
              // floats over it and would cover this glyph.
              usage={
                apis && !narrowViewport ? (
                  <AppUsageButton
                    open={usageOpen}
                    onOpenChange={setUsageOpen}
                    data={appProcesses.data}
                    loading={appProcesses.loading}
                    error={appProcesses.error}
                    // Both writes, in this order, on `Tasks`' reason: the
                    // request is what `Chats` acts on.
                    onOpenThread={(runId) => {
                      setThreadRequest(runId);
                      setView('chats');
                    }}
                  />
                ) : null
              }
            />
            <div className="flex min-h-0 flex-1">
              {/* The rail is the navigation at `sm` and wider; below it the
            bottom tab bar is. `flex` because NavRail carries no `h-full` of
            its own and stretches only as a flex row's child. */}
              <div className="flex max-sm:hidden">
                <NavRail
                  view={view}
                  onNavigate={setView}
                  collapsed={sidebar.collapsed}
                  hydrated={sidebar.hydrated}
                  onToggleCollapsed={sidebar.toggle}
                  counts={navCounts}
                />
              </div>
              {/* min-w-0 + overflow-hidden: a flex child's min-width defaults to its
          content, so one long unbreakable string (a cwd path) would otherwise
          push the whole layout wider than the window and the transcript
          auto-scroll would then drag the document sideways, clipping the rail. */}
              <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {/* Above every view, because every view is made of daemon calls: a
            failure here explains an empty chat list, a Send that does nothing
            and a builder that cannot save, all at once. Outside the per-view
            wrappers so it survives a nav switch — the connection is app state,
            not any one screen's. */}
                {/* Not while the daemon is still starting: that is the startup
            screen's to say, and a start is not a failure. On Settings, with no
            daemon yet, it appears once the start has actually failed. */}
                {connected ||
                showStartup ||
                (handle === null && startError === null) ? null : (
                  <ConnectionBanner
                    reason={connectionError ?? startError}
                    retrying={reconnecting}
                    onRetry={() => void connectDaemon()}
                  />
                )}
                {showStartup ? null : (
                  <ResourceAlertStrip
                    alerts={resourceAlerts.alerts}
                    agentName={agentName}
                    stoppingId={resourceAlerts.stoppingId}
                    error={resourceAlerts.error}
                    onOpenProcesses={(runId) => {
                      setThreadRequest(runId);
                      setProcessesRequest(runId);
                      setView('chats');
                    }}
                    onStop={(alertId) => void resourceAlerts.stop(alertId)}
                    onDismiss={resourceAlerts.dismiss}
                  />
                )}
                {showStartup ? (
                  <StartupScreen
                    since={waitingSince}
                    reason={startError}
                    migrating={migrating}
                    onRetry={() => {
                      // Back to the starting view, clock and all: this is a
                      // fresh start, and its failure brings the reason back.
                      setStartError(null);
                      setWaitingSince(Date.now());
                      void connectDaemon();
                    }}
                  />
                ) : null}
                {/* No update strip here. It and the nav rail's version row were two
            controls for one action in one window; the row is where the running
            version is already written, so that is the one that stayed. The
            connection banner above is NOT the same case and keeps its strip: a
            daemon that is not answering breaks the view under it, while an
            update is an offer with no deadline. */}
                {/* Chats stays mounted (hidden) across nav switches so its live WS room
            and active-run selection survive a trip to Settings/Teams. */}
                <div
                  className={cn(
                    'min-h-0 flex-1',
                    (view !== 'chats' || showStartup) && 'hidden',
                  )}>
                  {handle && clientRef.current ? (
                    <Chats
                      client={clientRef.current}
                      handle={handle}
                      active={view === 'chats'}
                      transcriptPageCap={
                        isRemoteRuntime() ? REMOTE_HISTORY_PAGE : undefined
                      }
                      firstLaunchAgent={chatLaunch}
                      onFirstLaunchHandled={() => setChatLaunch(null)}
                      onActiveRunChange={setOpenRunId}
                      onTitleChange={setChatTitle}
                      onOpenTerminal={terminals.openTab}
                      onFolderChange={setChatFolder}
                      // Chats has no route of its own to Settings — the nav rail is
                      // this component's. Handing it one callback is what lets the
                      // composer's "Manage fast actions" land ON the editor rather
                      // than on General with a hunt for it.
                      onOpenSettings={(section) => {
                        setSettingsSection(section);
                        setSettingsSectionOpen(true);
                        setView('settings');
                      }}
                      onOpenKnowledge={(target) => {
                        setKnowledgeRequest(target);
                        setView('knowledge');
                      }}
                      onOpenMemory={(memoryHandle) => {
                        setMemoryFocus(memoryHandle);
                        setSettingsSection('memory');
                        setSettingsSectionOpen(true);
                        setView('settings');
                      }}
                      onOpenTeam={(slug) => {
                        setTeamRequest(slug);
                        setView('teams');
                      }}
                      onOpenProject={(projectId) => {
                        setProjectRequest({ projectId });
                        setView('projects');
                      }}
                      onPhoneDetailChange={setChatsPhoneDetail}
                      onWaitingChange={setWaiting}
                      phoneHomeSignal={chatsHomeSignal}
                      openRunId={threadRequest}
                      onRunOpened={() => {
                        setThreadRequest(null);
                      }}
                      processesRequest={processesRequest}
                      onProcessesOpened={() => {
                        setProcessesRequest(null);
                      }}
                    />
                  ) : null}
                </div>
                <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
                  {/* `min-h-0 flex-1`, not `h-full`: `main` is now a flex COLUMN whose
              first child can be the connection strip, so a child claiming the
              full height would push the views past the bottom of the window
              by exactly the strip's height. */}
                  <div
                    className={cn(
                      'min-h-0 flex-1',
                      (view !== 'teams' || showStartup) && 'hidden',
                    )}>
                    {teamsMounted ? (
                      <Teams
                        handle={handle}
                        client={clientRef.current}
                        active={view === 'teams'}
                        firstLaunch={teamLaunch}
                        onFirstLaunchHandled={() => setTeamLaunch(null)}
                        openRequest={teamRequest}
                        onOpenRequestHandled={() => setTeamRequest(null)}
                        onOpenSettings={(section) => {
                          setSettingsSection(section);
                          setSettingsSectionOpen(true);
                          setView('settings');
                        }}
                        onOpenProject={(projectId) => {
                          setProjectRequest({ projectId });
                          setView('projects');
                        }}
                      />
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      'min-h-0 flex-1',
                      (view !== 'tasks' || showStartup) && 'hidden',
                    )}>
                    {tasksMounted ? (
                      <Tasks
                        handle={handle}
                        client={clientRef.current}
                        active={view === 'tasks'}
                        waitingByRun={waitingByRun}
                        // Both writes, in this order: the request is what `Chats`
                        // acts on, and switching first would show the previous
                        // thread for a frame.
                        onOpenThread={(runId) => {
                          setThreadRequest(runId);
                          setView('chats');
                        }}
                        projectRequest={boardProjectRequest}
                        onProjectRequestHandled={() =>
                          setBoardProjectRequest(null)
                        }
                        onOpenProjectPage={(projectId) => {
                          setProjectRequest({ projectId });
                          setView('projects');
                        }}
                      />
                    ) : null}
                  </div>
                  {view === 'projects' && !showStartup ? (
                    <div className="min-h-0 flex-1">
                      <Projects
                        handle={handle}
                        client={clientRef.current}
                        request={projectRequest}
                        onRequestHandled={() => setProjectRequest(null)}
                        onProjectShown={setShownProjectId}
                        onOpenBoard={(projectId) => {
                          setBoardProjectRequest(projectId);
                          setView('tasks');
                        }}
                        onOpenTeam={(slug) => {
                          setTeamRequest(slug);
                          setView('teams');
                        }}
                        onOpenKnowledge={(projectId) => {
                          setKnowledgeRequest({
                            place: projectPlace(projectId),
                          });
                          setView('knowledge');
                        }}
                      />
                    </div>
                  ) : null}
                  {view === 'knowledge' && !showStartup ? (
                    <div className="min-h-0 flex-1">
                      <Knowledge
                        handle={handle}
                        client={clientRef.current}
                        place={knowledgePlace}
                        onPlaceChange={setKnowledgePlace}
                        request={knowledgeRequest}
                        onRequestHandled={() => setKnowledgeRequest(null)}
                        onDocumentShown={setShownDocumentId}
                      />
                    </div>
                  ) : null}
                  {/* Unmounted when hidden, like Settings and unlike Chats/Teams:
              the page holds no unsaved edit and no live subscription, and a
              fresh mount is how a revisit gets figures that are current
              rather than however stale the last visit left them. */}
                  {view === 'stats' && !showStartup ? (
                    <div className="min-h-0 flex-1">
                      <Stats handle={handle} client={clientRef.current} />
                    </div>
                  ) : null}
                  {view === 'settings' ? (
                    <div className="min-h-0 flex-1">
                      <Settings
                        handle={handle}
                        client={clientRef.current}
                        memoryFocus={
                          settingsSection === 'memory' ? memoryFocus : null
                        }
                        onMemoryFocusDone={() => setMemoryFocus(null)}
                        memoryWaiting={memoryWaiting}
                        onOpenOnboarding={
                          isRemoteRuntime()
                            ? undefined
                            : () => setGuideOpen(true)
                        }
                        section={settingsSection}
                        onSectionChange={setSettingsSection}
                        sectionOpen={settingsSectionOpen}
                        onSectionOpenChange={(open) => {
                          if (open) {
                            setSettingsSectionOpen(true);
                          } else {
                            settingsBack();
                          }
                        }}
                      />
                    </div>
                  ) : null}
                </Suspense>
                {/* Above the debug drawer and, like it, below every view. */}
                <TerminalPanel
                  terminals={terminals}
                  onNewTab={() =>
                    terminals.openTab(
                      newTerminalFolder(
                        view === 'chats' ? chatFolder : null,
                        terminals,
                      ),
                    )
                  }
                />
                {/* BELOW the views and inside `main`, so it spans whatever screen is
            open rather than belonging to one — the question it answers ("what
            just happened when I did that") is always about the thing still on
            screen above it. Mounted only while open: mounting it hidden would
            keep the daemon streaming every agent-stdio line to a panel nobody
            is looking at. */}
                {debugOpen && apis && clientRef.current ? (
                  <DebugPanel
                    apis={apis}
                    client={clientRef.current}
                    onClose={() => setDebugOpen(false)}
                  />
                ) : null}
              </main>
            </div>
            {/* On every phone page: it is the phone's only navigation. */}
            <BottomTabBar
              view={view}
              counts={navCounts}
              onNavigate={(next) => {
                // Pressing the tab already on show goes back to its first
                // page, the way a phone's tab bar does.
                if (next === view && next === 'settings') {
                  settingsBack();
                }
                if (next === view && next === 'chats') {
                  setChatsHomeSignal((value) => value + 1);
                }
                setView(next);
              }}
            />
          </div>
          {guideOpen ? (
            <div className="fixed inset-0 z-50 bg-background">
              <WindowDragStrip />
              <Onboarding
                identities={agentIdentities}
                onDone={handleOnboardingDone}
                onClose={() => setGuideOpen(false)}
              />
            </div>
          ) : null}
        </AvatarImageLoaderContext.Provider>
      </AgentIdentityContext.Provider>
    </CapabilitiesContext.Provider>
  );
}
