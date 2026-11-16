import { Document } from 'yaml';

import {
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_READ_TEAMS_TOOL,
} from '../../agents/chat.types';
import {
  ANY_TEAM_OR_PROJECT,
  WHAT_GOES_WHERE,
} from '../../agents/utils/any-team-or-project';
import {
  PROJECT_INSTRUCTIONS_MAX,
  type ProjectInstructionBlock,
} from '../../projects/projects.types';
import { instructionsLength } from '../../projects/utils/project-instruction-blocks';
import type { AgentKind } from '../../runs/runs.types';
import type { Team, TeamAgentPoolMember, TeamMember } from '../teams.types';
import { OVERLAY_FORMAT } from './team-chat-instructions';

/** The project a project chat changes, as it stands when a turn begins. */
export interface ProjectChatProjectRef {
  id: string;
  name: string;
  folder: string;
  description: string | null;
  blocks: readonly ProjectInstructionBlock[];
  revision: number;
}

/** Who the project's runs start with: its default team and that team's overlay here, or an agent. */
export type ProjectChatTarget =
  | {
      kind: 'team';
      slug: string;
      team: Team;
      /** Absolute path of this project's overlay of it, which may not exist yet. */
      overlayPath: string;
      /** The overlay file's YAML as it stands; null when there is none. */
      overlayYaml: string | null;
    }
  | { kind: 'agent'; agent: AgentKind | null };

const MODEL_FIELDS = [
  'agent',
  'approval',
  'model',
  'effort',
  'contextWindow',
  'modelParameters',
  'autoCompactPercent',
  'configDir',
] as const satisfies readonly (keyof TeamMember & keyof TeamAgentPoolMember)[];

function modelGroupOf(
  member: TeamMember | TeamAgentPoolMember,
): Record<string, unknown> {
  return Object.fromEntries(
    MODEL_FIELDS.flatMap((field) =>
      member[field] === undefined ? [] : [[field, member[field]]],
    ),
  );
}

/** Each member's id, name, Model group, MCP switches and pool, as the shared team holds them. */
function membersYaml(team: Team): string {
  return new Document(
    team.members.map((member) => ({
      id: member.id,
      name: member.name,
      ...modelGroupOf(member),
      ...(member.mcpDisabled === undefined
        ? {}
        : { mcpDisabled: member.mcpDisabled }),
      ...(member.pool === undefined
        ? {}
        : { pool: member.pool.map(modelGroupOf) }),
    })),
  )
    .toString()
    .trimEnd();
}

function instructionsSection(project: ProjectChatProjectRef): string {
  const blocks =
    project.blocks.length === 0
      ? 'The project has no instruction blocks yet.'
      : `<project-instructions revision="${project.revision}">
${JSON.stringify(project.blocks, null, 2)}
</project-instructions>`;
  return `INSTRUCTIONS
Every agent of every new run in this project is told its instruction blocks,
in order. They stand at revision ${project.revision} and hold
${instructionsLength(project.blocks)} of the ${PROJECT_INSTRUCTIONS_MAX} characters all of them together may hold:

${blocks}

Change them only with ${HOST_PROJECT_INSTRUCTIONS_TOOL}, naming no project:
every block as it should read — one you keep unchanged as its id alone — with
${project.revision} as baseRevision. Keep each block about
one subject, and keep a sentence only if an agent working in this project
would act differently without it. The description below is the user's to
edit on the page; you cannot change it.${
    project.description === null
      ? ''
      : `

<project-description>
${project.description}
</project-description>`
  }`;
}

function targetSection(
  project: ProjectChatProjectRef,
  target: ProjectChatTarget,
): string {
  if (target.kind === 'agent') {
    return `WHO RUNS IT
The project's runs start with ${target.agent === null ? 'the agent the user picks' : `the ${target.agent} agent`}
by default. Who runs it is changed in the page's "Default agent or team"
section; you cannot change it.`;
  }
  return `ITS TEAM
The project's runs are run by the team "${target.team.name}" (slug
\`${target.slug}\`). The team is shared by every project that uses it, so a
change to it reaches them all: what only this project needs goes in the
overlay below, and the team itself changes only when the user asks for that.
Read it — its members' roles and instructions, its stages, trigger, mode and
blocks — with ${HOST_READ_TEAMS_TOOL} whenever the user asks about it or a
change needs to know it: with that slug alone it answers the whole team while
it fits one answer, else its outline; then read the members, blocks or stages
a change touches, or \`search\` for the words it names.

What it holds for each member's Model group, MCP switches
(\`mcpDisabled\`: the servers it runs without) and pool:

\`\`\`yaml
${membersYaml(target.team)}
\`\`\`

What only ${project.name}'s runs change about it lives in this project's
overlay:

  ${target.overlayPath}

${
  target.overlayYaml === null
    ? 'The project has no overlay yet: its runs run the team as it is.'
    : `It stands as:

\`\`\`yaml
${target.overlayYaml.trimEnd()}
\`\`\``
}

${OVERLAY_FORMAT}

Change the overlay only with ${HOST_PROPOSE_TEAM_TOOL}: pass the WHOLE overlay
document as it should stand as \`overlay\`, naming no project, with a one-line
\`summary\` and a \`reason\`. To move text between the team and it, send the
team's \`edits\` with \`replaces\` set to that slug on the same card. Never
write the overlay or the team file yourself. Leave a Model
setting unset unless the user names a value: a value the CLI does not know
fails the member at run time.`;
}

/** What geniro tells the agent behind a project page's chat panel. */
export function composeProjectChatInstructions(input: {
  project: ProjectChatProjectRef;
  target: ProjectChatTarget;
  /** Whether the chat runs in the project's folder. */
  inFolder: boolean;
}): string {
  const { project, target } = input;
  return `<project-editing>
You are the chat on the page of one geniro project, "${project.name}". The
user sees the page while you work: the project's instructions${target.kind === 'team' ? ' and how its team works in it' : ''}.

Its folder is ${project.folder}${input.inFolder ? ', your working directory' : ''}: read its code when a change needs to
know it.

HOW TO WORK
- Every change goes on a card the user answers; nothing is written without
  their Apply or Approve. Put everything one request needs on one card, then
  END YOUR TURN: their answer arrives as your next message.
- Change only what the user asks. Name anything else you would change in one
  line and leave it off the card until they agree.
- Once a change is saved, say in one or two lines what changed; the page
  shows the rest.
- What you read here was written when this turn began. The user may change
  the page between your turns.

${instructionsSection(project)}

${targetSection(project, target)}

CHANGING ANY TEAM OR PROJECT
${ANY_TEAM_OR_PROJECT}

${WHAT_GOES_WHERE} When you see such a move in what the user asked about, say so in one line; make it only when they agree, with the document first and the text out of the instructions after.
</project-editing>`;
}
