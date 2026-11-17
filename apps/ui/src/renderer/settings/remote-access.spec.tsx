// @vitest-environment jsdom
import * as QRCode from 'qrcode';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RemoteAccessState, TUNNEL_OFF } from '../../shared/remote';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import {
  REMOTE_ACCESS_POLL_MS,
  REMOTE_ACCESS_POLL_WINDOW_MS,
  RemoteAccess,
} from './remote-access';

/**
 * The same `d` attribute `QrCode` would draw for `value` — built straight
 * from the library's own module matrix, exactly as the component does, so
 * this pins WHICH url is encoded rather than merely that some symbol is.
 */
function qrPathFor(value: string): string {
  const modules = QRCode.create(value, { errorCorrectionLevel: 'M' }).modules;
  let d = '';
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) {
        d += `M${col},${row}h1v1h-1z`;
      }
    }
  }
  return d;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OFF: RemoteAccessState = {
  enabled: false,
  listening: false,
  port: null,
  hostUrl: null,
  addressUrl: null,
  pairingCode: null,
  pairingCodeExpiresAt: null,
  devices: [],
  unavailableReason: null,
  tunnel: TUNNEL_OFF,
};

const NOT_LISTENING: RemoteAccessState = {
  ...OFF,
  enabled: true,
  unavailableReason: 'Port 47616 is already in use and no fallback was free.',
};

const LISTENING: RemoteAccessState = {
  enabled: true,
  listening: true,
  port: 47616,
  hostUrl: 'http://geniro-mac.local:47616',
  addressUrl: 'http://192.168.1.42:47616',
  pairingCode: '482917',
  // Ahead of the clock, as main always answers — it mints a fresh code on any
  // read past the expiry — so the page's expiry re-read is not due mid-test.
  pairingCodeExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  devices: [
    {
      id: 'device-1',
      tokenHash: 'hash-1',
      label: 'iPhone — Safari',
      pairedAt: '2026-09-20T12:00:00.000Z',
      lastSeenAt: '2026-09-21T11:00:00.000Z',
    },
  ],
  unavailableReason: null,
  tunnel: TUNNEL_OFF,
};

const geniro = {
  getRemoteAccess: vi.fn(),
  updateSettings: vi.fn(),
  regenerateRemotePairingCode: vi.fn(),
  revokeRemoteDevice: vi.fn(),
  startRemoteTunnel: vi.fn(),
  stopRemoteTunnel: vi.fn(),
};

let container: HTMLDivElement;
let root: Root | null;

async function mount({
  remote = false,
}: { remote?: boolean } = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(<RemoteAccess remote={remote} />);
  });
}

beforeEach(() => {
  geniro.getRemoteAccess.mockReset().mockResolvedValue(OFF);
  geniro.updateSettings.mockReset().mockResolvedValue({});
  geniro.regenerateRemotePairingCode.mockReset().mockResolvedValue(LISTENING);
  geniro.revokeRemoteDevice.mockReset().mockResolvedValue(LISTENING);
  geniro.startRemoteTunnel.mockReset().mockResolvedValue(LISTENING);
  geniro.stopRemoteTunnel.mockReset().mockResolvedValue(LISTENING);
  window.geniro = createPreloadStub(geniro);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container.remove();
});

describe('RemoteAccess', () => {
  it('reflects the switch off and shows none of the listening-only panels', async () => {
    await mount();
    const toggle = container.querySelector('#settings-remote-access')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).not.toContain('Pairing code');
  });

  it('explains an on-but-not-listening state with the daemon-given reason', async () => {
    geniro.getRemoteAccess.mockResolvedValue(NOT_LISTENING);
    await mount();
    expect(container.textContent).toContain(
      'Port 47616 is already in use and no fallback was free.',
    );
    // Still nothing to copy or scan — there is no link to show.
    expect(container.textContent).not.toContain('Pairing code');
  });

  it('shows both links, the QR for the primary one, the code and its devices once listening', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();
    expect(container.textContent).toContain('http://geniro-mac.local:47616');
    expect(container.textContent).toContain('http://192.168.1.42:47616');
    // The QR is labelled with a fixed instruction rather than the URL, so the
    // encoded VALUE is what pins which link it is — the primary (.local) one,
    // never the fallback.
    const qr = container.querySelector('svg[role="img"]')!;
    expect(qr.getAttribute('aria-label')).toBe(
      'Scan to open this device’s link on your phone',
    );
    const primaryPath = qrPathFor('http://geniro-mac.local:47616');
    const fallbackPath = qrPathFor('http://192.168.1.42:47616');
    expect(qr.querySelector('path')!.getAttribute('d')).toBe(primaryPath);
    expect(qr.querySelector('path')!.getAttribute('d')).not.toBe(fallbackPath);
    expect(container.textContent).toContain('482917');
    expect(container.textContent).toContain('iPhone — Safari');
  });

  it('lists the first five paired devices and the rest behind Show all', async () => {
    const [device] = LISTENING.devices;
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      devices: Array.from({ length: 7 }, (_, index) => ({
        ...device!,
        id: `device-${index}`,
        label: `Phone ${index}`,
      })),
    });
    await mount();
    const labels = (): string[] =>
      [...container.querySelectorAll('li')]
        .map((row) => row.textContent ?? '')
        .filter((text) => text.includes('Phone '));
    expect(labels()).toHaveLength(5);

    const toggle = container.querySelector(
      '[data-slot="show-all"]',
    ) as HTMLButtonElement;
    expect(toggle.textContent).toBe('Show all 7 devices');
    await act(async () => toggle.click());

    expect(labels()).toHaveLength(7);
    expect(toggle.textContent).toBe('Show fewer');
  });

  it('flips the switch, persists it and re-reads the whole state', async () => {
    geniro.getRemoteAccess
      .mockResolvedValueOnce(OFF)
      .mockResolvedValueOnce(LISTENING);
    await mount();
    const toggle = container.querySelector(
      '#settings-remote-access',
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.updateSettings).toHaveBeenCalledWith({
      remoteAccessEnabled: true,
    });
    // Re-fetched rather than assumed on: enabling the setting does not by
    // itself mean the gateway bound its port.
    expect(geniro.getRemoteAccess).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('482917');
  });

  it('rolls the switch back when the write is refused', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OFF);
    geniro.updateSettings.mockRejectedValue(new Error('refused'));
    await mount();
    const toggle = container.querySelector(
      '#settings-remote-access',
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('refused');
  });

  it('regenerates the pairing code and redraws from the reply', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.regenerateRemotePairingCode.mockResolvedValue({
      ...LISTENING,
      pairingCode: '110033',
    });
    await mount();
    const regenerate = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate'),
    )!;
    await act(async () => {
      regenerate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.regenerateRemotePairingCode).toHaveBeenCalled();
    expect(container.textContent).toContain('110033');
    expect(container.textContent).not.toContain('482917');
  });

  // A paired device is never sent the code (`redactRemoteAccessForRemote`),
  // so its reply to Regenerate is indistinguishable from the state before the
  // press. Reported from a phone as "nothing happens".
  it('on a paired device, says where the code is instead of "No code yet"', async () => {
    const REDACTED = {
      ...LISTENING,
      pairingCode: null,
      pairingCodeExpiresAt: null,
    };
    geniro.getRemoteAccess.mockResolvedValue(REDACTED);
    geniro.regenerateRemotePairingCode.mockResolvedValue(REDACTED);
    await mount({ remote: true });
    expect(container.textContent).not.toContain('No code yet');
    expect(
      container.querySelector('[data-slot="pairing-code-elsewhere"]')
        ?.textContent,
    ).toBe('Shown on your computer');
    expect(container.textContent).toContain(
      'A paired device is never sent the code.',
    );

    const regenerate = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate'),
    )!;
    await act(async () => {
      regenerate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.regenerateRemotePairingCode).toHaveBeenCalled();
    expect(
      container.querySelector('[data-slot="pairing-code-elsewhere"]')
        ?.textContent,
    ).toBe('New code is on your computer’s screen');
  });

  it('on the desktop, an absent code still reads "No code yet"', async () => {
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      pairingCode: null,
      pairingCodeExpiresAt: null,
    });
    await mount();
    expect(container.textContent).toContain('No code yet');
    expect(
      container.querySelector('[data-slot="pairing-code-elsewhere"]'),
    ).toBeNull();
  });

  it('revokes the pressed device by its id and redraws the device list', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.revokeRemoteDevice.mockResolvedValue({ ...LISTENING, devices: [] });
    await mount();
    const revoke = container.querySelector(
      'button[aria-label="Revoke iPhone — Safari"]',
    ) as HTMLButtonElement;
    await act(async () => {
      revoke.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(geniro.revokeRemoteDevice).toHaveBeenCalledWith('device-1');
    expect(container.textContent).toContain('None yet');
  });
});

describe('RemoteAccess under StrictMode', () => {
  // React's StrictMode deliberately runs mount -> cleanup -> mount. A
  // `mountedRef` that is only ever CLEARED in the cleanup is left false by
  // that rehearsal, after which every `setState` this panel makes is
  // skipped and the switch reads off and disabled whatever the gateway is
  // really doing. Driving the real app is what found it; this is what keeps
  // it found.
  it('still shows live state after the double-invoked mount effect', async () => {
    geniro.getRemoteAccess.mockReset().mockResolvedValue(LISTENING);
    const strictContainer = document.createElement('div');
    document.body.appendChild(strictContainer);
    const strictRoot = createRoot(strictContainer);
    await act(async () => {
      strictRoot.render(
        <StrictMode>
          <RemoteAccess />
        </StrictMode>,
      );
    });

    // The live pairing code only renders once `setState` actually landed.
    expect(strictContainer.textContent).toContain(LISTENING.pairingCode!);

    await act(async () => strictRoot.unmount());
    strictContainer.remove();
  });
});

describe('RemoteAccess — the public address', () => {
  const OPEN: RemoteAccessState = {
    ...LISTENING,
    tunnel: {
      status: 'open',
      provider: 'cloudflared',
      url: 'https://keyword-portsmouth.trycloudflare.com',
      error: null,
      detail: null,
    },
  };

  const CONNECTING: RemoteAccessState = {
    ...LISTENING,
    tunnel: {
      status: 'starting',
      provider: 'cloudflared',
      url: null,
      error: null,
      detail: 'lookup argotunnel.com on 100.95.0.253:53: i/o timeout',
    },
  };

  /** The panel's one button, whichever of its states it is in. */
  function tunnelButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((el) =>
      /Get an address|Close address|Cancel/.test(el.textContent ?? ''),
    );
    if (!button) {
      throw new Error('expected the tunnel button to be rendered');
    }
    return button;
  }

  it('offers the press only once the gateway is listening', async () => {
    geniro.getRemoteAccess.mockResolvedValue(NOT_LISTENING);
    await mount();
    // A tunnel forwards to this listener, so there is nothing to publish.
    expect(container.textContent).not.toContain('Get an address');
  });

  it('opens an address on the press, and redraws from the one reply', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.startRemoteTunnel.mockResolvedValue(OPEN);
    await mount();

    await act(async () => tunnelButton().click());

    expect(geniro.startRemoteTunnel).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      'https://keyword-portsmouth.trycloudflare.com',
    );
  });

  it('encodes the PUBLIC url in a QR of its own, beside the LAN one', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OPEN);
    await mount();

    const labels = [...container.querySelectorAll('svg[role="img"]')].map(
      (qr) => qr.getAttribute('aria-label'),
    );
    expect(labels).toContain('Scan to open the public link on your phone');

    const publicQr = [...container.querySelectorAll('svg[role="img"]')].find(
      (qr) =>
        qr.getAttribute('aria-label') ===
        'Scan to open the public link on your phone',
    )!;
    // Pins WHICH url is encoded — the tunnel's, never the `.local` one.
    expect(publicQr.querySelector('path')!.getAttribute('d')).toBe(
      qrPathFor('https://keyword-portsmouth.trycloudflare.com'),
    );
  });

  it('closes it on the second press, through the other channel', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OPEN);
    geniro.stopRemoteTunnel.mockResolvedValue(LISTENING);
    await mount();

    await act(async () => tunnelButton().click());

    expect(geniro.stopRemoteTunnel).toHaveBeenCalledOnce();
    expect(geniro.startRemoteTunnel).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(
      'https://keyword-portsmouth.trycloudflare.com',
    );
  });

  it('shows the tunnel client’s own words when it refuses', async () => {
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      tunnel: {
        status: 'error',
        provider: 'ngrok',
        url: null,
        error: 'ngrok stopped (exit 1): authentication failed',
        detail: null,
      },
    } satisfies RemoteAccessState);
    await mount();

    // The failure the user can act on is the CLIENT's, not a generic one —
    // an expired authtoken names its own fix.
    expect(container.textContent).toContain('authentication failed');
  });

  it('shows no address or code to scan while connecting, only what the client says', async () => {
    geniro.getRemoteAccess.mockResolvedValue(CONNECTING);
    await mount();

    expect(container.textContent).toContain('Connecting…');
    expect(
      container.querySelector('[data-slot="tunnel-detail"]')?.textContent,
    ).toBe(
      'cloudflared: lookup argotunnel.com on 100.95.0.253:53: i/o timeout',
    );
    expect(container.textContent).not.toContain('Public (via');
    expect(
      container.querySelector(
        'svg[aria-label="Scan to open the public link on your phone"]',
      ),
    ).toBeNull();
  });

  it('cancels a wait through the closing channel', async () => {
    geniro.getRemoteAccess.mockResolvedValue(CONNECTING);
    geniro.stopRemoteTunnel.mockResolvedValue(LISTENING);
    await mount();

    expect(tunnelButton().textContent).toBe('Cancel');
    await act(async () => tunnelButton().click());

    expect(geniro.stopRemoteTunnel).toHaveBeenCalledOnce();
    expect(geniro.startRemoteTunnel).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Connecting…');
  });

  it('does not read as connecting when a read lands while a close is out', async () => {
    geniro.getRemoteAccess.mockResolvedValue(OPEN);
    geniro.stopRemoteTunnel.mockReturnValue(new Promise(() => {}));
    await mount();

    await act(async () => tunnelButton().click());
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(container.textContent).not.toContain('https://keyword-portsmouth');
    expect(container.textContent).not.toContain('Connecting…');
    expect(tunnelButton().disabled).toBe(true);
  });

  it('offers the cancel from the press itself, before any read says it is connecting', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.startRemoteTunnel.mockReturnValue(new Promise(() => {}));
    await mount();

    await act(async () => tunnelButton().click());

    expect(container.textContent).toContain('Connecting…');
    expect(tunnelButton().textContent).toBe('Cancel');
    expect(tunnelButton().disabled).toBe(false);
  });

  it('keeps reading through a wait that outlasts the polling window', async () => {
    vi.useFakeTimers();
    try {
      geniro.getRemoteAccess.mockResolvedValue(LISTENING);
      await mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          REMOTE_ACCESS_POLL_WINDOW_MS - 2 * REMOTE_ACCESS_POLL_MS,
        );
      });
      geniro.getRemoteAccess.mockResolvedValue(CONNECTING);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
      });
      expect(container.textContent).toContain('Connecting…');

      const before = geniro.getRemoteAccess.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS * 3);
      });
      expect(geniro.getRemoteAccess.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RemoteAccess — staying current without a press', () => {
  // The code rotates and devices appear with nothing pressed here: a phone
  // pairing rotates the code, so does a tripped lockout, so does its TTL. The
  // page read the gateway only at mount and after its own actions, so it went
  // on showing a code that no longer worked and a device list without the
  // phone that had just paired.
  const PAIRED: RemoteAccessState = {
    ...LISTENING,
    pairingCode: '730512',
    devices: [
      ...LISTENING.devices,
      {
        id: 'device-2',
        tokenHash: 'hash-2',
        label: 'Pixel — Chrome',
        pairedAt: '2026-09-21T11:30:00.000Z',
        lastSeenAt: '2026-09-21T11:30:00.000Z',
      },
    ],
  };

  let visibility: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    // Back to jsdom's own getter on the prototype.
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  async function setVisibility(next: DocumentVisibilityState): Promise<void> {
    visibility = next;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  it('re-reads when the window regains focus', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();
    geniro.getRemoteAccess.mockResolvedValue(PAIRED);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(container.textContent).toContain('730512');
    expect(container.textContent).toContain('Pixel — Chrome');
  });

  it('polls while visible, so a phone that pairs shows up with no focus change', async () => {
    // Pairing happens on the PHONE while this window keeps its focus, so no
    // focus event will ever say to look again.
    vi.useFakeTimers();
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();
    geniro.getRemoteAccess.mockResolvedValue(PAIRED);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
    });

    expect(container.textContent).toContain('730512');
    expect(container.textContent).toContain('Pixel — Chrome');
  });

  it('stops polling while hidden, and when its window runs out', async () => {
    vi.useFakeTimers();
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();

    await setVisibility('hidden');
    const whileHidden = geniro.getRemoteAccess.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS * 6);
    });
    expect(geniro.getRemoteAccess.mock.calls.length).toBe(whileHidden);

    // Revealed: read at once, then polled again — for a bounded window only.
    await setVisibility('visible');
    expect(geniro.getRemoteAccess.mock.calls.length).toBe(whileHidden + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_WINDOW_MS);
    });
    const atWindowEnd = geniro.getRemoteAccess.mock.calls.length;
    expect(atWindowEnd).toBeGreaterThan(whileHidden + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS * 6);
    });
    expect(geniro.getRemoteAccess.mock.calls.length).toBe(atWindowEnd);
  });

  it('stops polling once the page is left', async () => {
    vi.useFakeTimers();
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();
    await act(async () => root?.unmount());
    root = null;
    const atUnmount = geniro.getRemoteAccess.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS * 6);
    });

    expect(geniro.getRemoteAccess.mock.calls.length).toBe(atUnmount);
  });

  it('re-reads just past the code’s own expiry, even with the poll stopped', async () => {
    // The expiry outlives the poll's window, and a hidden window stops the
    // poll — the code's clock is what still has to redraw it.
    vi.useFakeTimers();
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      pairingCodeExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await mount();
    await setVisibility('hidden');
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      pairingCode: '905114',
      pairingCodeExpiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(container.textContent).toContain('482917');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.textContent).toContain('905114');
  });

  it('never lets a read issued BEFORE a press land over that press', async () => {
    // A poll already in flight when Regenerate is pressed answers with the
    // OLD code; applied last, it would put a code back that no longer works.
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    geniro.regenerateRemotePairingCode.mockResolvedValue({
      ...LISTENING,
      pairingCode: '110033',
    });
    await mount();
    let answerStaleRead: (state: RemoteAccessState) => void = () => {};
    geniro.getRemoteAccess.mockReturnValue(
      new Promise<RemoteAccessState>((resolve) => {
        answerStaleRead = resolve;
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    const regenerate = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate'),
    )!;
    await act(async () => {
      regenerate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('110033');

    await act(async () => {
      answerStaleRead(LISTENING);
    });
    expect(container.textContent).toContain('110033');
    expect(container.textContent).not.toContain('482917');
  });

  it('says so when the gateway cannot be read', async () => {
    geniro.getRemoteAccess.mockRejectedValue(
      new Error('remote access is not wired for this launch'),
    );
    await mount();

    expect(container.textContent).toContain(
      'remote access is not wired for this launch',
    );
  });
});

describe('RemoteAccess — explanations', () => {
  const aboutTrigger = (label: string): Element | null =>
    container.querySelector(`button[aria-label="About ${label}"]`);

  it('explains the switch while off', async () => {
    await mount();
    expect(aboutTrigger('Remote access')).not.toBeNull();
  });

  it('explains every block once listening, and titles its buttons', async () => {
    geniro.getRemoteAccess.mockResolvedValue(LISTENING);
    await mount();

    for (const label of [
      'Links',
      'Internet address',
      'Pairing code',
      'Paired devices',
      'Devices',
    ]) {
      expect(aboutTrigger(label), label).not.toBeNull();
    }
    const regenerate = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate'),
    )!;
    expect(regenerate.title).toContain('Replace the pairing code');
    const tunnel = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Get an address'),
    )!;
    expect(tunnel.title).toContain('Start a tunnel');
  });

  it('counts the paired devices it lists', async () => {
    const [device] = LISTENING.devices;
    geniro.getRemoteAccess.mockResolvedValue({
      ...LISTENING,
      devices: Array.from({ length: 7 }, (_, index) => ({
        ...device!,
        id: `device-${index}`,
        label: `Phone ${index}`,
      })),
    });
    await mount();
    expect(container.textContent).toContain('7 devices are paired.');
  });
});
