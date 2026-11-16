import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  BROWSER_TAB_NAME_MAX,
  BROWSER_TAB_NAME_PATTERN,
  CLI_KINDS,
  type CliKind,
  hasControlCharacters,
  HISTORY_PAGE_SIZES,
  isReplyLanguage,
  MAX_AUTO_COMPACT_PERCENT,
  MAX_CONFIG_PROFILE_NAME,
  MAX_CONFIG_PROFILES,
  MAX_FAST_ACTION_NAME,
  MAX_FAST_ACTION_TEXT,
  MAX_FAST_ACTIONS,
  MAX_KEPT_SESSION_IDLE_MINUTES,
  MAX_RUN_CONFIG_NAME,
  MAX_RUN_CONFIGS,
  MIN_AUTO_COMPACT_PERCENT,
  MIN_KEPT_SESSION_IDLE_MINUTES,
  PROFILE_COLORS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
} from '../shared/contracts';
import { THEME_PREFERENCES } from '../shared/themes';

/**
 * Runtime validation for IPC payloads. The renderer is the only caller today,
 * but IPC input is untrusted by default (a compromised renderer, a future
 * frame), and some of it reaches privileged sinks — `cliPaths[kind]` becomes an
 * `execFile` target in cli-detect.ts, `projectFolder` is persisted. These
 * schemas are validated in the main process before any use.
 *
 * Kept main-side (not in shared/contracts.ts) on purpose: contracts.ts is
 * imported by the preload, which must stay dependency-free so its sandboxed
 * bundle pulls in nothing but `electron`.
 */

/**
 * A non-empty, absolute filesystem path. Bounded HERE rather than per-field, so
 * no persisted path can slip through unbounded; 1024 is generous against any
 * real `PATH_MAX`.
 */
const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => isAbsolute(p), 'must be an absolute path');

const cliKind = z.enum(CLI_KINDS as unknown as [CliKind, ...CliKind[]]);

/**
 * A git branch name. `git switch` takes this as an argv entry (no shell), so
 * the real risk is not injection but ARGUMENT injection: a name beginning with
 * `-` would be parsed as a flag. Git's own ref format forbids most of what is
 * rejected here anyway — this is the boundary that makes it true regardless of
 * what the renderer sends.
 *
 * Declared ABOVE `settingsPatchSchema`, which embeds it: `z.strictObject`
 * evaluates its shape immediately, so a reference to a `const` declared further
 * down is a temporal-dead-zone error at module load, not a type error.
 */
/**
 * One CLI kind, for a channel whose whole argument is which agent it is about.
 * The renderer is the untrusted side of this boundary, and this is what stops
 * an arbitrary string reaching a `Record<CliKind, string[]>` lookup as argv.
 */
export const cliKindSchema = cliKind;

/** How old a sign-in and install reading the caller will take; absent asks afresh. */
export const detectClisOptionsSchema = z.strictObject({
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional(),
});

export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((b) => !b.startsWith('-'), 'must not start with a dash')
  // The characters git itself forbids in a refname. A dash is NOT among them —
  // `feat/some-branch` is the common case; only a LEADING dash is the hazard.
  // eslint-disable-next-line no-control-regex -- control characters are precisely what a refname may not contain
  .refine((b) => !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(b), 'invalid refname')
  .refine((b) => !b.includes('..') && !b.includes('@{'), 'invalid refname');

/** The composer target: a CLI kind, or `team:<slug>` for a library team. */
const chatTarget = z.union([
  cliKind,
  z
    .string()
    .max(128)
    .regex(/^team:.+/),
]);

/**
 * One saved new-chat setup (`RunConfig` in shared/contracts.ts).
 *
 * Every field is bounded rather than merely typed: these are persisted, and two
 * reach privileged sinks — `cwd` is handed to the daemon and to `git`, and
 * `branch` becomes an argv entry of `git switch`, so it reuses that channel's
 * own refname schema rather than a looser copy. The daemon-vocabulary fields
 * stay OPAQUE, like their single-value counterparts above.
 */
const runConfigSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_RUN_CONFIG_NAME),
  cwd: absolutePath,
  branch: branchNameSchema.nullable(),
  target: chatTarget,
  model: z.string().min(1).max(64).nullable(),
  effort: z.string().min(1).max(64).nullable(),
  contextWindow: z.string().min(1).max(64).nullable(),
  modelParameters: z.record(
    z.string().min(1).max(64),
    z.string().min(1).max(200),
  ),
  approval: z.string().min(1).max(32).nullable(),
  configDir: absolutePath.nullable(),
  projectId: z.string().min(1).max(64).nullable().optional(),
});

/**
 * One fast action (`FastAction` in shared/contracts.ts).
 *
 * Bounded rather than merely typed, because these are persisted and the
 * description is written straight into a message box — a field with no ceiling
 * is a renderer bug away from a settings.json nothing can open. `strictObject`
 * is what keeps a stale entry from an older shape alive in the file: the read
 * path grades one entry at a time and drops what no longer parses.
 */
const fastActionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_FAST_ACTION_NAME),
  description: z.string().min(1).max(MAX_FAST_ACTION_TEXT),
});

/**
 * One named agent configuration (`ConfigProfile` in shared/contracts.ts).
 *
 * `strictObject` and bounded, on the same terms as the fast action above: these
 * are persisted, the read path grades one entry at a time, and a field with no
 * ceiling is a renderer bug away from a settings.json nothing can open. The
 * COLOUR is enumerated rather than a bounded string — unlike the daemon
 * vocabularies elsewhere in this file, this palette is the app's own, so an
 * unknown value is a bug here rather than a version skew to tolerate.
 */
const configProfileSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_CONFIG_PROFILE_NAME),
  agent: cliKind,
  dir: absolutePath,
  color: z.enum(PROFILE_COLORS),
});

/** Characters only a shell gives meaning to — refused in a share command's argv. */
const SHELL_METACHARACTERS = /[|;&$`<>\\\n\r*?(){}[\]!~#'"]/;
const SHELL_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'env',
]);

const shareArgvSchema = z
  .array(z.string().min(1).max(500))
  .min(1)
  .max(40)
  .refine(
    (tokens) =>
      tokens.every(
        (token) =>
          !SHELL_METACHARACTERS.test(
            token.split('{file}').join('').split('{object}').join(''),
          ),
      ),
    { message: 'a command token may not contain shell characters' },
  )
  .refine((tokens) => !SHELL_PROGRAMS.has(tokens[0]?.split('/').pop() ?? ''), {
    message: 'a destination command may not be a shell',
  });

const objectPrefixSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => !value.split('/').includes('..'));

const bucketSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/);

/** A custom destination's sign-in: login argv and the output that means "signed out". */
export const shareSignInSchema = z.strictObject({
  login: shareArgvSchema.optional(),
  patterns: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});

const destinationBase = {
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  linkBase: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'the link base must be an https URL',
    }),
};

/**
 * One share destination (`ShareDestination` in shared/contracts.ts).
 *
 * TWIN PARSER: `ShareDestinationSchema` in
 * `apps/daemon/src/v1/shares/shares.types.ts`. Restated rather than shared —
 * main imports no daemon source — and kept to the SAME limits, because a value
 * this accepts and the daemon refuses would leave sharing silently off.
 */
export const shareDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('gcs'),
    ...destinationBase,
    bucket: bucketSchema,
    prefix: objectPrefixSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('s3'),
    ...destinationBase,
    bucket: bucketSchema,
    prefix: objectPrefixSchema.optional(),
    profile: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    region: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('command'),
    ...destinationBase,
    upload: shareArgvSchema,
    remove: shareArgvSchema,
    signIn: shareSignInSchema.optional(),
  }),
]);

export const MAX_SHARE_DESTINATIONS = 20;

/** Twin of `MAX_AUTO_REVOKE_DAYS` in `apps/daemon/src/v1/shares/shares.types.ts`. */
export const MAX_AUTO_REVOKE_DAYS = 3650;

export const autoRevokeAfterDaysSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_AUTO_REVOKE_DAYS)
  .nullable();

export const sharingSchema = z.strictObject({
  destinations: z.array(shareDestinationSchema).max(MAX_SHARE_DESTINATIONS),
  defaultDestinationId: z.string().min(1).max(64).nullable(),
  agentsMayShare: z.boolean(),
  autoRevokeAfterDays: autoRevokeAfterDaysSchema,
});

/**
 * TWIN PARSER: `MemoryConfigSchema` in `apps/daemon/src/v1/memory/memory.types.ts`
 * is this plus the top-level `memoryAutoForgetAfterDays`, pushed as
 * `autoForgetAfterDays`. `memory-config-push.ts` pushes both together.
 */
export const memorySchema = z.strictObject({
  enabled: z.boolean(),
  agentWrites: z.enum(['active', 'pending']),
  nativeMemoryOff: z.boolean(),
});

/**
 * TWIN PARSER: `LessonsConfigSchema` in `apps/daemon/src/v1/lessons/lessons.types.ts`,
 * which `lessons-config-push.ts` pushes this to.
 */
export const lessonsSchema = z.strictObject({
  mode: z.enum(['off', 'offer']),
  agentKind: z.string().min(1).max(64).nullable(),
  model: z.string().min(1).max(200).nullable(),
  effort: z.string().min(1).max(50).nullable(),
});

/** Twin of the day bound in `MemoryConfigSchema` (`apps/daemon/src/v1/memory/memory.types.ts`). */
const MAX_AUTO_FORGET_DAYS = 3650;

const autoForgetAfterDaysSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_AUTO_FORGET_DAYS)
  .nullable();

/**
 * TWIN PARSER: `KnowledgeConfigSchema` in `apps/daemon/src/v1/knowledge/knowledge.types.ts`,
 * which `knowledge-config-push.ts` pushes this to.
 */
export const knowledgeSchema = z.strictObject({
  enabled: z.boolean(),
  agentWrites: z.enum(['review', 'direct', 'off']),
});

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/**
 * TWIN PARSER: `ResourceAlertConfigSchema` in `apps/daemon/src/v1/agents/chat.types.ts`,
 * which `resource-alerts-config-push.ts` pushes this to.
 */
export const resourceAlertsSchema = z.strictObject({
  enabled: z.boolean(),
  threadMemoryBytes: z
    .number()
    .int()
    .min(256 * MIB)
    .max(1024 * GIB),
  growthBytesPerMinute: z
    .number()
    .int()
    .min(64 * MIB)
    .max(1024 * GIB),
  minFreeDiskBytes: z
    .number()
    .int()
    .min(256 * MIB)
    .max(1024 * GIB),
});

/**
 * A `Partial<Settings>` patch. `strictObject` rejects unknown keys, so the
 * renderer can't write arbitrary fields into settings.json.
 */
export const settingsPatchSchema = z.strictObject({
  onboardingComplete: z.boolean().optional(),
  onboardingProgress: z
    .strictObject({
      step: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      agent: cliKind.nullable(),
      route: z.enum(['chat', 'team', 'explore']),
      teamMethod: z.enum(['ai', 'example', 'graph', 'import']),
      brief: z.string().max(4000),
    })
    .nullable()
    .optional(),
  projectFolder: absolutePath.nullable().optional(),
  recentFolders: z.array(absolutePath).max(10).optional(),
  // Per CLI, and sparse: a CLI with no entry is on its own default profile,
  // which is how the composer writes "no config directory" back.
  configDirs: z.partialRecord(cliKind, absolutePath).optional(),
  recentConfigDirs: z
    .partialRecord(cliKind, z.array(absolutePath).max(10))
    .optional(),
  // The user's saved new-chat setups. Hand-managed rather than auto-evicted, so
  // the cap is a guard against a renderer bug growing settings.json without
  // limit, set well above any plausible number of real configurations.
  runConfigs: z.array(runConfigSchema).max(MAX_RUN_CONFIGS).optional(),
  // The user's fast actions. Hand-managed rather than auto-evicted, so the cap
  // is a guard against a renderer bug growing settings.json without limit, set
  // well above any plausible number of real ones.
  fastActions: z.array(fastActionSchema).max(MAX_FAST_ACTIONS).optional(),
  // The user's named agent configurations. Hand-managed like the two above, so
  // the cap is the same kind of guard rather than a limit anyone will meet.
  configProfiles: z
    .array(configProfileSchema)
    .max(MAX_CONFIG_PROFILES)
    .optional(),
  lastChatTarget: chatTarget.nullable().optional(),
  // The daemon's ChatApprovalMode, kept OPAQUE here: its vocabulary belongs to
  // the daemon, and the main process holds no daemon shapes. Bounded so a
  // renderer bug can't grow settings.json without limit; the renderer checks
  // the value against the generated enum before it reaches a run.
  lastApprovalMode: z.string().min(1).max(32).nullable().optional(),
  // Model aliases are the CLIs' vocabulary, not ours — bounded, not enumerated,
  // so a CLI adding an alias needs no change here.
  lastModels: z.partialRecord(cliKind, z.string().min(1).max(64)).optional(),
  // Effort levels are likewise the CLIs' own vocabulary (claude accepts one
  // its --help does not even list), so they are bounded, never enumerated.
  lastEfforts: z.partialRecord(cliKind, z.string().min(1).max(64)).optional(),
  // Window sizes are the CLIs' own words too (`300k`, `1m`, `272k`), and
  // per MODEL rather than per CLI — bounded here, never enumerated.
  lastContextWindows: z
    .partialRecord(cliKind, z.string().min(1).max(64))
    .optional(),
  // The daemon's own bounds, twinned in contracts.ts, so a remembered threshold
  // can never be one the next chat create refuses.
  lastAutoCompactPercent: z
    .number()
    .int()
    .min(MIN_AUTO_COMPACT_PERCENT)
    .max(MAX_AUTO_COMPACT_PERCENT)
    .nullable()
    .optional(),
  lastAnalysisConfig: z
    .strictObject({
      agent: cliKind,
      configDir: absolutePath.nullable(),
      model: z.string().min(1).max(64).nullable(),
      effort: z.string().min(1).max(64).nullable(),
      // These four are defaulted, so a choice saved before they were part of it
      // still reads (a missing mode as auto-approve) rather than being dropped whole.
      contextWindow: z.string().min(1).max(64).nullable().default(null),
      autoCompactPercent: z
        .number()
        .int()
        .min(MIN_AUTO_COMPACT_PERCENT)
        .max(MAX_AUTO_COMPACT_PERCENT)
        .nullable()
        .default(null),
      modelParameters: z
        .record(z.string().min(1).max(64), z.string().min(1).max(200))
        .default({}),
      approval: z.string().min(1).max(32).nullable().default(null),
    })
    .nullable()
    .optional(),
  lastChangeChatApproval: z.string().min(1).max(32).nullable().optional(),
  lastMemoryTriage: z
    .strictObject({
      agent: cliKind,
      configDir: absolutePath.nullable(),
      model: z.string().min(1).max(64).nullable(),
      effort: z.string().min(1).max(64).nullable(),
      contextWindow: z.string().min(1).max(64).nullable(),
      modelParameters: z.record(
        z.string().min(1).max(64),
        z.string().min(1).max(200),
      ),
    })
    .nullable()
    .optional(),
  // The OTHER model settings, per CLI, as `{parameterId: value}`. Both halves
  // are the CLI's own words (`optimize_for` → `balanced`), so both are bounded
  // and neither is enumerated — this app holds no vocabulary for them at all.
  lastModelParameters: z
    .partialRecord(
      cliKind,
      z.record(z.string().min(1).max(64), z.string().min(1).max(200)),
    )
    .optional(),
  // partialRecord, not record: in zod v4 z.record over an enum key is
  // exhaustive (would require every CliKind present); cliPaths is sparse.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
  checkForUpdates: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  remoteAccessEnabled: z.boolean().optional(),
  sharing: sharingSchema.optional(),
  memory: memorySchema.optional(),
  lessons: lessonsSchema.optional(),
  knowledge: knowledgeSchema.optional(),
  resourceAlerts: resourceAlertsSchema.optional(),
  // The retention window, or null for "keep the archive". Bounded to exactly
  // what the daemon's own schema accepts, so a value this side lets through can
  // never be one that route refuses — and NULLABLE rather than absent, because
  // absent means "this patch does not mention it" while null is the user
  // switching the sweep off, and those must not be the same write.
  archiveRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  // The auto-forget window, bounded and nullable like the retention window
  // above: null switches the daemon's sweep off, absent leaves it as it is.
  memoryAutoForgetAfterDays: autoForgetAfterDaysSchema.optional(),
  // ENUMERATED, like `theme`: a size outside the list is one the screen never
  // offered, and a file written by another build falls back to the default.
  historyPageSize: z.literal(HISTORY_PAGE_SIZES).optional(),
  // Bounded to exactly what the daemon's `KeptSessionConfigSchema` accepts, so
  // a value this side lets through is never one the push is refused for.
  keptSessionIdleMinutes: z
    .number()
    .int()
    .min(MIN_KEPT_SESSION_IDLE_MINUTES)
    .max(MAX_KEPT_SESSION_IDLE_MINUTES)
    .optional(),
  preventSleepWhileWorking: z.boolean().optional(),
  // Each CLI's own switches (`AdapterConfig.options` in the daemon), as
  // `{optionId: on}`. The ids are the CLI's, published on the capabilities
  // wire, so this side bounds them and enumerates none.
  agentOptions: z
    .partialRecord(cliKind, z.record(z.string().min(1).max(128), z.boolean()))
    .optional(),
  collapseToolSteps: z.boolean().optional(),
  // The user's own prose — no length limit, but screened for CONTROL
  // CHARACTERS: the value ends up in a spawned CLI's argv, node rejects a NUL
  // there synchronously, and the daemon refuses the whole range at its own
  // edge.
  //
  // The check is mirrored here rather than left to the daemon because this
  // is the WRITE the user makes. A value stored here and refused there turns
  // one invisible pasted character (Word and Notes emit U+000B for a soft line
  // break) into a 400 on every new chat and team run, surfacing in the
  // composer with nothing pointing back at the settings box holding it.
  customInstructions: z
    .string()
    .refine(
      (value) => !hasControlCharacters(value),
      'must not contain control characters',
    )
    .optional(),
  // Checked for the same reason, against the daemon's own twin.
  replyLanguage: z
    .string()
    .refine(
      isReplyLanguage,
      'must be one short line, without control, invisible or bidirectional characters',
    )
    .optional(),
  // ENUMERATED, unlike the CLI-vocabulary fields above, because this
  // vocabulary is the app's own: a theme is a file this repo ships, so a value
  // outside the list names nothing that can be painted. `THEME_PREFERENCES` is
  // the same tuple the picker is built from, so the two cannot drift.
  theme: z.enum(THEME_PREFERENCES).optional(),
  // Nullable, not just optional: `null` is the "unchosen, resolve per build"
  // state, and it must be writable so a user can hand the choice back.
  daemonInspect: z.boolean().nullable().optional(),
});

/**
 * Any C0 or DEL control character — the bar for a FILE NAME.
 *
 * Stricter than {@link hasControlCharacters}, which this schema module uses for
 * prose (a settings box, where a tab or a newline is ordinary text and must be
 * allowed through). A file name carries neither, and one of them reaching
 * `showSaveDialog`'s `defaultPath` puts a value this process cannot see rendered
 * into a native panel it does not paint.
 *
 * A code-point scan rather than a regex, for the two reasons the sibling states:
 * raw bytes in the source make git classify the file as binary and the
 * `pre-commit` hook refuses it, and the escapes trip eslint's `no-control-regex`.
 */
function hasFilenameControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** A directory a git command may run in. */
export const gitDirSchema = absolutePath;

/**
 * Where the folder picker OPENS: the folder the field already holds, or
 * nothing. It only positions a native dialog, so the handler IGNORES a value
 * that fails this rather than refusing the press — a refusal would leave the
 * control that opens the picker dead.
 */
export const pickFolderStartSchema = absolutePath.optional();

/**
 * A task id on its way into a BRANCH NAME and a directory name.
 *
 * Held to the id alphabet rather than to "a non-blank string", because this
 * value becomes both a git ref (`geniro/task-<id>`) and a path segment under
 * the userData dir. The daemon mints these as UUIDs; anything carrying a
 * slash, a dot-dot or whitespace is not one and has no business reaching
 * either use. This is a different process validating input it may not assume
 * anyone else checked.
 */
export const taskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

/**
 * One name directly inside the data folder (or its worktrees directory), on
 * its way into a `join` and a delete: one segment, never `.`, `..`, a
 * separator or a NUL, so it cannot name anything outside the directory.
 */
export const storageEntryNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      !name.includes('/') &&
      !name.includes('\u0000'),
    'not a single file name',
  );

/** The daemon's `unclaimed` names, handed on by the renderer. */
export const storageEntryNamesSchema = z
  .array(storageEntryNameSchema)
  .max(2000);

/** Which task to make a worktree for, and the repository to cut it from. */
export const taskWorktreeSchema = z.object({
  taskId: taskIdSchema,
  folder: absolutePath,
});

/**
 * A commit id on its way to `git` as an ARGUMENT.
 *
 * Held to the exact shape `rev-parse` prints rather than merely to "a string":
 * a revision expression is a small language (`@{upstream}`, `HEAD~3`, `:/text`),
 * and the only thing this channel has any business resolving is a commit the app
 * itself stamped. It is the same bound the daemon puts on the column
 * (`createChatSchema`), stated again here because this is a different process
 * validating input it may not assume anyone else checked.
 */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** `getChangesSince`'s optional third argument — see `readChangesSince`. */
export const workFolderFlagSchema = z.boolean().optional();

/** An instant as epoch milliseconds — `listWorktrees`' thread start. */
export const epochMsSchema = z.number().int().nonnegative();

/**
 * How many pull requests one resolve may be asked about.
 *
 * The renderer batches every thread on screen into one call, so this bounds
 * the whole sidebar rather than one conversation; the resolve itself is bounded
 * again, and more tightly, by repository count (`github-prs.ts`).
 */
const MAX_PULL_REQUEST_REFS = 500;

/**
 * The pull requests a thread opened, as the renderer asks about them.
 *
 * Shape-validated rather than trusted because `owner`, `repo` and `url` become
 * ARGV for `gh`. A leading dash would be read as a flag, so it is refused here
 * rather than relied on being passed as its own token — and `url` must be a
 * github.com pull-request URL, since `gh pr view <url>` accepts a URL and the
 * only thing that should ever reach it is one this app's own capture produced.
 */
const pullRequestSegment = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][\w.-]*$/u, 'must be a GitHub owner or repository name');

export const pullRequestRefsSchema = z
  .array(
    z.object({
      owner: pullRequestSegment,
      repo: pullRequestSegment,
      number: z.number().int().positive(),
      url: z
        .string()
        .regex(
          /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*\/pull\/\d+$/u,
          'must be a github.com pull request URL',
        ),
    }),
  )
  .max(MAX_PULL_REQUEST_REFS);

const changesPullRequestSchema = z.object({
  repository: z.string().refine((value) => {
    const segments = value.split('/');
    return (
      segments.length === 2 &&
      segments.every((part) => pullRequestSegment.safeParse(part).success)
    );
  }, 'must be owner/repo'),
  headRefName: branchNameSchema,
  headRefOid: commitShaSchema.optional(),
  baseRefName: branchNameSchema,
});

/** Each pull request can cost a few git processes on every read of a folder. */
const MAX_CHANGES_PULL_REQUESTS = 32;

/**
 * `getChangesSince`'s optional fourth argument. Row by row, because a list that
 * refused as a whole would cost the read itself, and the rows are only a better
 * base than the default branch.
 */
export const changesPullRequestsSchema = z
  .array(z.unknown())
  .optional()
  .transform((rows = []) =>
    rows
      .flatMap((row) => {
        const parsed = changesPullRequestSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      })
      .slice(0, MAX_CHANGES_PULL_REQUESTS),
  );

/**
 * A file the renderer asks to be revealed in Finder.
 *
 * Shape only — an absolute path. Being inside the daemon's log directory is
 * the SECURITY check and lives in `revealPath`, where the boundary it is
 * compared against is resolved: a schema cannot know where that directory is,
 * and one that pretended to would give a false sense of where the gate is.
 */
export const revealPathSchema = absolutePath;

/** A terminal tab's id — minted by the renderer, so held to a UUID's shape. */
export const terminalIdSchema = z.uuid();

const terminalCols = z.number().int().min(1).max(TERMINAL_MAX_COLS);
const terminalRows = z.number().int().min(1).max(TERMINAL_MAX_ROWS);

/**
 * One tab's shell. No command and no env: the program is always the user's
 * own login shell, so what arrives here only says WHERE it starts.
 */
export const terminalCreateSchema = z.strictObject({
  id: terminalIdSchema,
  cwd: absolutePath.optional(),
  cols: terminalCols,
  rows: terminalRows,
});

/** Bounded so one IPC message cannot carry an unbounded paste. */
export const terminalWriteDataSchema = z.string().max(1_000_000);
export const terminalColsSchema = terminalCols;
/** One acknowledged batch — never more than a flushed batch could hold. */
export const terminalAckCharsSchema = z.number().int().min(0).max(10_000_000);
/** The id a quit-time flush was asked under — main makes it, so only its size is bounded. */
export const lineFlushRequestIdSchema = z.string().min(1).max(64);
export const terminalRowsSchema = terminalRows;

/**
 * A chat export on its way to disk: the file name to suggest, and BOTH
 * renderings of the document.
 *
 * The NAME is held to a bare filename, and that is the whole of the validation
 * here — it is the field that reaches a PATH (`showSaveDialog`'s `defaultPath`),
 * so a separator or a `..` in it would open the dialog somewhere the user did
 * not ask to be. Control characters go with them: the value is drawn in a native
 * dialog this process does not paint. It carries no extension: main appends the
 * one matching the filter it opens on (`save-chat-export.ts`).
 *
 * Two documents rather than one because the FORMAT is chosen in the save panel,
 * which only main can read — see that file for why the alternatives are worse.
 * Both are bounded in SHAPE and deliberately not in LENGTH, which is the one
 * departure from this module's own rule: they are this app's own export
 * document, already materialized in renderer memory to be sent, and their
 * destination is a path the USER picked in a native dialog — so a cap would buy
 * no safety and would refuse exactly the long conversations the feature exists
 * for (a real transcript runs to tens of megabytes).
 */
/**
 * A bare file name on its way to a save panel — shared by every save channel,
 * because the thing being guarded is the same on all of them: this is the field
 * that reaches a PATH (`showSaveDialog`'s `defaultPath`), so a separator or a
 * `..` in it would open the dialog somewhere the user did not ask to be.
 *
 * It carries no extension: main appends the one matching the filter it opens
 * on, so the name the panel shows and the format it is set to cannot disagree.
 */
export const saveFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\'), {
    message: 'must be a bare file name, not a path',
  })
  .refine((name) => name !== '.' && name !== '..', {
    message: 'must name a file',
  })
  // Its OWN screen rather than `hasControlCharacters`, which was written for
  // PROSE and therefore whitelists tab, newline and carriage return — legal in
  // a settings box, not in a file name that reaches `showSaveDialog`'s
  // `defaultPath`. The predicate is a code-point scan for the same two reasons
  // that one gives: a raw byte in the source makes git treat the file as
  // binary, and the escape trips eslint's `no-control-regex`.
  .refine((name) => !hasFilenameControlCharacters(name), {
    message: 'must not contain control characters',
  });

export const chatExportSaveSchema = z.strictObject({
  suggestedName: saveFileNameSchema,
  json: z.string(),
  markdown: z.string(),
});

/**
 * A published artifact on its way to disk: the name to suggest and the one
 * document.
 *
 * ONE rendering where the chat export carries two, because there is no format
 * to choose — an artifact is the HTML the agent wrote. The body is bounded in
 * SHAPE and deliberately not in LENGTH, on `chatExportSaveSchema`'s reasoning:
 * it is this app's own document, already in renderer memory to be sent, bound
 * for a path the USER picked in a native dialog, and the daemon has already
 * held it to `MAX_ARTIFACT_HTML_BYTES` on the way in.
 */
export const artifactSaveSchema = z.strictObject({
  suggestedName: saveFileNameSchema,
  html: z.string(),
});

/**
 * The shared-memory export on its way to disk: the Markdown the daemon
 * rendered. No name field — main composes the suggested name itself, so nothing
 * the renderer sends reaches the dialog's path. Unbounded, like the artifact
 * save: the memory holds as many entries as were saved or imported.
 */
export const memoryExportSaveSchema = z.string();

/** A knowledge export on its way to disk, under a name the daemon composed. */
export const knowledgeExportSaveSchema = z.strictObject({
  suggestedName: saveFileNameSchema,
  markdown: z.string(),
});
export type KnowledgeExportSave = z.infer<typeof knowledgeExportSaveSchema>;

/**
 * One system notification the renderer asks main to post.
 *
 * Bounded rather than merely typed, because both strings land in an OS surface
 * this process does not draw and cannot clip: a title is a thread's own name
 * (which the user typed) and a body is composed from it. The lengths are what
 * macOS will show anyway — a longer one is truncated by the notification
 * centre, so nothing is lost by refusing it here, and a renderer that has been
 * tampered with cannot hand the window server a megabyte.
 */
export const notificationSchema = z
  .strictObject({
    kind: z.enum(['question', 'turn-end', 'share-sign-in', 'resource-alert']),
    runId: z.string().max(128),
    title: z.string().min(1).max(120),
    body: z.string().max(240),
    retractable: z.boolean().optional(),
  })
  .refine(
    (notification) =>
      notification.runId !== '' || notification.kind === 'resource-alert',
    { message: 'only a resource alert may name no thread', path: ['runId'] },
  );

/** The run whose retractable banner is withdrawn — bounded like a post's. */
export const retractNotificationSchema = z.string().min(1).max(128);

/** Onboarding payload committed in a single IPC call. */
export const onboardingInputSchema = z.strictObject({
  lastChatTarget: cliKind.optional(),
  // Per-agent binary overrides; each becomes an `execFile` target in
  // cli-detect.ts, so it must be a validated absolute path.
  cliPaths: z.partialRecord(cliKind, absolutePath).optional(),
});

/**
 * The handoff invocation, as DATA — a command, its arguments and a folder,
 * never a shell string. The main process writes them into a script it quotes
 * itself, so a renderer that has been tampered with cannot append a second
 * command to a line.
 */
export const openTerminalSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: absolutePath,
  /**
   * Env for that one invocation (the run's config directory). Validated in
   * SHAPE only — the daemon composed it and owns which vars mean what — but
   * bounded, since these become assignments in a script this process writes.
   *
   * The NAME is held to a shell identifier, not merely to a length. It is the
   * one field on this channel that reaches the generated script UNQUOTED (twice:
   * `NAME=value` and `export NAME`), because quoting an assignment's left side
   * would make the shell hunt for a command called `NAME=value`. A length bound
   * alone admitted a newline, so `A=1\nrm -rf …` was a well-formed name — and
   * the point of this schema is a renderer that has been tampered with.
   */
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      z.string().max(4096),
    )
    .optional(),
});

export const browserRunIdSchema = z.string().min(1).max(128);
export const browserTabIdSchema = z.string().min(1).max(128);
export const browserAddressSchema = z.string().max(8192);
export const browserOpenUrlSchema = browserAddressSchema.nullable();
export const browserHistoryActionSchema = z.enum([
  'back',
  'forward',
  'reload',
  'stop',
]);
export const browserTabActionSchema = z.enum([
  'devtools',
  'clearCookies',
  'openExternal',
  'copyUrl',
]);
export const browserPopOutTitleSchema = z.string().max(256);

export const browserTabLabelSchema = z.strictObject({
  name: z
    .string()
    .max(BROWSER_TAB_NAME_MAX)
    .regex(BROWSER_TAB_NAME_PATTERN)
    .nullable()
    .optional(),
  color: z.enum(PROFILE_COLORS).nullable().optional(),
});

const browserLength = z.number().finite().min(0).max(100_000);
export const browserBoundsSchema = z
  .strictObject({
    x: browserLength,
    y: browserLength,
    width: browserLength,
    height: browserLength,
  })
  .nullable();

export const browserCredentialsSchema = z
  .strictObject({
    username: z.string().max(1024),
    password: z.string().max(4096),
  })
  .nullable();
