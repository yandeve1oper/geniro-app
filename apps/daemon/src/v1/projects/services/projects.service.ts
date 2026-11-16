import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { hasControlCharacters } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { RunGroupDao } from '../../agents/dao/run-group.dao';
import {
  readModelParameters,
  writeModelParameters,
} from '../../agents/utils/model-parameters';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { resolveValidDirectory } from '../../agents/utils/resolve-directory';
import { LabelInstructionDao } from '../../tasks/dao/label-instruction.dao';
import { TaskDao } from '../../tasks/dao/task.dao';
import { releaseTaskRuns } from '../../tasks/utils/release-task-runs';
import { removeTaskAttachments } from '../../tasks/utils/task-attachments';
import { ProjectDao } from '../dao/project.dao';
import { ProjectInstructionChangeDao } from '../dao/project-instruction-change.dao';
import { Project } from '../entity/project.entity';
import { ProjectInstructionChange } from '../entity/project-instruction-change.entity';
import {
  type KnowledgeFate,
  MAX_PROJECTS,
  PROJECT_CHANGE_COALESCE_MS,
  type ProjectChangeOrigin,
  type ProjectDeleted,
  type ProjectForFolder,
  type ProjectInstructionBlock,
  ProjectInstructionBlockSchema,
  type ProjectInstructionField,
  type ProjectRemovalParticipant,
  type ProjectWire,
} from '../projects.types';
import { limitHoldUntil } from '../utils/breaker';
import {
  blocksDocument,
  joinedBlockTexts,
  projectBlocksOf,
  projectBlocksRefusal,
} from '../utils/project-instruction-blocks';
import { projectKey } from '../utils/project-key';
import { ProjectEventBus } from './project-events.bus';
import { ProjectScopeService } from './project-scope.service';

/** What one project update may change; an omitted key is left alone. */
type ProjectPatch = {
  name?: string;
  folder?: string;
  groupId?: string | null;
  description?: string | null;
  instructionBlocks?: ProjectInstructionBlock[] | null;
  agentKind?: Project['agentKind'];
  model?: string | null;
  effort?: string | null;
  contextWindow?: string | null;
  modelParameters?: Record<string, string> | null;
  approval?: Project['approval'];
  configDir?: string | null;
  teamSlug?: string | null;
  lessons?: Project['lessons'];
  autopilotEnabled?: boolean;
  autopilotIntakeStatus?: Project['autopilotIntakeStatus'];
  autopilotMaxConcurrent?: number;
  expectedInstructionsRevision?: number;
};

/** A change one write makes to one of a project's texts. */
interface TextChange {
  field: ProjectInstructionField;
  previous: string | null;
  next: string | null;
}

/**
 * Projects: a folder, and the standing answers for every task worked in it.
 *
 * It holds a {@link TaskDao} because deleting a project deletes its tasks, and
 * nothing in this daemon cascades. The DAO is provided by this module rather
 * than imported from `TasksModule`, which imports THIS one — a DAO is a
 * stateless wrapper over the shared `EntityManager`, so providing it here
 * costs an object and buys a module graph with no cycle in it and no
 * `forwardRef`. {@link LabelInstructionDao} is here on the same terms: a
 * deleted project's label instructions go with its tasks. So is
 * {@link RunDao}, already provided for the queue: the chats that worked those
 * tasks are released from them. {@link RunGroupDao} answers whether a
 * `groupId` names a sidebar group at all.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly labelInstructionDao: LabelInstructionDao,
    private readonly runDao: RunDao,
    private readonly groupDao: RunGroupDao,
    private readonly changes: ProjectInstructionChangeDao,
    private readonly events: ProjectEventBus,
    private readonly scope: ProjectScopeService,
  ) {}

  private removalParticipant: ProjectRemovalParticipant | null = null;

  /**
   * What else a project's removal settles in its transaction; registered by
   * the knowledge module, which imports this one.
   */
  useRemovalParticipant(participant: ProjectRemovalParticipant): void {
    this.removalParticipant = participant;
  }

  /** Writes to one project, in arrival order: a revision check and its write must not interleave with another's. */
  private writes: Promise<unknown> = Promise.resolve();

  async list(): Promise<ProjectWire[]> {
    const em = this.em.fork();
    return (await this.projectDao.listAll(em)).map(toWire);
  }

  async get(projectId: string): Promise<ProjectWire> {
    const em = this.em.fork();
    return toWire(await this.require(projectId, em));
  }

  /**
   * The project a new chat in `folder` would belong to by the folder rule
   * (`ProjectScopeService.projectOf`: the project bound to it or to the
   * closest folder above it); none for a folder that does not exist.
   */
  async forFolder(folder: string): Promise<ProjectForFolder> {
    let cwd: string;
    try {
      cwd = resolveValidCwd(folder);
    } catch {
      return { project: null };
    }
    const { project } = await this.scope.projectOf({ taskId: null, cwd });
    return { project: project ? toWire(project) : null };
  }

  async create(input: {
    name: string;
    folder: string;
    groupId?: string;
    description?: string;
    instructionBlocks?: ProjectInstructionBlock[];
    agentKind?: Project['agentKind'];
    model?: string;
    effort?: string;
    contextWindow?: string;
    modelParameters?: Record<string, string>;
    approval?: Project['approval'];
    configDir?: string;
    teamSlug?: string;
    autopilotEnabled?: boolean;
    autopilotIntakeStatus?: Project['autopilotIntakeStatus'];
    autopilotMaxConcurrent?: number;
    provider?: Project['provider'];
  }): Promise<ProjectWire> {
    const em = this.em.fork();
    if ((await this.projectDao.count({}, em)) >= MAX_PROJECTS) {
      throw new BadRequestException(
        'TOO_MANY_PROJECTS',
        `a machine holds at most ${MAX_PROJECTS} projects`,
      );
    }
    const folder = resolveValidDirectory(input.folder, {
      errorCode: 'INVALID_PROJECT_FOLDER',
      noun: 'project folder',
    });
    await this.refuseTakenFolder(folder, null, em);
    if (input.groupId !== undefined) {
      await this.refuseUnknownGroup(input.groupId, em);
    }
    const created = await this.projectDao.create(
      {
        name: input.name,
        // Derived ONCE, here, and owned by the row from then on: a rename must
        // not renumber cards that have already been quoted somewhere.
        taskKey: await this.freeTaskKey(input.name, em),
        folder,
        groupId: input.groupId ?? null,
        description: blankToNull(input.description),
        ...blockColumns(checkedBlocks(input.instructionBlocks ?? [])),
        agentKind: input.agentKind ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
        contextWindow: input.contextWindow ?? null,
        modelParameters: writeModelParameters(input.modelParameters),
        approval: input.approval ?? null,
        configDir: input.configDir
          ? resolveValidDirectory(input.configDir, {
              errorCode: 'INVALID_CONFIG_DIR',
              noun: 'config directory',
            })
          : null,
        teamSlug: input.teamSlug ?? null,
        ...(input.autopilotEnabled === undefined
          ? {}
          : { autopilotEnabled: input.autopilotEnabled }),
        ...(input.autopilotIntakeStatus === undefined
          ? {}
          : { autopilotIntakeStatus: input.autopilotIntakeStatus }),
        ...(input.autopilotMaxConcurrent === undefined
          ? {}
          : { autopilotMaxConcurrent: input.autopilotMaxConcurrent }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
      },
      em,
    );
    this.events.publish({ projectId: created.id });
    return toWire(created);
  }

  /**
   * Change a project's name, folder, texts, run defaults or autopilot policy.
   *
   * An explicit `null` on a nullable field clears it; an omitted key leaves it
   * alone. Nothing here touches the project's tasks: repointing a folder is
   * not a claim about the work already on the board.
   *
   * A change to the description or instructions bumps
   * `instructionsRevision` and is logged (`project_instruction_changes`),
   * credited to `origin` or else to the user. A quoted
   * `expectedInstructionsRevision` the project has moved past is refused
   * `409 PROJECT_INSTRUCTIONS_DRIFT` with nothing written.
   */
  update(
    projectId: string,
    patch: ProjectPatch,
    origin?: ProjectChangeOrigin,
  ): Promise<ProjectWire> {
    const write = this.writes.then(() =>
      this.applyUpdate(projectId, patch, origin),
    );
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async applyUpdate(
    projectId: string,
    patch: ProjectPatch,
    origin: ProjectChangeOrigin | undefined,
  ): Promise<ProjectWire> {
    const em = this.em.fork();
    const project = await this.require(projectId, em);
    if (
      patch.expectedInstructionsRevision !== undefined &&
      patch.expectedInstructionsRevision !== project.instructionsRevision
    ) {
      throw new ConflictException(
        'PROJECT_INSTRUCTIONS_DRIFT',
        `the project's description or instructions changed since revision ${patch.expectedInstructionsRevision} (now ${project.instructionsRevision}); read them again`,
      );
    }

    if (patch.name !== undefined) {
      project.name = patch.name;
    }
    if (patch.folder !== undefined) {
      const folder = resolveValidDirectory(patch.folder, {
        errorCode: 'INVALID_PROJECT_FOLDER',
        noun: 'project folder',
      });
      await this.refuseTakenFolder(folder, project.id, em);
      project.folder = folder;
    }
    if (patch.groupId !== undefined) {
      if (patch.groupId !== null) {
        await this.refuseUnknownGroup(patch.groupId, em);
      }
      project.groupId = patch.groupId;
    }
    const textChanges: TextChange[] = [];
    if (patch.description !== undefined) {
      const next = blankToNull(patch.description);
      if (next !== null && hasControlCharacters(next)) {
        throw new BadRequestException(
          'INVALID_PROJECT_TEXT',
          "the project's description must not contain control characters",
        );
      }
      if (next !== project.description) {
        textChanges.push({
          field: 'description',
          previous: project.description,
          next,
        });
        project.description = next;
      }
    }
    if (patch.instructionBlocks !== undefined) {
      const blocks = checkedBlocks(patch.instructionBlocks ?? []);
      const previous = blocksDocument(projectBlocksOf(project));
      const next = blocksDocument(blocks);
      const columns = blockColumns(blocks);
      if (columns.instructionBlocks !== project.instructionBlocks) {
        if (next !== previous) {
          textChanges.push({ field: 'instructions', previous, next });
        }
        Object.assign(project, columns);
      }
    }
    if (textChanges.length > 0) {
      project.instructionsRevision += 1;
      await this.logTextChanges(project.id, textChanges, origin, em);
    }
    if (patch.agentKind !== undefined) {
      project.agentKind = patch.agentKind;
    }
    if (patch.model !== undefined) {
      project.model = patch.model;
    }
    if (patch.effort !== undefined) {
      project.effort = patch.effort;
    }
    if (patch.contextWindow !== undefined) {
      project.contextWindow = patch.contextWindow;
    }
    if (patch.modelParameters !== undefined) {
      project.modelParameters = writeModelParameters(patch.modelParameters);
    }
    if (patch.approval !== undefined) {
      project.approval = patch.approval;
    }
    if (patch.configDir !== undefined) {
      project.configDir =
        patch.configDir === null
          ? null
          : resolveValidDirectory(patch.configDir, {
              errorCode: 'INVALID_CONFIG_DIR',
              noun: 'config directory',
            });
    }
    if (patch.teamSlug !== undefined) {
      project.teamSlug = patch.teamSlug;
    }
    if (patch.lessons !== undefined) {
      project.lessons = patch.lessons;
    }
    if (patch.autopilotEnabled !== undefined) {
      project.autopilotEnabled = patch.autopilotEnabled;
    }
    if (patch.autopilotIntakeStatus !== undefined) {
      project.autopilotIntakeStatus = patch.autopilotIntakeStatus;
    }
    if (patch.autopilotMaxConcurrent !== undefined) {
      project.autopilotMaxConcurrent = patch.autopilotMaxConcurrent;
    }

    await em.flush();
    this.events.publish({
      projectId: project.id,
      ...(textsOnly(patch) ? { textsOnly: true } : {}),
    });
    return toWire(project);
  }

  /**
   * Log each changed text in the same flush as the project. A user's edit to
   * a field whose newest logged change is the user's own, younger than
   * `PROJECT_CHANGE_COALESCE_MS`, extends that row instead (autosave would
   * otherwise log every pause in typing), and one that lands back where that
   * row started removes it.
   */
  private async logTextChanges(
    projectId: string,
    textChanges: readonly TextChange[],
    origin: ProjectChangeOrigin | undefined,
    em: EntityManager,
  ): Promise<void> {
    const now = new Date();
    for (const change of textChanges) {
      if (origin === undefined) {
        const newest = await this.changes.newestOf(projectId, change.field, em);
        if (
          newest?.source === 'user' &&
          now.getTime() - newest.changedAt.getTime() <
            PROJECT_CHANGE_COALESCE_MS
        ) {
          newest.next = change.next;
          newest.changedAt = now;
          if (newest.previous === newest.next) {
            em.remove(newest);
          }
          continue;
        }
      }
      em.persist(
        Object.assign(new ProjectInstructionChange(), {
          projectId,
          changedAt: now,
          field: change.field,
          source: origin?.source ?? 'user',
          previous: change.previous,
          next: change.next,
          recommendationIds: ProjectInstructionChangeDao.idsJson(
            origin?.recommendationIds ?? [],
          ),
          chatRunId: origin?.chatRunId ?? null,
          cardSeq: origin?.cardSeq ?? null,
        }),
      );
    }
  }

  /**
   * Clear the failure streak, which is the only way a tripped breaker closes.
   *
   * A deliberate press rather than a field on the patch above, and that is the
   * whole point of it: the breaker opened because runs kept failing, so
   * whatever it is guarding against is presumed still there until a person
   * says otherwise. A client that could zero the count as part of an ordinary
   * settings write could clear it without ever having looked.
   *
   * Idempotent — re-arming a project whose streak is already zero is a no-op
   * that succeeds, so a second press costs nothing.
   */
  async rearmAutopilot(projectId: string): Promise<ProjectWire> {
    const em = this.em.fork();
    const project = await this.require(projectId, em);
    if (
      project.autopilotFailureStreak !== 0 ||
      project.autopilotLimitUntil !== null
    ) {
      project.autopilotFailureStreak = 0;
      project.autopilotLimitUntil = null;
      await em.flush();
      this.events.publish({ projectId: project.id });
    }
    return toWire(project);
  }

  /**
   * Delete a project AND every task on its board.
   *
   * The tasks go explicitly, one call, because nothing in this daemon
   * cascades — the database will not do it and a task left behind would name a
   * project that no longer exists, invisible on every board and still matching
   * the autopilot's cross-project intake query.
   *
   * Both deletes are soft (`BaseDao.delete` stamps `deletedAt`, the
   * `softDelete` filter hides the rows), the same one-way-door-free shape as
   * archiving a chat rather than purging it.
   */
  async remove(
    projectId: string,
    knowledge: KnowledgeFate = 'global',
  ): Promise<ProjectDeleted> {
    const em = this.em.fork();
    await this.require(projectId, em);
    const doomed = await this.taskDao.listForProject(projectId, em);
    const tasksRemoved = await this.taskDao.countInProject(projectId, em);
    // One transaction, because half of this is worse than none of it: the
    // tasks go first, so a failure between the two writes would leave a board
    // standing with every card hidden and nothing to retry it. The project's
    // label instructions go the same way — a global instruction is untouched,
    // since it names no project to be removed with.
    //
    // The chats that worked those cards go on as ordinary chats rather than
    // naming cards that are gone — the same release a single card's delete
    // makes (`releaseTaskRuns`).
    const settled = await em.transactional(async (tx) => {
      await this.taskDao.deleteForProject(projectId, tx);
      await releaseTaskRuns(
        this.runDao,
        doomed.map((task) => task.id),
        tx,
      );
      await this.labelInstructionDao.deleteForProject(projectId, tx);
      await this.projectDao.deleteById(projectId, tx);
      return this.removalParticipant?.(projectId, knowledge, tx) ?? null;
    });
    settled?.announce();
    // Each card's pasted images, on `TasksService.remove`'s own reasoning:
    // after the rows, outside the transaction, and one failure stepped over
    // rather than thrown — the board is already gone, so a permission error on
    // one directory must not report a delete that happened as having failed.
    for (const task of doomed) {
      try {
        await removeTaskAttachments(task.id);
      } catch (error) {
        this.logger.warn(
          `could not drop attachments for task ${task.id}: ${String(error)}`,
        );
      }
    }
    this.events.publish({ projectId });
    return {
      deleted: true,
      tasksRemoved,
      knowledgeMoved: settled?.moved ?? 0,
      knowledgeDeleted: settled?.deleted ?? 0,
      knowledgeRenamed: settled?.renamed ?? [],
    };
  }

  /**
   * The card key this project will use — the derived one, or the first free
   * variant of it.
   *
   * Nothing keeps `taskKey` unique and no client can set or edit it: it is
   * DERIVED, one initial per word, so two boards collide readily and every
   * name with no Latin letters at all derives the same fallback. The chat
   * sidebar draws `Run.taskIdentifier` in ONE global list, so a collision puts
   * two different cards on screen both labelled `GW-12`, with nothing to tell
   * them apart.
   *
   * A digit is APPENDED rather than the create refused — unlike the folder
   * check below, which refuses. The difference is whose value it is: a folder
   * is chosen by the user and a clash is theirs to resolve, while this string
   * is one they never typed and cannot see, so blocking a create over it would
   * be refusing them for something they did not do.
   *
   * Settled ONCE, here, and never re-derived per task: the invariant is that
   * every PROJECT holds a distinct key, from which a run's label being
   * unambiguous follows for free. Asked at task-create time it would be a
   * different and weaker rule — the label is stamped onto the run row and
   * outlives the card, so a key that was unique when a task was made says
   * nothing about the key a later board is given.
   */
  private async freeTaskKey(name: string, em: EntityManager): Promise<string> {
    const base = projectKey(name);
    // Every key ever ISSUED, not every key currently held: see
    // `ProjectDao.listIssuedTaskKeys` for why a deleted board's key may not be
    // handed out again.
    const taken = new Set(await this.projectDao.listIssuedTaskKeys(em));
    if (!taken.has(base)) {
      return base;
    }
    // Bounded by PIGEONHOLE rather than by the project cap, which no longer
    // bounds `taken` now that it counts deleted boards too: among the
    // `taken.size + 1` candidates this loop tries, at most `taken.size` can be
    // taken, so one of them is always free and the fallback below is
    // unreachable. Sizing this by `MAX_PROJECTS` instead would let a machine
    // that had created and deleted enough boards exhaust the loop and fall back
    // to a `base` it had just proved was taken.
    for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
      const candidate = `${base}${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return base;
  }

  /**
   * Refuse a folder another project already holds.
   *
   * Checked here as well as by the unique index, so the caller gets a named
   * refusal rather than a driver error — and on UPDATE too, which is the path
   * that would otherwise move a second project onto an occupied folder.
   */
  private async refuseTakenFolder(
    folder: string,
    exceptProjectId: string | null,
    em: EntityManager,
  ): Promise<void> {
    const holder = await this.projectDao.findAnyByFolder(folder, em);
    if (holder && holder.id !== exceptProjectId) {
      throw new BadRequestException(
        'FOLDER_ALREADY_A_PROJECT',
        `${holder.name} already uses that folder`,
      );
    }
  }

  /**
   * Refuse a sidebar group id that names nothing, with the 404 the assign route
   * gives. A binding to a missing group files every task run as Ungrouped with
   * no sign of why.
   */
  private async refuseUnknownGroup(
    groupId: string,
    em: EntityManager,
  ): Promise<void> {
    if (!(await this.groupDao.getById(groupId, em))) {
      throw new NotFoundException(
        'GROUP_NOT_FOUND',
        `group ${groupId} not found`,
      );
    }
  }

  private async require(
    projectId: string,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
    return project;
  }
}

/** Whether a patch names nothing but the project's texts and the revision they quote. */
function textsOnly(patch: ProjectPatch): boolean {
  return Object.entries(patch).every(
    ([key, value]) =>
      value === undefined ||
      key === 'expectedInstructionsRevision' ||
      key === 'description' ||
      key === 'instructionBlocks',
  );
}

/**
 * Blocks a writer may store: unique ids, and texts that together fit the
 * instructions' bound. Refused whole, never trimmed.
 */
function checkedBlocks(
  blocks: readonly ProjectInstructionBlock[],
): ProjectInstructionBlock[] {
  const refusal = projectBlocksRefusal(blocks);
  if (refusal !== null) {
    throw new BadRequestException('INVALID_PROJECT_BLOCKS', refusal.message);
  }
  return blocks.map((block) => ProjectInstructionBlockSchema.parse(block));
}

/** The two columns a block list is stored in. */
function blockColumns(
  blocks: readonly ProjectInstructionBlock[],
): Pick<Project, 'instructions' | 'instructionBlocks'> {
  return {
    instructions: joinedBlockTexts(blocks),
    instructionBlocks: JSON.stringify(blocks),
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toWire(project: Project): ProjectWire {
  return {
    id: project.id,
    name: project.name,
    taskKey: project.taskKey,
    folder: project.folder,
    groupId: project.groupId,
    description: project.description,
    instructions: project.instructions,
    instructionBlocks: projectBlocksOf(project),
    instructionsRevision: project.instructionsRevision,
    agentKind: project.agentKind,
    model: project.model,
    effort: project.effort,
    contextWindow: project.contextWindow,
    modelParameters: readModelParameters(project.modelParameters),
    approval: project.approval,
    configDir: project.configDir,
    teamSlug: project.teamSlug,
    autopilotEnabled: project.autopilotEnabled,
    autopilotIntakeStatus: project.autopilotIntakeStatus,
    autopilotMaxConcurrent: project.autopilotMaxConcurrent,
    autopilotFailureStreak: project.autopilotFailureStreak,
    autopilotLimitUntil: limitHoldUntil(project)?.toISOString() ?? null,
    provider: project.provider,
    lessons: project.lessons,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
