import { dirname } from 'node:path';

import {
  BUILDER_CHAT_ANALYSED_RUNS,
  HOST_BACKUP_TEAM_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
} from '../../agents/chat.types';
import {
  ANY_TEAM_OR_PROJECT,
  WHAT_GOES_WHERE,
} from '../../agents/utils/any-team-or-project';
import { builderChatAnalysisGuide } from '../../agents/utils/thread-analysis-guide';
import {
  type ApprovalMode,
  ApprovalModeSchema,
  TEAM_MODES,
  type TeamMode,
} from '../teams.types';

/**
 * What geniro tells the agent behind the team builder's chat panel.
 *
 * The panel's promise is that the user describes a change in prose, sees
 * what the agent would change and why, and the team on screen changes once
 * they approve — or, on an empty team, that a whole team appears. So the
 * agent needs: which team is its subject, that a change proposed through
 * `propose_team` IS the deliverable (its card, checks and version pin are
 * why the agent never writes the file itself), the document's structure, what
 * the structure DOES when it runs, and how to write the text inside it —
 * every role, instructions field and instruction block is itself agent
 * instructions, held to the same rules as any other instruction file.
 *
 * Nothing here restates a field list. The structure is a JSON Schema generated
 * from the validator (`teamJsonSchema`), and the brief only points at it,
 * because a hand-written field list drifts the first time a field is added.
 * What the schema cannot carry is rendered from the constants that define it:
 * the meaning of each mode and approval mode is a `Record` over that enum, so
 * a new one fails the build until it is described here. The team rules are
 * `team-validate.ts`'s, stated in prose — change one there, change it here.
 */

/** What each coordination mode means for a run. */
const MODE_MEANING: Record<TeamMode, string> = {
  lead: 'the member the first message goes to runs the whole job and calls the others as it decides; the others run only when called. The only mode a run takes today.',
  relay:
    'each stage is run by its first responsible member and handed on to the next stage’s — not available yet; a team set to it does not start.',
};

/** What each approval mode means for a run. */
const APPROVAL_MEANING: Record<ApprovalMode, string> = {
  auto: 'runs its tools unattended',
  ask: 'stops at every tool permission until a person answers',
  acceptEdits: 'approves its own file edits and asks about everything else',
};

/** What a project overlay may hold, as every chat that writes one is told. */
export const OVERLAY_FORMAT = `The overlay is YAML with these optional sections, all keyed by the team's
own ids:
- \`allMembers\`: per CLI (\`claude\`, \`cursor-agent\`, \`codex\`), the Model group
  every member and team pool entry of that CLI runs with here: \`model\`,
  \`effort\`, \`contextWindow\`, \`modelParameters\`, \`autoCompactPercent\`,
  \`approval\`, \`configDir\`.
- \`members.<memberId>.settings\`: the same Model group plus \`agent\` for one
  member; it beats \`allMembers\`. Setting \`agent\` starts that member's Model
  group over from the new CLI's defaults.
- \`members.<memberId>.pool\`: the member's whole pool in this project
  (members 2, 3, …; \`[]\` = none), each entry shaped like a team pool entry.
- \`members.<memberId>.mcpDisabled\`: the MCP servers that member runs
  without in this project, replacing the team's list whole (\`[]\` = none off).
- \`members.<memberId>.extraInstructions\`: appended to that member's own
  instructions in this project.
- \`instructionBlocks\`: blocks only this project's runs carry, shaped like
  the team's (\`id\`, \`title\`, \`text\`, \`audience\`).

Members, stages, the trigger, the mode, names, roles and avatars are shared
and cannot be changed per project.`;

export interface BuilderOverlayRef {
  projectId: string;
  projectName: string;
  /** Absolute path of `<projectId>.overlay.yaml`, which may not exist yet. */
  path: string;
  /** True while the project's default team is this team. */
  active: boolean;
}

function overlaySection(
  overlay: BuilderOverlayRef | undefined,
  others: readonly BuilderOverlayRef[],
): string {
  const listed =
    others.length === 0
      ? ''
      : `
Other projects' overlays of this team — read them with ${HOST_READ_TEAMS_TOOL}
(\`overlays: true\`) before a shared change, so the change does not break
them:
${others.map((o) => `  - ${o.projectName}${o.active ? '' : ' (inactive)'}`).join('\n')}
`;
  if (overlay === undefined) {
    return listed === ''
      ? ''
      : `
PROJECT OVERLAYS
This chat edits the SHARED team, which every project uses. A project whose
default team this is may add its own overlay on top; what only that project
needs goes there.
${listed}`;
  }
  return `
PROJECT OVERLAY — ${overlay.projectName}
This chat is bound to the project "${overlay.projectName}". The shared team
serves every project; what only this project needs lives in its overlay:

  ${overlay.path}
${
  overlay.active
    ? ''
    : `
The project does not default to this team now, so its runs do not apply the
overlay until it does again.
`
}
${OVERLAY_FORMAT}

Put a change in the overlay when it is about this project only (its paths,
its accounts, its conventions); put it in the shared team when every project
should get it. To move shared text into the overlay, remove it from the
team with edits and add it to the overlay on the same card.

Propose an overlay change with ${HOST_PROPOSE_TEAM_TOOL} too: pass the WHOLE
overlay document as \`overlay\` (read the file first; a missing file is an
empty overlay), alone or beside team edits. Without \`overlayProjectId\` it is
this project's. One card shows both diffs and one approval writes both.
${listed}`;
}

export function composeTeamChatInstructions(input: {
  /** Absolute path of the `*.team.yaml` file this chat edits. */
  path: string;
  /** Its library slug, the name `read_teams` knows it by. */
  slug: string;
  /** The team's own name, as the user sees it in the builder. */
  name: string;
  /** Absolute path of the library's generated JSON Schema. */
  schemaPath: string;
  /** Whether the shared memory is on — it decides the memory recommendations. */
  memory: boolean;
  /** Whether agents may change knowledge — it decides the knowledge recommendations. */
  knowledge?: boolean;
  /**
   * Whether the chat runs in the library directory. A chat opened before the
   * library moved keeps the folder it was created in.
   */
  inLibrary: boolean;
  /** The project overlay an `overlay` naming no project means here; absent in shared scope. */
  overlay?: BuilderOverlayRef;
  /** Every other overlay of this team. */
  otherOverlays?: readonly BuilderOverlayRef[];
}): string {
  return `<team-editing>
You are editing one geniro team through the chat panel docked under the
team builder. The user sees the team on screen while you work.

Your subject is this file:

  ${input.path}

It is the team "${input.name}", slug \`${input.slug}\`. Read it with
${HOST_READ_TEAMS_TOOL}, never with your own file tools. ${
    input.inLibrary
      ? 'Its directory is\nyour working directory and holds'
      : 'Its directory,\n' + dirname(input.path) + ', holds'
  } the user's other teams: read them as
examples (${HOST_READ_TEAMS_TOOL} lists them). This team is what the chat is
about; CHANGING ANY TEAM OR PROJECT below says how to reach the others.

The file's structure — every field, its type, its limits and its allowed
values — is defined by this JSON Schema, generated from the validator geniro
runs on the file:

  ${input.schemaPath}

Read it before you write a field this file does not already use, and before
you build a team from scratch. Where it and your memory disagree, it wins.

HOW TO WORK
- Read the team with ${HOST_READ_TEAMS_TOOL} (slug \`${input.slug}\`) before
  your first change of each turn — the user edits it between your turns. The
  slug alone answers the whole team while it fits one answer, else its
  outline: every member, block and stage with the size of each text. Then
  read every part the change touches (\`members\`, \`blocks\`, \`stages\`)
  and \`search\` for the words the request names, so you find every place
  the subject lives, not only the one the request points at. A change is
  right only against the rest of the team.
- Copy a \`find\` from the text between a field's \`===\` markers, and
  pass that field's path (\`members/<id>/instructions\`) as the edit's
  \`path\`: a short anchor unique in that field is then enough.
- Make every change by proposing it with ${HOST_PROPOSE_TEAM_TOOL}, never
  by writing the file yourself. Pass the edits, a one-line \`summary\` of what
  they change and a \`reason\` saying why — the user's request it answers, or
  what you found in the team that calls for it. The user sees both on a
  card beside the exact difference to the file, and the change is saved, with
  a backup of the file before it, only when they approve. Put everything one
  request needs on one card, then END YOUR TURN: their verdict — approved,
  declined with their note, or not saved and why — arrives as your next
  message. An edit you only describe never happens.
- A change the user asks for goes straight onto a ${HOST_PROPOSE_TEAM_TOOL}
  card, however large. Never file it through ${HOST_RECOMMENDATIONS_TOOL}:
  that card carries an analysis of the team's runs, and only a request to
  analyse or improve the team from its runs asks for one.
- When the user wants rules that only one project needs moved out of the
  team, read the projects that run it with ${HOST_READ_TEAMS_TOOL}
  (\`projects: true\`), then put the team edits that remove the text and
  \`project\` with the blocks that add it on ONE card — one approval writes
  both. Move the text whole; when it does not fit the project's limit, say
  so and ask the user what to drop before you shorten anything.
- Back the file up with ${HOST_BACKUP_TEAM_TOOL} whenever the user asks.
- The one time you open the file yourself: when a proposal answers
  TEAM_UNREADABLE, the file cannot be loaded. Fix only what that
  refusal names, with your own file tools, then propose the change.
- A proposal refused for breaking the schema or the team rules below shows
  no card: fix the edits and propose again. So propose straight away; there
  is nothing to rehearse.
- After a decline, change course as the user's note says and propose again;
  after a "not saved" verdict, read the team again before you do.
- When you rename or remove a member, update the trigger, every block
  audience, every stage's \`responsible\` and every piece of text that names
  it.
- Keep the comments and fields the request does not touch.
- Once a change is approved, say in one or two lines what changed; the
  team view shows the rest.

HOW A TEAM RUNS
A team is a set of members — each one CLI coding agent — and any member may
call any other during its turn, as often as it decides (it is given the call
tools for it). Nothing is wired: who calls whom is the members' decision, made
from what each one's role says. A member never calls one that is waiting on
its own answer.

- \`triggers\`: exactly one, \`{kind: first-message, member: <id>}\` — the
  member the user's first message and every later one go to.
- \`mode\`:
${TEAM_MODES.map((mode) => `  - ${mode}: ${MODE_MEANING[mode]}`).join('\n')}
- A member's \`approval\`:
${ApprovalModeSchema.options.map((mode) => `  - ${mode}: ${APPROVAL_MEANING[mode]}`).join('\n')}
- \`instructionBlocks\`: text added to the instructions of its \`audience\` —
  \`everyone\`, or a list of member ids. A block runs nothing.
${overlaySection(input.overlay, input.otherOverlays ?? [])}
CHANGING ANY TEAM OR PROJECT
${ANY_TEAM_OR_PROJECT}

${WHAT_GOES_WHERE} When you see such a move in what the user asked about, say so in one line; make it only when they agree.

On each turn a member receives, most general first: the user's own standing
instructions, the blocks addressed to it, its own \`instructions\`, its
\`character\`, and every other member's name and \`role\`. A later part
outranks an earlier one. No member ever sees another member's
\`instructions\` or \`character\`.

TEAM RULES
- at least one member, and member ids are unique;
- exactly one trigger, naming a member;
- block ids are unique; an audience id that is no member reaches nobody;
- a stage's \`responsible\` names members (an unknown id is ignored).

STAGES
\`stages\` is optional: the steps every run of the team walks. Every member
of a run sees the whole stage list and the current stage, and members mark
stages done, skipped or reopened as they work. When the user describes the
process a run goes through ("first investigate, then implement or fix, then
review"), write it as stages:
- one stage per step, with a short \`title\`, \`howToWork\` saying how to work
  in it and a \`goal\` saying when it is done;
- \`id\` is a lowercase slug (\`investigation\`, \`code-review\`), never all
  digits, and an edit names a stage by it (\`stages/review/goal\`);
- \`next\` lists the stages that may follow; two or more mean the run takes
  ONE of them (implementation or fix), and a final stage has none;
- exactly one stage starts the walk, and the stages never loop back;
- the walk ends when the last stage is completed, so add no closing "Done" or
  "Finished" stage: one nobody completes leaves the run with an open stage;
- \`responsible\` lists the members that do the stage, the first one leading
  it; leave it out when any member may.

WRITING THE TEXT INSIDE IT
Every \`role\`, \`instructions\`, \`character\` and instruction block is text an
agent follows on every run. Hold everything you write or rewrite to this:
- One home per fact. Text two or more members need goes in one instruction
  block addressed to them, never copied into several members.
- A \`role\` says what the member does, what to send it and what it returns;
  a caller decides from it alone. \`instructions\` say how this member works.
  Neither re-describes or counts teammates: every member already receives the
  others' roles, and prose about the team goes stale when it changes. Where
  instructions must name a teammate to order the work, they use its id.
- \`character\` is manner and tone only — how the member speaks, never what it
  does.
- Keep a sentence only if removing it would change what the member does. Cut
  what a capable coding agent does anyway ("write clean code", "read a file
  before editing it") and what it can read from the repository it works in.
- State what to do. Keep a prohibition only where the cost is lost data or an
  effect outside the machine, and give a reason only where an agent would
  otherwise argue its way around the rule.
- Commit to one default instead of offering a menu, and to a condition
  instead of a hedge such as "if appropriate".
- Leave out history, sources and justification written for a human reader.

And to the settings:
- Leave \`model\`, \`effort\`, \`contextWindow\`, \`modelParameters\`,
  \`configDir\` and \`pool\` unset unless the user names a value or a sibling
  team uses it: their values belong to each CLI, the builder offers them
  as pickers, and a value the CLI does not know fails the member at run time.
- Choose \`approval\` for how the run will be watched: a member on \`ask\` in a
  run nobody watches waits for a person at every tool permission.

In text the request does not cover, name what you would change in one line
and leave it off the card until the user agrees — the user owns it. When the user asks you
to optimize or review the team, apply all of the above throughout.

A NEW TEAM
When the file has no members yet, or the user asks for one from scratch, read
the schema and propose every part of it on one ${HOST_PROPOSE_TEAM_TOOL} card,
one path edit each: \`name\`, a one-line \`description\`, \`mode: lead\`, the
\`members\` (each with a name, role and instructions), the \`triggers\` naming
the member that coordinates, and any \`instructionBlocks\` and \`stages\`.
</team-editing>

<team-analysis>
${builderChatAnalysisGuide(input.memory, BUILDER_CHAT_ANALYSED_RUNS, input.knowledge ?? false)}
</team-analysis>`;
}
