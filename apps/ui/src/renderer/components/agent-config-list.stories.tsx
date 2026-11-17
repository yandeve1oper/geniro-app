import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import type {
  CliDetection,
  CliKind,
  CliUpdateState,
} from '../../shared/contracts';
import {
  AgentConfigList,
  type AgentConfigListProps,
} from './agent-config-list';

/** Nothing has been asked, or the CLI could not answer. */
const NO_UPDATE_INFO: CliUpdateState = {
  available: null,
  latestVersion: null,
  checkUnavailableReason: null,
};

const READY_CLIS: CliDetection[] = [
  {
    kind: 'claude',
    found: true,
    path: '/usr/local/bin/claude',
    version: '2.1.235',
    loggedIn: true,
    update: NO_UPDATE_INFO,
  },
  {
    kind: 'cursor-agent',
    found: true,
    path: '/usr/local/bin/cursor-agent',
    version: '2026.08.11',
    loggedIn: true,
    update: NO_UPDATE_INFO,
  },
];

/**
 * The two shapes an update check really takes, side by side — a CLI that
 * answered, and one that cannot be asked. Both wordings and both buttons come
 * from the same band, which is the thing worth seeing together.
 */
const UPDATE_CLIS: CliDetection[] = [
  {
    ...READY_CLIS[0]!,
    update: {
      available: null,
      latestVersion: null,
      checkUnavailableReason:
        'claude has no check of its own — it looks for a new version only while installing one.',
    },
  },
  {
    ...READY_CLIS[1]!,
    update: {
      available: true,
      latestVersion: '2026.09.02-c22c1a3',
      checkUnavailableReason: null,
    },
  },
];

/** Installed and detected, but the CLI reports itself signed out. */
const SIGNED_OUT_CLIS: CliDetection[] = [
  { ...READY_CLIS[0]!, loggedIn: false },
  READY_CLIS[1]!,
];

/** Drives the pieces of state a real Settings/Onboarding screen owns, so the
 * cards actually expand and the binary-path fields actually type. */
function AgentConfigListDemo(
  props: Omit<
    AgentConfigListProps,
    'open' | 'onToggle' | 'binaryPaths' | 'onBinaryPathChange'
  >,
): React.JSX.Element {
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({
    claude: true,
  });
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  return (
    <div className="w-[420px]">
      <AgentConfigList
        {...props}
        open={open}
        onToggle={(kind) =>
          setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }))
        }
        binaryPaths={binaryPaths}
        onBinaryPathChange={(kind, value) =>
          setBinaryPaths((prev) => ({ ...prev, [kind]: value }))
        }
      />
    </div>
  );
}

const meta = {
  title: 'Components/AgentConfigList',
  component: AgentConfigListDemo,
  args: {
    clis: READY_CLIS,
    onBrowse: () => undefined,
  },
} satisfies Meta<typeof AgentConfigListDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Detecting: Story = {
  args: { clis: null },
};

export const NotFound: Story = {
  args: {
    clis: [
      {
        kind: 'claude',
        found: false,
        path: null,
        version: null,
        loggedIn: null,
        update: NO_UPDATE_INFO,
      },
      {
        kind: 'cursor-agent',
        found: false,
        path: null,
        version: null,
        loggedIn: null,
        update: NO_UPDATE_INFO,
      },
    ],
  },
};

/** A machine without claude: the card offers its vendor's installer. */
const MISSING_CLAUDE: CliDetection[] = [
  {
    kind: 'claude',
    found: false,
    path: null,
    version: null,
    loggedIn: null,
    update: NO_UPDATE_INFO,
  },
  ...READY_CLIS.filter((cli) => cli.kind !== 'claude'),
];

export const Installable: Story = {
  args: { clis: MISSING_CLAUDE, onInstall: () => undefined },
};

export const Installing: Story = {
  args: {
    clis: MISSING_CLAUDE,
    onInstall: () => undefined,
    installing: new Set(['claude'] as const),
  },
};

export const InstallFailed: Story = {
  args: {
    clis: MISSING_CLAUDE,
    onInstall: () => undefined,
    installResults: {
      claude: {
        kind: 'claude',
        ok: false,
        version: null,
        path: null,
        output: 'Downloading…\ncurl: (6) Could not resolve host: claude.ai',
        reason: 'curl: (6) Could not resolve host: claude.ai',
      },
    },
  },
};

export const SignedOut: Story = {
  args: {
    clis: SIGNED_OUT_CLIS,
    onSignIn: () => undefined,
    onSignOut: () => undefined,
  },
};

/**
 * The update band. cursor answered that a newer version exists and names it;
 * claude cannot be asked and says why, keeping its button because running the
 * updater IS its only check.
 */
export const UpdateAvailable: Story = {
  args: {
    clis: UPDATE_CLIS,
    onUpdate: () => undefined,
  },
};

/** Mid-install. The button is disabled as well as spinning. */
export const Updating: Story = {
  args: {
    clis: UPDATE_CLIS,
    onUpdate: () => undefined,
    updating: new Set(['cursor-agent'] as const),
  },
};

/**
 * After the press — one CLI moved, the other was already current. Both
 * sentences come from the two version reads, so neither claims more than was
 * measured, and neither card offers the button again.
 */
export const Updated: Story = {
  args: {
    clis: UPDATE_CLIS,
    onUpdate: () => undefined,
    updateResults: {
      claude: {
        kind: 'claude',
        ok: true,
        previousVersion: '2.1.235',
        version: '2.1.235',
        output: null,
        reason: null,
      },
      'cursor-agent': {
        kind: 'cursor-agent',
        ok: true,
        previousVersion: '2026.08.11',
        version: '2026.09.02-c22c1a3',
        output: null,
        reason: null,
      },
    },
  },
};

/**
 * A failed update keeps the button and says why beneath it; the CLI's whole
 * output rides that line's hover.
 */
export const UpdateFailed: Story = {
  args: {
    clis: UPDATE_CLIS,
    onUpdate: () => undefined,
    updateResults: {
      'cursor-agent': {
        kind: 'cursor-agent',
        ok: false,
        previousVersion: '2026.08.11',
        version: '2026.08.11',
        output: 'error: could not write to /usr/local/bin — permission denied',
        reason:
          "cursor-agent's updater has no permission to write /usr/local/bin.",
      },
    },
  },
};

export const SigningIn: Story = {
  args: {
    clis: SIGNED_OUT_CLIS,
    onSignIn: () => undefined,
    onSignOut: () => undefined,
    signingIn: 'claude',
    login: {
      kind: 'claude',
      session: {
        id: 'session-1',
        agent: 'claude',
        status: 'waiting',
        url: 'https://claude.ai/oauth/authorize?code=abc123',
        message: null,
      },
      error: null,
      onSubmitCode: () => undefined,
      onCancel: () => undefined,
      onDismiss: () => undefined,
    },
  },
};
