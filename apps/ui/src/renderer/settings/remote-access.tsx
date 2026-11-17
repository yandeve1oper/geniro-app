import {
  Globe,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Smartphone,
  Tablet,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { RemoteAccessState } from '../../shared/remote';
import { formatRelativeTime } from '../chats/relative-time';
import { CopyButton } from '../components/copy-button';
import { ErrorText } from '../components/error-text';
import { QrCode } from '../components/qr-code';
import { SettingsGroup, SettingsGroups } from '../components/settings-group';
import { SettingsPanel, SettingsPanelRow } from '../components/settings-panel';
import { ShowAllButton, useShowAll } from '../components/show-all';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { useLatestCallback } from '../components/use-latest-callback';
import { isRemoteRuntime } from '../remote/remote-session';

/**
 * How often the page re-reads the gateway while it is on screen.
 *
 * The code rotates, and devices appear, WITHOUT this page doing anything: a
 * phone pairing rotates the code (`Pairing.verify`), a tripped global lockout
 * rotates it, and so does its TTL — and the pairing itself happens on the
 * phone, while this window keeps its focus, so no focus event ever says to
 * look again. A few seconds is the wait between typing the code on the phone
 * and seeing it listed here. The read is a local IPC call answering a small
 * object, so the cadence is cheap.
 */
export const REMOTE_ACCESS_POLL_MS = 5_000;

/**
 * How long after the page was last opened, focused or revealed it keeps
 * polling — which is what bounds the poll.
 *
 * Pairing is something done right after opening this page, so the window
 * covers it with room to spare; a page left open on a focused window for an
 * afternoon does not keep asking. The code's own expiry timer, and the next
 * focus, cover what comes after.
 */
export const REMOTE_ACCESS_POLL_WINDOW_MS = 5 * 60_000;

/**
 * How long past the code's stated expiry the page re-reads.
 *
 * Past it, not at it: main rotates on a READ once `now - issuedAt >= TTL`, so
 * a timer landing a millisecond early would be answered with the expiring
 * code and the same expiry — which re-arms nothing, leaving the page showing a
 * code that stopped working moments later.
 */
const EXPIRY_REREAD_MARGIN_MS = 1_000;
const DEVICES_SHOWN = 5;
const NO_DEVICES: RemoteAccessState['devices'] = [];

type TunnelPress = 'open' | 'close';

/**
 * One copyable link — the `.local` primary or the IP fallback.
 *
 * Both are shown because neither works everywhere ({@link RemoteAccessState}'s
 * own doc): a `.local` name needs mDNS, which some Android builds and some
 * guest networks refuse to resolve, and the IP is the fallback for exactly
 * that case.
 */
function RemoteLinkRow({
  label,
  url,
}: {
  label: string;
  url: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="truncate font-mono text-sm" title={url}>
          {url}
        </span>
      </div>
      <CopyButton text={url} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

/**
 * The public address, and the one press that opens or closes it.
 *
 * Its own panel rather than a third row beside the LAN links, because it is a
 * different promise: those two describe a listener anyone on the Wi-Fi can
 * already reach, while this one describes a tunnel client geniro starts on
 * demand and stops again. It is a PRESS and never a switch geniro flips for
 * itself — see `main/remote/tunnel.ts`.
 */
function TunnelPanel({
  tunnel,
  onOpen,
  onClose,
  pending,
}: {
  tunnel: RemoteAccessState['tunnel'];
  onOpen: () => void;
  onClose: () => void;
  pending: TunnelPress | null;
}): React.JSX.Element {
  const open = tunnel.status === 'open';
  const closing = pending === 'close';
  const connecting =
    !open && (tunnel.status === 'starting' || pending === 'open');
  return (
    <SettingsGroup
      icon={<Globe />}
      title="Public address"
      description="Reach this Mac from outside your Wi-Fi."
      hint="By default only devices on your own network can connect. A public address lets a phone on mobile data connect too, through a free tunnel program you already have installed. Geniro starts it when you press the button and stops it when you close the address.">
      <SettingsPanel>
        <SettingsPanelRow
          layout="block"
          label="Internet address"
          hint="Pressing Get an address starts the tunnel program (cloudflared, else ngrok) and shows a public link once it connects. Anyone who gets that link sees the pairing screen, so keep the pairing code private. The link may change each time it opens (cloudflared always gives a new one), and Close address shuts it down; Cancel stops a connection that is still starting."
          description="Runs a tunnel client on this Mac (cloudflared, else ngrok) and forwards a public address to it. Anyone with the link reaches the pairing screen, so the 6-digit code becomes the only thing in front of your agents.">
          <div className="flex flex-col gap-2">
            {open && tunnel.url ? (
              <RemoteLinkRow
                label={`Public (via ${tunnel.provider ?? 'tunnel'})`}
                url={tunnel.url}
              />
            ) : null}
            {tunnel.status === 'error' && tunnel.error ? (
              <ErrorText>{tunnel.error}</ErrorText>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={open || connecting ? 'outline' : 'default'}
                size="sm"
                className="shrink-0 gap-1.5"
                disabled={closing}
                title={
                  connecting
                    ? 'Stop connecting and do not open a public address.'
                    : open
                      ? 'Shut the tunnel down. The public link stops working.'
                      : 'Start a tunnel and get a public link to this Mac.'
                }
                onClick={open || connecting ? onClose : onOpen}>
                {closing || connecting ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 shrink-0 animate-spin"
                  />
                ) : (
                  <Globe aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                {connecting
                  ? 'Cancel'
                  : open
                    ? 'Close address'
                    : 'Get an address'}
              </Button>
              {connecting ? (
                <span className="text-xs text-muted-foreground">
                  Connecting… The address appears here once it works.
                </span>
              ) : null}
            </div>
            {connecting && tunnel.detail ? (
              <p
                data-slot="tunnel-detail"
                className="m-0 text-xs break-words text-muted-foreground">
                {tunnel.provider}: {tunnel.detail}
              </p>
            ) : null}
          </div>
        </SettingsPanelRow>
        {open && tunnel.url ? (
          <SettingsPanelRow layout="block">
            <div className="flex items-center gap-3">
              <QrCode
                value={tunnel.url}
                size={144}
                label="Scan to open the public link on your phone"
              />
              <p className="text-xs text-muted-foreground">
                Works from any network, not just this Wi-Fi. The address changes
                every time you open one.
              </p>
            </div>
          </SettingsPanelRow>
        ) : null}
      </SettingsPanel>
    </SettingsGroup>
  );
}

/**
 * One device that has paired, with when it was last seen and a way to kick it
 * off.
 */
function DeviceRow({
  device,
  onRevoke,
  revoking,
}: {
  device: RemoteAccessState['devices'][number];
  onRevoke: (deviceId: string) => void;
  revoking: boolean;
}): React.JSX.Element {
  return (
    <li
      data-slot="remote-device-row"
      className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5">
      <Smartphone
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm" title={device.label}>
          {device.label}
        </span>
        <span className="text-xs text-muted-foreground">
          Last seen {formatRelativeTime(device.lastSeenAt)} · paired{' '}
          {formatRelativeTime(device.pairedAt)}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Revoke ${device.label}`}
        title={`Revoke ${device.label} — it will have to pair again`}
        disabled={revoking}
        onClick={() => onRevoke(device.id)}>
        {revoking ? (
          <Loader2
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin"
          />
        ) : (
          <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
        )}
      </Button>
    </li>
  );
}

/**
 * Settings → Remote access — the one screen that shows and controls the LAN
 * gateway (`main/remote/`, see the root `AGENTS.md` → *Constraints*).
 *
 * It reads its whole picture from ONE call, {@link RemoteAccessState}, and
 * every mutating action (the switch, Regenerate, Revoke) re-reads it rather
 * than patching local state — the state is small, it is shared with a paired
 * PHONE reading the identical shape over the gateway's own bridge, and a
 * hand-folded patch here is a second copy of logic the daemon-analogous main
 * process already has to get right once.
 *
 * It re-reads on its own, too — on focus, on the code's expiry, and on a
 * bounded poll while visible — because the code and the device list change
 * without any press here, and main has no push channel for them. It was
 * fetched only at mount and after this page's own actions, so a phone that
 * paired left the page showing a code that no longer worked and a device list
 * without the phone in it.
 */
export function RemoteAccess({
  remote = isRemoteRuntime(),
}: {
  /**
   * This page is open on a PAIRED device rather than on the Mac. The gateway
   * never sends such a device the code (`redactRemoteAccessForRemote` in
   * `main/ipc.ts`), so a stolen phone cannot pair more devices — and the page
   * has to say where the code is instead of reading "No code yet".
   */
  remote?: boolean;
} = {}): React.JSX.Element {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // A press on a paired device rotates a code that device will never see, so
  // the reply looks exactly like the state before it. Without a line saying it
  // worked, Regenerate reads as a button that does nothing — which is how it
  // was reported.
  const [regeneratedHere, setRegeneratedHere] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // The switch flips at once, before the round trip answers — a toggle that
  // waited for `updateSettings` to resolve before moving would read as an
  // unresponsive control on a slow launch.
  const [togglePending, setTogglePending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-armed in the effect BODY, not only cleared in the cleanup. React's
    // StrictMode runs mount → cleanup → mount, so a cleanup-only version
    // leaves this false for the rest of the component's life and every later
    // `setState` is skipped — the panel then shows the switch off and
    // disabled no matter what the gateway is actually doing, which is what
    // driving the real app found.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Bumped by every press on this page. A READ issued before the latest press
   * is dropped when it lands, so a poll already in flight cannot put back what
   * the press just changed — the optimistic switch flicking back, or the old
   * code over the regenerated one. Reads issued AFTER the press still land,
   * and so does the press's own answer: the gateway computes each reply when
   * it answers, so a later arrival is never an older picture.
   */
  const pressEpochRef = useRef(0);

  const refresh = useLatestCallback((): void => {
    const epoch = pressEpochRef.current;
    void window.geniro
      .getRemoteAccess()
      .then((next) => {
        if (mountedRef.current && epoch === pressEpochRef.current) {
          setState(next);
        }
      })
      .catch((err: unknown) => {
        // Said rather than swallowed: with nothing read, the switch sits
        // disabled and the page would give no reason why.
        if (mountedRef.current && epoch === pressEpochRef.current) {
          setError(String(err));
        }
      });
  }, []);

  useEffect(refresh, [refresh]);

  // Keep the page current while somebody is looking at it — see
  // `REMOTE_ACCESS_POLL_MS` for what changes behind its back. A focus or a
  // reveal re-reads at once and restarts the bounded window; a hidden window
  // stops the poll outright rather than ticking to no purpose. A tunnel that
  // starts or stops connecting restarts it too: the wait can run for minutes,
  // and pairing follows it.
  const tunnelConnecting = state?.tunnel.status === 'starting';
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let until = 0;
    const visible = (): boolean => document.visibilityState === 'visible';
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = (): void => {
      until = Date.now() + REMOTE_ACCESS_POLL_WINDOW_MS;
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        if (!visible() || Date.now() >= until) {
          stop();
          return;
        }
        refresh();
      }, REMOTE_ACCESS_POLL_MS);
    };
    const onLook = (): void => {
      if (!visible()) {
        stop();
        return;
      }
      refresh();
      start();
    };
    if (visible()) {
      start();
    }
    window.addEventListener('focus', onLook);
    document.addEventListener('visibilitychange', onLook);
    return () => {
      stop();
      window.removeEventListener('focus', onLook);
      document.removeEventListener('visibilitychange', onLook);
    };
  }, [refresh, tunnelConnecting]);

  // The code's own clock, which outlives the poll's window: re-read just past
  // the stated expiry, when main has minted the next one. Re-armed whenever
  // the expiry moves, which is every time the code does.
  const codeExpiresAt = state?.pairingCodeExpiresAt ?? null;
  useEffect(() => {
    if (codeExpiresAt === null) {
      return;
    }
    const due = Date.parse(codeExpiresAt);
    const timer = setTimeout(
      refresh,
      Math.max(0, due - Date.now() + EXPIRY_REREAD_MARGIN_MS),
    );
    return () => clearTimeout(timer);
  }, [codeExpiresAt, refresh]);

  const onToggle = useLatestCallback(
    (next: boolean): void => {
      pressEpochRef.current += 1;
      setError(null);
      setTogglePending(true);
      // Optimistic, on the same reasoning every other switch in this screen's
      // parent follows — the write is a settings patch keyed by ONE field, so
      // a refusal is a genuine surprise rather than the common case.
      setState((prev) => (prev ? { ...prev, enabled: next } : prev));
      void window.geniro
        .updateSettings({ remoteAccessEnabled: next })
        .then(() => {
          // The GATEWAY takes a moment to bind or tear down its listener, so
          // the freshly-fetched state is what says whether it is actually
          // LISTENING — `enabled` alone would read "on" the instant before a
          // bind failure sets `unavailableReason`.
          if (mountedRef.current) {
            refresh();
          }
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) {
            return;
          }
          setState((prev) => (prev ? { ...prev, enabled: !next } : prev));
          setError(String(err));
        })
        .finally(() => {
          if (mountedRef.current) {
            setTogglePending(false);
          }
        });
    },
    [refresh],
  );

  const onRegenerate = useLatestCallback((): void => {
    pressEpochRef.current += 1;
    setError(null);
    setRegenerating(true);
    setRegeneratedHere(false);
    void window.geniro
      .regenerateRemotePairingCode()
      .then((next) => {
        if (mountedRef.current) {
          setState(next);
          setRegeneratedHere(true);
        }
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRegenerating(false);
        }
      });
  }, []);

  // ONE state for both presses: opening and closing are the same control, and
  // a Cancel replaces the open press it ends.
  const [tunnelPending, setTunnelPending] = useState<TunnelPress | null>(null);
  const runTunnel = useLatestCallback(
    (press: TunnelPress, call: () => Promise<RemoteAccessState>): void => {
      pressEpochRef.current += 1;
      setError(null);
      setTunnelPending(press);
      void call()
        .then((next) => {
          if (mountedRef.current) {
            setState(next);
          }
        })
        .catch((err: unknown) => {
          if (mountedRef.current) {
            setError(String(err));
          }
        })
        .finally(() => {
          if (mountedRef.current) {
            setTunnelPending(null);
          }
        });
    },
    [],
  );

  const onRevoke = useLatestCallback((deviceId: string): void => {
    pressEpochRef.current += 1;
    setError(null);
    setRevokingId(deviceId);
    void window.geniro
      .revokeRemoteDevice(deviceId)
      .then((next) => {
        if (mountedRef.current) {
          setState(next);
        }
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(String(err));
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRevokingId(null);
        }
      });
  }, []);

  const {
    shown: shownDevices,
    expanded: devicesExpanded,
    setExpanded: setDevicesExpanded,
  } = useShowAll(state?.devices ?? NO_DEVICES, DEVICES_SHOWN);

  return (
    <SettingsGroups>
      {error ? <ErrorText>{error}</ErrorText> : null}

      <SettingsGroup
        icon={<Tablet />}
        title="Access from other devices"
        description="Open your live chats from a phone or tablet."
        hint="Turn this on to use Geniro from your phone while this Mac is running. The Mac serves the app to devices on the same Wi-Fi, and a device has to pair first with a code shown here. Nothing goes through a Geniro server.">
        <SettingsPanel>
          <SettingsPanelRow
            label="Remote access"
            htmlFor="settings-remote-access"
            description="Serves this app to your Wi-Fi so a phone can open the same live chats. Off, the port is never opened at all."
            hint="On: this Mac listens for devices on your network and shows a link, a QR code and a pairing code below. Off: nothing is listening, and every paired device stops working until you turn it back on. Turning it off also closes a public address.">
            <Switch
              id="settings-remote-access"
              checked={state?.enabled ?? false}
              disabled={state === null || togglePending}
              onCheckedChange={onToggle}
            />
          </SettingsPanelRow>
          {/* Exactly the state `enabled`/`listening` are two fields for: the
              switch is on and the port never bound. */}
          {state?.enabled && !state.listening && state.unavailableReason ? (
            <SettingsPanelRow layout="block">
              <ErrorText>{state.unavailableReason}</ErrorText>
            </SettingsPanelRow>
          ) : null}
        </SettingsPanel>
      </SettingsGroup>

      {state?.enabled && state.listening ? (
        <>
          <SettingsGroup
            icon={<Link2 />}
            title="Open on a device"
            description="The addresses to type or scan on the phone."
            hint="These are the addresses of this Mac on your network. Open one in the phone's browser, or scan the QR code with its camera, and the pairing screen appears.">
            <SettingsPanel>
              <SettingsPanelRow
                layout="block"
                label="Links"
                hint="Use the first one, which is the Mac's name on the network. Some phones and guest Wi-Fi networks cannot find a name like that; for those, use the second one, which is the Mac's numeric address. The copy buttons put the link on your clipboard.">
                <div className="flex flex-col gap-2">
                  {state.hostUrl ? (
                    <RemoteLinkRow
                      label="This device (.local)"
                      url={state.hostUrl}
                    />
                  ) : null}
                  {state.addressUrl ? (
                    <RemoteLinkRow
                      label="This device (IP address, if .local doesn’t resolve)"
                      url={state.addressUrl}
                    />
                  ) : null}
                </div>
              </SettingsPanelRow>
              {state.hostUrl ? (
                <SettingsPanelRow layout="block">
                  <div className="flex items-center gap-3">
                    <QrCode
                      value={state.hostUrl}
                      size={144}
                      label="Scan to open this device’s link on your phone"
                    />
                    <p className="text-xs text-muted-foreground">
                      Scan with your phone’s camera to open the primary link —
                      the real team is scanning this rather than retyping it.
                    </p>
                  </div>
                </SettingsPanelRow>
              ) : null}
            </SettingsPanel>
          </SettingsGroup>

          <TunnelPanel
            tunnel={state.tunnel}
            pending={tunnelPending}
            onOpen={() =>
              runTunnel('open', () => window.geniro.startRemoteTunnel())
            }
            onClose={() =>
              runTunnel('close', () => window.geniro.stopRemoteTunnel())
            }
          />

          <SettingsGroup
            icon={<KeyRound />}
            title="Pairing"
            description="The code a new device types to join."
            hint="Pairing is how a device proves it is yours. A device that opens the link must type the code shown here before it can see anything. Once paired, it stays paired until you revoke it.">
            <SettingsPanel>
              <SettingsPanelRow
                layout="block"
                label="Pairing code"
                hint="Type this 6-digit code on the new device when it asks. The code changes by itself every few minutes and after each device pairs, so an old code cannot be reused. Regenerate gives you a fresh one at once, for example if you showed the code to someone by mistake.">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    {state.pairingCode ? (
                      <span className="font-mono text-3xl tracking-[0.3em] tabular-nums">
                        {state.pairingCode}
                      </span>
                    ) : remote ? (
                      <span
                        data-slot="pairing-code-elsewhere"
                        className="text-sm text-muted-foreground">
                        {regeneratedHere
                          ? 'New code is on your computer’s screen'
                          : 'Shown on your computer'}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        No code yet
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {remote && !state.pairingCode
                        ? 'Open Settings → Remote access on the computer running Geniro. A paired device is never sent the code.'
                        : state.pairingCodeExpiresAt
                          ? `A new device types this. Rotates at ${new Date(
                              state.pairingCodeExpiresAt,
                            ).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}.`
                          : 'A new device types this.'}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    title="Replace the pairing code with a new one now."
                    disabled={regenerating}
                    onClick={onRegenerate}>
                    {regenerating ? (
                      <Loader2
                        aria-hidden="true"
                        className="size-3.5 shrink-0 animate-spin"
                      />
                    ) : (
                      <RefreshCw
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />
                    )}
                    Regenerate
                  </Button>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </SettingsGroup>

          <SettingsGroup
            icon={<Smartphone />}
            title="Devices"
            description={
              state.devices.length === 0
                ? 'No device has paired yet.'
                : `${state.devices.length} ${state.devices.length === 1 ? 'device is' : 'devices are'} paired.`
            }
            hint="Every phone or tablet that has typed the pairing code. A paired device can open your chats, so revoke any you no longer use or recognise.">
            <SettingsPanel>
              <SettingsPanelRow
                layout="block"
                label="Paired devices"
                hint="Each row is a device that can open Geniro from this Mac. Revoke (the bin) signs that device out at once; to use it again it has to pair with a fresh code.">
                {state.devices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None yet — a device pairs by typing the code above.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {shownDevices.map((device) => (
                        <DeviceRow
                          key={device.id}
                          device={device}
                          onRevoke={onRevoke}
                          revoking={revokingId === device.id}
                        />
                      ))}
                    </ul>
                    <ShowAllButton
                      total={state.devices.length}
                      limit={DEVICES_SHOWN}
                      expanded={devicesExpanded}
                      onToggle={() => setDevicesExpanded(!devicesExpanded)}
                      noun="devices"
                    />
                  </div>
                )}
              </SettingsPanelRow>
            </SettingsPanel>
          </SettingsGroup>
        </>
      ) : null}
    </SettingsGroups>
  );
}
