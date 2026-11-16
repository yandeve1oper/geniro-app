import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import type { Run } from '../../runs/entity/run.entity';
import { AgentKind, AgentKindSchema } from '../../runs/runs.types';
import {
  type AgentSession,
  NO_PLAN_LIMITS,
  type UsageReadChannel,
} from '../adapters/adapter.types';
import type {
  ChatMetricsWire,
  ChatTotalsWire,
  ContextBreakdownWire,
  PlanLimitsWire,
} from '../chat.types';
import type { ChatTotalsResponse, StoredMetricsReading } from '../chat.types';
import { SINGLE_AGENT_NODE, StoredMetricsReadingSchema } from '../chat.types';
import { CallContextDao } from '../dao/call-context.dao';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import {
  activeSpansFrom,
  pausedSpansFrom,
  SPAN_ROW_KINDS,
} from '../utils/active-spans';
import {
  CALL_RECORDS,
  callConversation,
  readCallSeed,
  sessionMember,
} from '../utils/call-seed';
import { parseJsonColumn } from '../utils/json-util';
import { readNodePoolMembers } from '../utils/node-pool-members';
import {
  accountKeyOf,
  effectiveAccountDir,
  PlanLimitsLedger,
  type PlanReading,
} from '../utils/plan-limits-ledger';
import {
  addPolledSpendToTotals,
  applyPolledSpend,
  nodePolledSpend,
  type PolledSpend,
  withNodePolledSpend,
} from '../utils/polled-spend';
import {
  conversationsBill,
  readPolledSpendLedger,
} from '../utils/polled-spend-ledger';
import {
  callSessionKey,
  nodeSessionKey,
  parseSessionKey,
} from '../utils/session-keys';
import {
  snapshotMemberProfile,
  snapshotNodeConfigDirs,
  snapshotNodePoolProfiles,
  snapshotPoolKinds,
} from '../utils/snapshot-config-dirs';
import {
  sumUsagePayloads,
  turnAgentKindOf,
  USAGE_ITEM_KINDS,
} from '../utils/usage-figures';
import { servedWorkedMs } from '../utils/wall-worked';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ConfigDirPinService } from './config-dir-pin.service';
import { PolledSpendService } from './polled-spend.service';
import { RunKindRowsCache } from './run-kind-rows.cache';

/**
 * What a chat's context window holds, and what the thread has cost.
 *
 * The composer already showed a ring and a percentage; this is the readout
 * behind it — the same figures that CLI's own `/context` prints, plus the
 * thread's running spend. It exists because "9% full" answers how much room is
 * left and nothing about what filled it, and the two things a user acts on
 * (a 46k-token CLAUDE.md, one MCP server holding 109k of tools) are invisible
 * until the window is broken down.
 *
 * **Composed, never asked directly.** The breakdown is an ADAPTER fact reached
 * through the live session (`AgentSession.readContextUsage`), and the reason
 * there is none is that adapter's own sentence — nothing here knows which CLI
 * it is talking to, or how one accounts for its window.
 */
/**
 * WHOSE readout is being taken — a chat's one agent, or one member of a team
 * run — with everything that differs between the two resolved once.
 *
 * One shape rather than a second copy of the read path: a team member's
 * readout first shipped as its own method that asked only the live process,
 * and so it lost the stored reading, the prewarm and the farewell a chat's
 * readout had, and showed nothing about a claude Manager that had gone idle.
 */
interface ReadingTarget {
  runId: string;
  /** The team member, or null for a chat's own agent. */
  memberId: string | null;
  /**
   * Every call of the agent-to-agent CONVERSATION being read, or null for a
   * chat's agent or a member's own turns. A call's process serves the whole
   * conversation, so its spend is every one of those calls' turns.
   */
  callIds: readonly string[] | null;
  /**
   * The CLI session id when the target already knows it — a call's, which its
   * result row recorded rather than `node_state` (that row holds the member's
   * OWN conversation). Absent reads it off `node_state`.
   */
  sessionId?: string | null;
  /** The `node_state` row the session id is recorded on. */
  stateNodeId: string;
  /** The key the agent's kept process is registered under. */
  sessionKey: string;
  agentKind: AgentKind | null;
  /** The profile a stored reading must still describe (null for a member). */
  configDir: string | null;
  /**
   * The ACCOUNT this agent runs under — what its plan limits are shared
   * across. Unlike {@link configDir} it is resolved for a member too, off the
   * run's own team copy, since a member names its own profile.
   */
  account: AgentAccount | null;
  /** The last reading filed for this agent, verbatim JSON. */
  storedReading: string | null;
  /** This agent's newest transcript row — what a stored reading is pinned to. */
  atSeq: number;
  /** The bill polled for THIS agent's account, which its turns do not carry. */
  polled: PolledSpend;
}

/** One CLI account: its ledger key and the config directory it runs from. */
interface AgentAccount {
  /** {@link accountKeyOf} of {@link dir}. */
  key: string;
  /** The effective config directory, null for the CLI's default login. */
  dir: string | null;
}

@Injectable()
export class ChatMetricsService implements OnModuleInit {
  private readonly logger = new Logger(ChatMetricsService.name);

  /**
   * Runs whose context readout has been opened at least once this launch — the
   * ones worth keeping a fresh reading for.
   *
   * In memory rather than on the run row, and that is the honest lifetime: it
   * is a guess about what this user is watching RIGHT NOW, not a fact about the
   * conversation. A restart forgets it and the first open pays the ask again,
   * which is exactly what the first open of a new chat does anyway.
   */
  private readonly watched = new Set<string>();

  /**
   * Every account's best plan reading, whichever of its chats took it — what
   * keeps two threads on one account from showing two different allowances.
   */
  private readonly planLedger = new PlanLimitsLedger();

  /**
   * The one-shot plan reading in flight for each account, shared by every
   * refresh that arrives while it runs, so presses never start a process each.
   */
  private readonly planProbes = new Map<
    string,
    Promise<PlanLimitsWire | typeof NO_PLAN_LIMITS | null>
  >();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly sessions: AgentSessionRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly bus: AgentEventBus,
    private readonly polledSpend: PolledSpendService,
    private readonly configDirPins: ConfigDirPinService,
    private readonly wallTurns: WallTurnDao,
    private readonly kindRows: RunKindRowsCache,
    private readonly callContextDao: CallContextDao,
  ) {}

  /**
   * Ask this run's agent both questions one last time, on its way out.
   *
   * Registered rather than called: the registry owns the processes and is the
   * only party that knows a session is about to be closed for want of use —
   * see `AgentSessionRegistry.onIdleFarewell` for why that close and no other.
   */
  onModuleInit(): void {
    this.sessions.onIdleFarewell((runId) => this.capture(runId));
    // PREWARM, and only for chats whose readout this user actually opens.
    //
    // REPORTED as "'reading agent context' is too slow when i hover on current
    // context circly. Why it working without delays for claude/cursor in their
    // UI?" — and the answer to the question is the shape of the fix. Those UIs
    // are the CLI: the accounting is already in the process's own memory, so
    // `/context` is a render. geniro is a different process and has to ASK,
    // measured at 1.84–2.18s against a warm claude on this machine. The only
    // way to be instant is to have asked already.
    //
    // A turn's end is when to ask: the process is idle, and the answer is
    // exactly what the next open wants. It is gated on {@link watched} rather
    // than run for every chat because the ask is a real control write on the
    // user's own agent — a tax on every turn of every conversation, for a
    // readout most of them never open.
    this.bus.all().subscribe((event) => {
      // A team member's turn belongs to that member's own readout; a chat's
      // rows carry no member.
      const memberId = event.item.memberId ?? null;
      const key =
        memberId === null ? event.runId : nodeSessionKey(event.runId, memberId);
      if (event.item.kind !== 'turn_complete' || !this.watched.has(key)) {
        return;
      }
      // Owned here: this is an RxJS subscriber, so a rejection escaping it
      // reaches the process-level crash guard — and a missed prewarm is a
      // slower hover, not something worth taking the turn plumbing down for.
      void this.capture(key);
    });
  }

  /**
   * One reading of a chat's metrics.
   *
   * The two halves are gathered together and answered together on purpose: a
   * panel that fetched the breakdown and the spend separately could show a
   * window from one moment beside a cost from another, which is the kind of
   * disagreement between two numbers on one surface that reads as a bug.
   */
  async read(
    runId: string,
    memberId: string | null = null,
    callId: string | null = null,
    /**
     * The readout's own refresh: ask the live agent even where a stored
     * reading would otherwise be served. A user pressing it has decided the
     * figures on screen are not good enough, so serving them back would make
     * the press do nothing.
     */
    refresh = false,
  ): Promise<ChatMetricsWire> {
    if (memberId !== null && callId !== null) {
      throw new BadRequestException(
        'METRICS_TARGET_AMBIGUOUS',
        'name a team member or a call, not both',
      );
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    // A team run names the NODE: it holds one process and one window per
    // member, so the run alone names no agent. REPORTED as "i cant see full
    // context info for team". A CALL goes one level further down, since a
    // callee holds a process per conversation beside its member's own.
    if (callId !== null) {
      const target = await this.callTarget(run, runId, callId, em);
      if (target === null) {
        throw new NotFoundException(
          'CALL_NOT_FOUND',
          `call ${callId} has no agent to read in run ${runId}`,
        );
      }
      return this.readTarget(target, em, refresh);
    }
    const target =
      memberId === null
        ? await this.chatTarget(run, runId, em)
        : await this.nodeTarget(run, runId, memberId, em);
    if (target === null) {
      throw new NotFoundException(
        'NODE_NOT_FOUND',
        `member ${memberId} has not run in run ${runId}`,
      );
    }
    return this.readTarget(target, em, refresh);
  }

  /** One reading of a resolved target — the shared body of every kind of read. */
  private async readTarget(
    target: ReadingTarget,
    em: EntityManager,
    refresh: boolean,
  ): Promise<ChatMetricsWire> {
    // From here on this agent is worth keeping a reading warm for.
    this.watched.add(target.sessionKey);
    // A stored reading whose `atSeq` still matches the transcript describes THIS
    // conversation as it stands — nothing has been said since it was taken — so
    // asking again would spend 1.84–2.18s (measured, warm claude) to be told the
    // same thing. That wait is the whole of the report: "'reading agent context'
    // is too slow when i hover on current context circly".
    //
    // Asked BEFORE the agent rather than after, which is the change: this
    // reading was already stored and already validated against the transcript,
    // and it was consulted only where the live answer came back empty — so
    // every open paid the full question, including the second open a minute
    // after the first with not a word said in between.
    //
    // `atSeq` is what makes it safe, and it is strict: one new row of any kind
    // and the stored reading stops being served, so a figure can never outlive
    // the conversation it measured. The freshest thing this can serve is
    // therefore either current or a live ask.
    // Read ONCE, ahead of everything: the same position decides whether the
    // stored reading still describes this conversation AND stamps a fresh one
    // taken below. Read after the ask instead, a turn landing mid-question
    // would file figures under a transcript they do not describe.
    const current = this.parseStoredReading(
      target.storedReading,
      target.atSeq,
      target.configDir,
    );
    // Two conditions, and each rules out a different wrong answer.
    //
    // The BREAKDOWN must be present — not both halves. A stored reading is only
    // ever written with at least one figure in it, and a null `plan` beside a
    // real `context` is the ordinary state of every CLI that reports no
    // allowance, so requiring both would mean this path never ran for them and
    // the wait came back for exactly the users it was meant to help.
    //
    // And there must be a LIVE agent. This is a shortcut past a question whose
    // answer is already known, so it belongs only where that question would
    // otherwise be asked and be slow. With no process the reading is not a
    // shortcut but the last thing anyone measured, which is a different fact
    // and one the panel says out loud ("closed … send a message to take a fresh
    // reading") off `takenAt` — so that case falls through to the path below,
    // which stamps it. Cursor never takes this path either, and does not need
    // to: it answers off its own session store on disk, in milliseconds.
    //
    // A REFRESH never takes the shortcut: it is asked for precisely when the
    // user does not trust what is already on screen.
    const usable =
      !refresh &&
      current !== null &&
      current.context !== null &&
      planReadingIsCurrent(current, Date.now()) &&
      this.sessions.peek(target.sessionKey) !== null
        ? current
        : null;
    const [agent, payloads] = await Promise.all([
      usable === null
        ? this.readFromAgent(target, em, refresh)
        : Promise.resolve({
            context: usable.context,
            plan: usable.plan,
            // ASKED, because this reading is the answer to an ask — one made
            // when the conversation was in exactly the state it is in now.
            // These two flags decide only WHICH sentence an absent half gets,
            // and "the agent did not answer" is the true one: it did not,
            // when it was asked. Saying "no live process" instead would send
            // the user to send a message, which would change nothing about a
            // figure the CLI does not report.
            askedContext: true,
            askedPlan: true,
            planNotReported: false,
          }),
      this.turnPayloads(target),
    ]);
    // A live answer is FILED, which is the other half of making the next open
    // instant — without it the very first open of a chat pays two seconds, and
    // so does every open after it, since nothing was written down. Not awaited:
    // the user is waiting on this reply and the write is for the next reader.
    if (usable === null && (agent.context !== null || agent.plan !== null)) {
      void this.store(
        target,
        agent.context ?? current?.context ?? null,
        agent.plan,
      );
    }
    // The stored last reading is consulted ONLY where the live one is missing
    // and could not have been taken — a CLI that answers is always preferred,
    // and a reading nobody could take is what this exists for.
    const stored =
      agent.context === null || agent.plan === null ? current : null;
    const context = agent.context ?? stored?.context ?? null;
    const planReading = this.settlePlan(target, {
      ...agent,
      // The shortcut's answer is as old as the reading it reused, not now.
      takenAt: usable === null ? Date.now() : epochOf(usable.takenAt),
      stored: stored?.plan
        ? { plan: stored.plan, takenAt: epochOf(stored.takenAt) }
        : null,
      refresh,
    });
    const plan = planReading?.plan ?? null;
    return {
      context,
      breakdownReason:
        context === null
          ? this.absenceReason(
              target.agentKind,
              agent.askedContext,
              'breakdown',
              CONTEXT_ABSENCE,
            )
          : null,
      plan,
      planReason:
        plan === null
          ? agent.planNotReported
            ? PLAN_NOT_REPORTED
            : this.absenceReason(
                target.agentKind,
                agent.askedPlan,
                'planLimits',
                PLAN_ABSENCE,
              )
          : null,
      // Only where the breakdown actually CAME from the stored reading: a live
      // answer is now, and stamping it with the moment an older one was taken
      // would date the very reading that is current.
      takenAt:
        agent.context === null && context !== null
          ? (stored?.takenAt ?? null)
          : null,
      // Always stated for the plan: it may be another chat's reading, and an
      // allowance is a countdown, so its age is part of the figure.
      planTakenAt:
        planReading === null
          ? null
          : new Date(planReading.takenAt).toISOString(),
      // The rule every figure obeys — null until SOME turn reported it, so a
      // chat on a CLI that reports no usage reads as "not measured" and never
      // as "cost nothing" — lives once in `utils/usage-figures`, which the
      // Stats page's cross-run aggregation folds with too. Two copies of that
      // rule is how the panel and the page come to disagree about the same
      // turns.
      totals: withNodePolledSpend(
        sumUsagePayloads(payloads),
        sumUsagePayloads(
          payloads.filter(
            (payload) =>
              !this.polledSpend.pollsSpend(
                turnAgentKindOf(parseJsonColumn(payload)) ?? target.agentKind,
              ),
          ),
        ),
        target.polled,
      ),
    };
  }

  /**
   * A chat's own agent as a reading target.
   *
   * The position is read HERE, ahead of any question: the same position
   * decides whether a stored reading still describes this conversation AND
   * stamps a fresh one, and read after the ask a turn landing mid-question
   * would file figures under a transcript they do not describe.
   */
  private async chatTarget(
    run: Run,
    runId: string,
    em: EntityManager,
  ): Promise<ReadingTarget> {
    return {
      runId,
      memberId: null,
      callIds: null,
      stateNodeId: SINGLE_AGENT_NODE,
      sessionKey: runId,
      agentKind: run.agentKind,
      configDir: run.configDir,
      account: this.account(run, run.agentKind, run.configDir),
      storedReading: run.lastMetricsReading,
      atSeq: await this.itemDao.maxSeq(runId, em),
      polled: run,
    };
  }

  /**
   * One TEAM member as a reading target, or null for a member that has never
   * run in this run.
   *
   * Pinned to the member's OWN newest row rather than the run's: the run's moves
   * with every other member's work, so a Manager's reading would stop being
   * served the moment its Engineer wrote a line — which is exactly while the
   * Manager sits idle and someone looks at it. The profile is not part of a
   * member's key: a member's config directory is fixed by the run's team copy.
   */
  private async nodeTarget(
    run: Run,
    runId: string,
    memberId: string,
    em: EntityManager,
  ): Promise<ReadingTarget | null> {
    const state = await this.nodeStateDao.getByRunNode(runId, memberId, em);
    if (!state) {
      return null;
    }
    let configDir =
      snapshotNodeConfigDirs(run.teamSnapshot).get(memberId) ?? null;
    if (snapshotNodePoolProfiles(run.teamSnapshot).has(memberId)) {
      const member =
        readNodePoolMembers(await this.itemDao.poolHandOffRows(runId, em)).get(
          memberId,
        ) ?? 1;
      const profile = snapshotMemberProfile(run.teamSnapshot, memberId, member);
      if (profile?.agentKind === state.agentKind) {
        configDir = profile.configDir;
      }
    }
    return {
      runId,
      memberId,
      callIds: null,
      stateNodeId: memberId,
      sessionKey: nodeSessionKey(runId, memberId),
      agentKind: state.agentKind,
      configDir,
      account: this.account(run, state.agentKind, configDir),
      storedReading: state.lastMetricsReading ?? null,
      atSeq: await this.itemDao.maxSeq(runId, em, memberId),
      polled: nodePolledSpend(
        state,
        (kind) => this.polledSpend.pollsSpend(kind),
        snapshotPoolKinds(run.teamSnapshot).get(memberId),
      ),
    };
  }

  /**
   * One agent-to-agent CALL as a reading target — its callee's conversation —
   * or null for a call this run's transcript does not hold, or whose callee
   * never ran.
   *
   * The call footer's ring is the callee's own window, and until this existed
   * its readout could only restate that one figure: REPORTED as "when hovering
   * to context in footer - i wanna see full details with subscription and so
   * on, same as in main chat". The process to ask is the conversation's
   * (`callSessionKey`, keyed by its FIRST call, which the executor also keys
   * by), so the lineage is rebuilt from the transcript's own call rows rather
   * than from the broker's memory — that is what still answers after the run
   * has finished or the daemon has restarted.
   *
   * Nothing is stored for a call: no row is kept per conversation to file a
   * reading under, and the farewell leaves a call's process alone for the same
   * reason. So there is no stored reading to serve, and a conversation whose
   * process is gone answers with its totals and the absence sentences.
   */
  private async callTarget(
    run: Run,
    runId: string,
    callId: string,
    em: EntityManager,
  ): Promise<ReadingTarget | null> {
    const records = readCallSeed(
      await this.kindRows.rowsOfView(runId, CALL_RECORDS, 'fresh'),
    ).records;
    const conversation = callConversation(records, callId);
    if (conversation === null) {
      return null;
    }
    const state = await this.nodeStateDao.getByRunNode(
      runId,
      conversation.calleeMemberId,
      em,
    );
    if (!state) {
      return null;
    }
    // A pooled callee's stamp is member 1's; this conversation is held by the
    // member its own session ran on — or, before any call of it has settled,
    // by whichever CLI the process now holding it runs.
    const member =
      conversation.sessionId === null
        ? null
        : sessionMember(records, conversation.sessionId);
    const sessionKey = callSessionKey(runId, conversation.conversationId);
    const live = AgentKindSchema.safeParse(this.sessions.agentOf(sessionKey));
    const profile =
      member === null
        ? null
        : snapshotMemberProfile(
            run.teamSnapshot,
            conversation.calleeMemberId,
            member,
          );
    const agentKind = live.success
      ? live.data
      : (profile?.agentKind ?? state.agentKind);
    const sessionsByCall = await this.callContextDao.sessionsByCall(runId, em);
    return {
      runId,
      memberId: conversation.calleeMemberId,
      callIds: conversation.callIds,
      stateNodeId: conversation.calleeMemberId,
      sessionKey,
      sessionId: conversation.sessionId,
      // The live process first: it is what the readout asks, so its CLI is
      // the one whose answer is being read.
      agentKind,
      configDir: profile?.configDir ?? null,
      // A pool member's own account; an in-flight conversation on another
      // member's CLI names no profile yet, so it shares nobody's reading.
      account:
        profile !== null
          ? this.account(run, agentKind, profile.configDir)
          : agentKind === state.agentKind
            ? this.nodeAccount(run, conversation.calleeMemberId, agentKind)
            : null,
      storedReading: null,
      atSeq: -1,
      polled: conversationsBill(
        readPolledSpendLedger(state.polledSpend),
        new Set([
          ...conversation.sessionIds,
          ...conversation.callIds.flatMap((id) => sessionsByCall.get(id) ?? []),
        ]),
      ),
    };
  }

  /**
   * The `turn_complete` payloads a target's spend is summed over: the whole
   * run for a chat, one member's for a member, and the calls of one conversation
   * for a call — the turns a callee ran under a call carry its `callId`.
   */
  private async turnPayloads(target: ReadingTarget): Promise<string[]> {
    const rows = await this.kindRows.rowsOf(target.runId, USAGE_ITEM_KINDS);
    if (target.callIds === null) {
      return rows
        .filter(
          (row) => target.memberId === null || row.memberId === target.memberId,
        )
        .map((row) => row.payload);
    }
    const calls = new Set(target.callIds);
    return rows
      .filter((row) => {
        if (row.memberId !== target.memberId) {
          return false;
        }
        const payload = parseJsonColumn(row.payload);
        const callId =
          typeof payload === 'object' && payload !== null
            ? (payload as { callId?: unknown }).callId
            : undefined;
        return typeof callId === 'string' && calls.has(callId);
      })
      .map((row) => row.payload);
  }

  /**
   * The merged wall-clock stretches in which some agent of this run worked,
   * and those in which it waited on the user — the chat header's clock on a
   * team (`utils/active-spans.ts`).
   */
  async readClockSpans(
    runId: string,
  ): Promise<Pick<ChatTotalsResponse, 'activeSpans' | 'pausedSpans'>> {
    const rows = await this.kindRows.rowsOf(runId, SPAN_ROW_KINDS, 'fresh');
    const paused = pausedSpansFrom(rows);
    return {
      activeSpans: activeSpansFrom(rows, paused),
      // JSON has no Infinity: a stretch still running goes out open-ended.
      pausedSpans: paused.map((span) => ({
        startMs: span.startMs,
        endMs: Number.isFinite(span.endMs) ? span.endMs : null,
      })),
    };
  }

  /**
   * `GET :runId/totals` — the spend, and on a TEAM the working stretches.
   *
   * A chat's header draws its own clock, so its stretches would be read and
   * thrown away — on a route that runs on every thread open and every settle.
   */
  async readTotalsResponse(runId: string): Promise<ChatTotalsResponse> {
    const em = this.em.fork();
    const run = await this.requireRun(runId, em);
    const totals = await this.totalsOf(runId, run, em);
    const spans =
      run.teamId === null
        ? { activeSpans: [], pausedSpans: [] }
        : await this.readClockSpans(runId);
    return { totals, ...spans };
  }

  /**
   * What this thread has cost, and NOTHING about its window.
   *
   * The same sum {@link read} answers with, reached without the adapter round
   * trip that makes that route expensive — so the header can carry the spend on
   * every thread the user opens instead of only where a readout is expanded.
   * Summed here rather than in the renderer for the reason
   * `ChatTotalsWireSchema` gives: history is paged behind an `afterSeq` cursor,
   * and a client that has scrolled back through part of a long conversation
   * would total part of it, silently.
   */
  async readTotals(runId: string): Promise<ChatTotalsWire> {
    const em = this.em.fork();
    return this.totalsOf(runId, await this.requireRun(runId, em), em);
  }

  private async requireRun(runId: string, em: EntityManager): Promise<Run> {
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    return run;
  }

  /**
   * The run's totals with its worked time made whole: the CLIs' own time plus
   * what the daemon measured for turns a CLI timed nothing of (`wall_turns`),
   * so the figure is the same however much of the history a client holds.
   */
  private async totalsOf(
    runId: string,
    run: Run,
    em: EntityManager,
  ): Promise<ChatTotalsWire> {
    const totals = await this.cliTotalsOf(runId, run, em);
    return {
      ...totals,
      workedMs: servedWorkedMs(
        totals.workedMs,
        await this.wallTurns.runSum(runId, em),
      ),
    };
  }

  private async cliTotalsOf(
    runId: string,
    run: Run,
    em: EntityManager,
  ): Promise<ChatTotalsWire> {
    // The cadence hook, and the ONLY one: looking at a thread's figures is what
    // eventually refreshes them, floored at `MIN_POLL_INTERVAL_MS` inside the
    // service so a burst of opens costs one request at most. Not awaited — a
    // header must not wait on a network read, and the next look serves the
    // answer this one fetched.
    // A TEAM run's own agentKind is null — its polled agents are members —
    // so asking the run alone never priced a Dev Team run's cursor QA.
    if (await this.polledSpend.runHoldsPolledSpend(runId, run.agentKind)) {
      void this.polledSpend.refresh();
    }
    if (run.teamId === null) {
      return applyPolledSpend(
        sumUsagePayloads(
          (await this.kindRows.rowsOf(runId, USAGE_ITEM_KINDS)).map(
            (row) => row.payload,
          ),
        ),
        run,
      );
    }
    // A TEAM run mixes CLIs: self-pricing members report their own turns, a
    // polled member's bill lands on the run. The bill is ADDED to the other
    // members' cost — replacing it showed the one polled member's price as the
    // run's whole cost. A polled member's own turn costs are left out of the sum
    // so a CLI that starts reporting cannot be counted twice.
    const nodeKinds = new Map(
      (await this.nodeStateDao.listByRun(runId, em)).map((row) => [
        row.memberId,
        row.agentKind,
      ]),
    );
    const rows = await this.kindRows.rowsOf(runId, USAGE_ITEM_KINDS);
    const all = sumUsagePayloads(rows.map((row) => row.payload));
    // Judged per TURN: a pooled member's calls run on several CLIs, and its
    // turn rows name the pool member's CLI where it is not the member's own.
    const priced = sumUsagePayloads(
      rows
        .filter(
          (row) =>
            row.memberId === null ||
            !this.polledSpend.pollsSpend(
              turnAgentKindOf(parseJsonColumn(row.payload)) ??
                nodeKinds.get(row.memberId) ??
                null,
            ),
        )
        .map((row) => row.payload),
    );
    return addPolledSpendToTotals(
      { ...all, costUsd: priced.costUsd, costedTurns: priced.costedTurns },
      run,
    );
  }

  /**
   * Resolve the run's channels ONCE, then put both questions to the adapter —
   * and say whether there was anything to ask in the first place.
   *
   * Together, not one call each, for the reason the route answers both halves
   * at once: the panel shows the window and the plan side by side, and two
   * independent resolutions could hand it a reading of a live process beside a
   * reading taken after that process was reaped.
   *
   * The `asked` half is what separates the two sentences the panel can show.
   * Without it every empty reading was reported as "send a message to take a
   * fresh reading", which is the cure for one cause and a red herring for the
   * other: an agent that WAS there and did not answer in time gets asked again
   * by simply looking again, and sending it a message fixes nothing.
   *
   * Never throws: a readout is not worth failing a request over, and the one
   * thing a caller could do about a failure — show the panel without it — is
   * what null already means. Each question is caught SEPARATELY, so a CLI that
   * answers one and not the other loses only that one.
   *
   * A `refresh` with no live process on the account takes the plan reading
   * from a one-shot process under that account, where the CLI offers one.
   */
  private async readFromAgent(
    target: ReadingTarget,
    em: EntityManager,
    refresh: boolean,
  ): Promise<{
    context: ContextBreakdownWire | null;
    plan: PlanLimitsWire | null;
    askedContext: boolean;
    askedPlan: boolean;
    /** The agent answered, and its account reports no plan windows. */
    planNotReported: boolean;
  }> {
    const { runId, agentKind } = target;
    const nothing = {
      context: null,
      plan: null,
      askedContext: false,
      askedPlan: false,
      planNotReported: false,
    };
    // A run naming no agent has nobody to ask; a CLI declaring a reason for
    // BOTH questions has nothing to be asked for. A CLI declaring only one is
    // still asked — the other half is a real feature, and short-circuiting on
    // either reason would switch it off with a plausible sentence in its place.
    if (agentKind === null) {
      return nothing;
    }
    const usage = this.adapters.for(agentKind).getConfig().usage;
    if (
      usage.breakdown.kind === 'unavailable' &&
      usage.planLimits.kind === 'unavailable'
    ) {
      return nothing;
    }
    // BOTH channels are offered and the adapter takes what it needs: claude
    // answers from the live process, cursor from the session store it wrote
    // to disk — which is why the id is fetched even when a process exists.
    const live = this.sessions.peek(target.sessionKey);
    // Plan limits are the ACCOUNT's: a conversation whose own process was
    // evicted or reaped asks any other process kept on the same account.
    const planLive =
      live ??
      (usage.planLimits.kind === 'reads' &&
      usage.planLimits.channel === 'live-process'
        ? this.accountSession(agentKind, target.account)
        : null);
    let sessionId: string | null = target.sessionId ?? null;
    if (target.sessionId === undefined) {
      try {
        const state = await this.nodeStateDao.getByRunNode(
          runId,
          target.stateNodeId,
          em,
        );
        sessionId = state?.agentSessionId ?? null;
      } catch (err) {
        this.logger.warn(
          `context session lookup for run ${runId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Whether a channel EXISTED is decided here, before the ask — the reading
    // failing is precisely the case the two sentences have to tell apart, so it
    // cannot be inferred from the reading. PER READING, and the adapter says
    // which channel each of its answers comes from: asking "does EITHER channel
    // exist" made the noLiveProcess sentence unreachable for claude, whose
    // readings need the live process while a chat that has ever run keeps a
    // session id for good. Every reaped claude chat was therefore told its agent
    // "did not answer in time — the reading is taken again while this stays
    // open" over a question nobody had asked and nothing would ask again.
    // Reproduced from the author's own daemon log: session for run 2262b385
    // closed as unused at 13:18:49, the readout opened at 13:37:07, and not one
    // warning in between because nothing was attempted.
    const available = (
      channel: UsageReadChannel,
      session: AgentSession | null,
    ): boolean => {
      switch (channel) {
        case 'live-process':
          return session !== null;
        case 'session-store':
          return sessionId !== null;
        case 'account':
          return true;
      }
    };
    const askedContext =
      usage.breakdown.kind === 'reads' &&
      available(usage.breakdown.channel, live);
    const planOneShot =
      refresh &&
      planLive === null &&
      target.account !== null &&
      usage.planLimits.kind === 'reads' &&
      usage.planLimits.oneShot === true;
    const askedPlan =
      planOneShot ||
      (usage.planLimits.kind === 'reads' &&
        available(usage.planLimits.channel, planLive));
    if (!askedContext && !askedPlan) {
      return nothing;
    }
    const adapter = this.adapters.for(agentKind);
    const input = { live, sessionId, configDir: target.configDir };
    const [context, planAnswer] = await Promise.all([
      askedContext
        ? this.attempt(runId, 'context breakdown', () =>
            adapter.readContextUsage(input),
          )
        : null,
      askedPlan
        ? this.attempt(runId, 'plan limits', () =>
            planOneShot && target.account !== null
              ? this.probePlan(target.account.key, () =>
                  adapter.readPlanLimits({
                    ...input,
                    live: null,
                    configDir: target.account?.dir ?? null,
                    mayProbe: true,
                  }),
                )
              : adapter.readPlanLimits({ ...input, live: planLive }),
          )
        : null,
    ]);
    // An ask that comes back EMPTY is otherwise silent — `CliSession.ask`
    // resolves null on its deadline rather than throwing — and that silence is
    // what made "the plan limits stopped updating" undiagnosable: the panel
    // went on serving an older account reading with nothing anywhere saying
    // the newer question had been put and gone unanswered.
    if (askedPlan && planAnswer === null) {
      this.logger.warn(
        `plan limits for ${target.sessionKey}: the agent gave no answer — an older reading is served if one is held`,
      );
    }
    const planNotReported = planAnswer === NO_PLAN_LIMITS;
    return {
      context,
      plan: planNotReported ? null : planAnswer,
      askedContext,
      askedPlan,
      planNotReported,
    };
  }

  /**
   * The last reading this run's agent gave before its process was closed, or
   * null when there is none worth showing.
   *
   * Two ways it is refused, and both matter more than the reading itself. A
   * shape the current schemas cannot parse is DISCARDED rather than served,
   * because the renderer draws these figures and half a breakdown is worse than
   * the sentence saying there is none. And a transcript that has MOVED since —
   * turns taken under a session that was closed some other way, or a daemon
   * restarted between the two — makes the figures describe a conversation that
   * no longer exists; a timestamp on screen does not make that honest, so they
   * are dropped.
   */
  private parseStoredReading(
    raw: string | null,
    atSeq: number,
    configDir: string | null,
  ): StoredMetricsReading | null {
    if (raw === null) {
      return null;
    }
    let parsed;
    try {
      parsed = StoredMetricsReadingSchema.safeParse(JSON.parse(raw));
    } catch {
      return null;
    }
    if (!parsed.success) {
      return null;
    }
    // BOTH keys, and they answer different questions: `atSeq` that the reading
    // still describes this conversation, `configDir` that it still describes
    // this account. A profile switch carries the conversation across, so it
    // moves the second without touching the first.
    return parsed.data.atSeq === atSeq &&
      parsed.data.configDir === (configDir ?? null)
      ? parsed.data
      : null;
  }

  /**
   * File one reading against the transcript position it describes.
   *
   * The ONE write path, shared by the live read and by {@link capture}, so the
   * `atSeq` contract cannot be honoured in one place and forgotten in the
   * other — that field is the whole of what keeps a stored reading from
   * outliving its conversation.
   *
   * Never throws, on both its callers' terms: for the reader this is a cache
   * fill nobody is waiting on, and for the farewell a failed write must not
   * keep a process alive.
   */
  private async store(
    target: ReadingTarget,
    context: ContextBreakdownWire | null,
    plan: PlanLimitsWire | null,
  ): Promise<void> {
    // A call's conversation has no row of its own to file a reading on.
    if (target.callIds !== null) {
      return;
    }
    const reading = JSON.stringify({
      takenAt: new Date().toISOString(),
      atSeq: target.atSeq,
      configDir: target.configDir,
      context,
      plan,
    } satisfies StoredMetricsReading);
    try {
      // On the row the reading belongs to: one per run for a chat, one per
      // member for a team run, whose members each hold their own window.
      await (target.memberId === null
        ? this.runDao.rememberMetricsReading(
            target.runId,
            reading,
            this.em.fork(),
          )
        : this.nodeStateDao.rememberMetricsReading(
            target.runId,
            target.memberId,
            reading,
            this.em.fork(),
          ));
    } catch (err) {
      this.logger.warn(
        `the reading for ${target.sessionKey} could not be filed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Take both readings from this run's agent and file them on the run.
   *
   * Called from two moments and the difference is worth naming. On the way to
   * CLOSING a process it is the last chance to ask at all — see
   * `AgentSessionRegistry.onIdleFarewell`. After a TURN it is a prewarm: the
   * process is idle, nobody is waiting, and the reading it files is what makes
   * the next open instant instead of a two-second question.
   *
   * The transcript position is read FIRST and deliberately: a turn arriving
   * while the questions are in flight leaves the figures describing the older
   * conversation, and a position taken afterwards would claim they describe the
   * newer one. Read first, the stored reading simply stops being served.
   *
   * Never throws. On the farewell path a failed reading must not keep a process
   * alive; on the prewarm path it is a cache miss and nothing more.
   */
  private async capture(sessionKey: string): Promise<void> {
    // The registry key names whose process this is. A team NODE's is taken
    // on its way out exactly as a chat's is — without it a claude Manager left
    // idle while its callees worked had nothing to show. A call's process has
    // no readout of its own to file under, so it is left alone.
    const owner = parseSessionKey(sessionKey);
    if (owner === null) {
      return;
    }
    const em = this.em.fork();
    try {
      let target: ReadingTarget | null;
      const run = await this.runDao.getById(owner.runId, em);
      if (!run) {
        target = null;
      } else if (owner.memberId === null) {
        target = await this.chatTarget(run, owner.runId, em);
      } else {
        target = await this.nodeTarget(run, owner.runId, owner.memberId, em);
      }
      if (!target?.agentKind) {
        return;
      }
      // Already current — the farewell of a session that took a reading and
      // then went unused, or a second turn-end for a transcript nothing has
      // been added to. Asking again would spend two seconds of the user's own
      // agent to write down what is already written down.
      if (
        this.parseStoredReading(
          target.storedReading,
          target.atSeq,
          target.configDir,
        ) !== null
      ) {
        return;
      }
      const agent = await this.readFromAgent(target, em, false);
      // Shared with the account even when nothing is filed below: a prewarm
      // is the commonest moment a fresh allowance is taken at all.
      this.settlePlan(target, {
        ...agent,
        takenAt: Date.now(),
        stored: null,
        refresh: false,
      });
      if (agent.context === null && agent.plan === null) {
        return;
      }
      await this.store(target, agent.context, agent.plan);
    } catch (err) {
      this.logger.warn(
        `the last reading for ${sessionKey} could not be taken: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Hand this agent's plan reading to its account's ledger and answer with the
   * best reading that account has — which may be another chat's.
   *
   * An account that ANSWERED with no windows has none now, so nothing older is
   * filled in: it would show limits the account no longer has. The live answer
   * outranks this run's own stored one, which is offered only where there is
   * none — the ledger then decides between it and every other chat's. On a
   * REFRESH the live answer stands over that choice: the user pressed it to
   * see now, not the best of what was already known.
   */
  private settlePlan(
    target: ReadingTarget,
    reading: {
      plan: PlanLimitsWire | null;
      planNotReported: boolean;
      takenAt: number;
      stored: PlanReading | null;
      /** The readout's refresh press. */
      refresh: boolean;
    },
  ): PlanReading | null {
    if (reading.planNotReported) {
      this.planLedger.forget(target.account?.key ?? null);
      return null;
    }
    const offered: PlanReading | null =
      reading.plan !== null
        ? { plan: reading.plan, takenAt: reading.takenAt }
        : reading.stored;
    return this.planLedger.settle(
      target.account?.key ?? null,
      // An undatable reading cannot be ranked against another, so it is not
      // offered — it would otherwise outrank or lose to everything at random.
      offered !== null && Number.isFinite(offered.takenAt) ? offered : null,
      Date.now(),
      // The agent's own answer only — the stored reading offered in its place
      // is no fresher than what the ledger already holds.
      reading.refresh && reading.plan !== null,
    );
  }

  /**
   * The ACCOUNT a run's agent is on: the config directory its FOLDER pins when
   * one does, else the one the run names.
   *
   * Not simply the run's own `configDir`: a project settings file's
   * `env.CLAUDE_CONFIG_DIR` re-points the CLI's account after startup, so a
   * default-profile chat in a pinned folder runs on the pinned account (the
   * measurement is in `readClaudeConfigDirPin`; the renderer's
   * `accountConfigDir` makes the same call). Keyed by the run's own field, that
   * chat's figures would have been served to every unpinned default-profile
   * chat.
   */
  private account(
    run: Run,
    agentKind: AgentKind | null,
    configDir: string | null,
  ): AgentAccount | null {
    if (agentKind === null) {
      return null;
    }
    return this.accountIn(agentKind, configDir, run.cwd);
  }

  private accountIn(
    agentKind: AgentKind,
    configDir: string | null,
    cwd: string | null,
  ): AgentAccount | null {
    const dir = effectiveAccountDir(
      configDir,
      this.configDirPins.forRun(agentKind, cwd)?.effective ?? null,
      cwd,
    );
    const key = accountKeyOf(agentKind, dir);
    return key === null ? null : { key, dir };
  }

  /**
   * The account a team member runs under: the profile the run's own team
   * copy names for it (none means the CLI's default), under the same folder
   * pin a chat is — every member of a run works in the run's folder.
   */
  private nodeAccount(
    run: Run,
    memberId: string,
    agentKind: AgentKind | null,
  ): AgentAccount | null {
    return this.account(
      run,
      agentKind,
      snapshotNodeConfigDirs(run.teamSnapshot).get(memberId) ?? null,
    );
  }

  /**
   * A live kept process of this CLI on this account, whichever run it serves —
   * an idle one first, since a busy one may answer only after its turn.
   */
  private accountSession(
    agentKind: AgentKind,
    account: AgentAccount | null,
  ): AgentSession | null {
    const onAccount = this.sessions
      .liveSessions()
      .filter(
        (kept) =>
          kept.agent === agentKind &&
          account !== null &&
          this.accountIn(agentKind, kept.configDir, kept.cwd)?.key ===
            account.key,
      );
    return (
      onAccount.find((kept) => kept.session.idle)?.session ??
      onAccount[0]?.session ??
      null
    );
  }

  private probePlan(
    account: string,
    read: () => Promise<PlanLimitsWire | typeof NO_PLAN_LIMITS | null>,
  ): Promise<PlanLimitsWire | typeof NO_PLAN_LIMITS | null> {
    const running = this.planProbes.get(account);
    if (running !== undefined) {
      return running;
    }
    const probe = read().finally(() => this.planProbes.delete(account));
    this.planProbes.set(account, probe);
    return probe;
  }

  /** One adapter question, whose failure is a null reading and a log line. */
  private async attempt<T>(
    runId: string,
    what: string,
    ask: () => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await ask();
    } catch (err) {
      this.logger.warn(
        `${what} for run ${runId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Why one of the two readings is absent, in words the panel can show.
   *
   * Two causes, and the difference is exactly what the user needs: a CLI that
   * has no such channel will never have one, while a claude chat whose process
   * has been reaped for idleness gets its reading back on the next message.
   * Collapsing them into one blank space is how "why is there nothing here?"
   * gets asked.
   *
   * Parameterized over WHICH reading rather than duplicated per reading: the
   * branching is identical and only the sentences differ, and two copies of it
   * is how one of them comes to lose the distinction the other keeps.
   */
  private absenceReason(
    agentKind: AgentKind | null,
    asked: boolean,
    declared: DeclaredReasonField,
    sentences: AbsenceSentences,
  ): string {
    // A run row's `agentKind` is nullable, and a team run genuinely has
    // none — its members each name their own. There is nothing to ask, and no
    // adapter to ask for a sentence.
    if (agentKind === null) {
      return sentences.noSingleAgent;
    }
    return (
      this.declaredReason(agentKind, declared) ??
      (asked ? sentences.noAnswer : sentences.noLiveProcess)
    );
  }

  /**
   * What this CLI's own adapter says about having no such channel, or null
   * when it declares one.
   *
   * Split out from {@link absenceReason} because the two questions are
   * different and only one of them is answerable before asking: "this agent
   * can never say" is a fact, while "there was nobody to ask just now" is only
   * known once the session has been tried.
   */
  private declaredReason(
    agentKind: AgentKind,
    field: DeclaredReasonField,
  ): string | null {
    const reading = this.adapters.for(agentKind).getConfig().usage[field];
    return reading.kind === 'unavailable' ? reading.reason : null;
  }
}

/**
 * How long a stored PLAN reading may be served as though it were current.
 *
 * The shortcut above is guarded by `atSeq` alone, and that guard is exactly
 * right for the CONTEXT half: a window is a function of the conversation, so a
 * transcript that has not moved holds a context that has not moved either. It
 * says nothing at all about an ALLOWANCE, which moves with wall-clock time and
 * with every turn the account spends in another chat, another terminal or
 * another machine — none of which writes a row here.
 *
 * So a chat nobody has typed in keeps its `atSeq` forever and served its plan
 * figures forever. REPORTED as "I STILL have team session", against a panel
 * reading `TEAM · Current week 100% · resets in 1d 15h`. Reconstructed from
 * the reporter's own `geniro.db`: six runs held a stored `plan: "team"` at
 * 100%, every one of them still servable (`atSeq === maxSeq`), with `takenAt`
 * up to twelve hours old — while the same profile, asked live, answered
 * `subscription_type: "max"` with its week at 1%. The account had changed and
 * the week had rolled; nothing in the guard could notice either.
 *
 * Two minutes keeps what the shortcut was FOR — a second open moments after
 * the first, which is the reported "too slow when i hover" — and bounds the
 * lie to a window in which an allowance cannot meaningfully move. Past it the
 * reading is taken again, which is what every open cost before the shortcut
 * existed.
 *
 * A reading served with NO live process is a different case and is not bounded
 * here: that path stamps `takenAt` and the panel dates it out loud, so it is
 * offered as the last thing anyone measured rather than as the present.
 */
const STORED_PLAN_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * Whether a stored reading's PLAN half may still be presented as current.
 *
 * True when there is no plan half at all: the bound exists to stop a stale
 * allowance being served, and a reading that carries none has none to serve —
 * refusing it there would cost every CLI that reports no allowance the whole
 * shortcut, for a figure it never had.
 */
function planReadingIsCurrent(
  reading: StoredMetricsReading,
  now: number,
): boolean {
  if (reading.plan === null) {
    return true;
  }
  const takenAt = Date.parse(reading.takenAt);
  // An unparseable stamp is not evidence of freshness. It cannot be dated, so
  // it cannot be claimed to be current.
  return Number.isFinite(takenAt) && now - takenAt <= STORED_PLAN_MAX_AGE_MS;
}

/** An ISO stamp as epoch milliseconds — NaN when it cannot be read. */
function epochOf(iso: string): number {
  return Date.parse(iso);
}

/** Which of the adapter's two declared readings to consult. */
type DeclaredReasonField = 'breakdown' | 'planLimits';

/** The three sentences one absent reading can need. */
interface AbsenceSentences {
  noSingleAgent: string;
  /**
   * What the panel says for a CLI that CAN be asked but has no process
   * running — phrased as the cure rather than the cause, since the reading is
   * taken from a live agent and the way to get one is to send a message. "No
   * session" would be true and useless.
   */
  noLiveProcess: string;
  /**
   * What the panel says when there WAS an agent to ask and the reading did not
   * come back — a control request that timed out, or a reply that could not be
   * read.
   *
   * A separate sentence because the cure is the opposite one: the channel is
   * there, so looking again is what gets a reading, while the sentence above
   * tells the user to send a message — advice that costs them a turn and fixes
   * nothing here.
   */
  noAnswer: string;
}

const CONTEXT_ABSENCE: AbsenceSentences = {
  noSingleAgent:
    'this run names no single agent, so there is no one context window to report',
  noLiveProcess:
    'the breakdown is read from the running agent — send a message in this chat to take a fresh reading',
  noAnswer:
    'the agent did not answer in time — the reading is taken again while this stays open',
};

/**
 * Said when the agent ANSWERED and its account has no plan windows — an
 * API-key account, which `get_usage` reports as `rate_limits_available: false`.
 * Neither cure in {@link PLAN_ABSENCE} applies: looking again and sending a
 * message both get the same answer.
 */
const PLAN_NOT_REPORTED =
  'this account reports no plan limits — the agent answered with no usage windows';

const PLAN_ABSENCE: AbsenceSentences = {
  noSingleAgent:
    'this run names no single agent, so there is no one account whose limits it could report',
  noLiveProcess:
    'plan limits are read from the running agent — send a message in this chat to take a fresh reading',
  noAnswer:
    'the agent did not answer the usage request in time — the reading is taken again while this stays open',
};
