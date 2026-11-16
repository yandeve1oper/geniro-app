import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import {
  type DeferredCard,
  type DeferredCardResponder,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_QUESTION_TOOL,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
  type HostQuestion,
  type HostQuestionOutcome,
  type OwnedCardHost,
  type TeamProposalOutcome,
  type UnanswerableWire,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ChatService } from '../../agents/services/chat.service';
import { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { ProjectInstructionsChangeService } from '../../agents/services/project-instructions-change.service';
import {
  hostProjectInstructionsResultText,
  projectInstructionsCardInput,
  projectInstructionsCardKey,
  projectInstructionsVerdict,
} from '../../agents/utils/host-project-instructions';
import {
  deferredAnswerMessage,
  hostCardQuestions,
  hostQuestionCardInput,
} from '../../agents/utils/host-question';
import {
  type PendingQuestionSnapshot,
  QUESTION_ALREADY_STANDING,
} from '../../agents/utils/pending-question';
import { persistItemAndEmit } from '../../agents/utils/persist-item';
import { StandingQuestions } from '../../agents/utils/standing-questions';
import {
  memberQuestionIds,
  type PendingMemberQuestion,
  readMemberQuestions,
  serializeMemberQuestions,
} from '../../agents/utils/team-member-questions';
import {
  readTeamProjectCard,
  serializeTeamProjectCard,
  teamProjectCardId,
} from '../../agents/utils/team-project-card';
import type { ItemKind } from '../../runs/runs.types';
import { StageWakeService } from './stage-wake.service';
import { TeamExecutorService } from './team-executor.service';

const LEAD_CARD_POSTED: HostProjectInstructionsOutcome = {
  status: 'posted',
  buttons: 'Approve or Deny',
};

/**
 * The deferred cards of a team run — the LEAD's `propose_team` (for
 * `TeamProposalService`) and `save_project_instructions`, and any member's own
 * `ask_user_question` on a CLI that will not hold the call open — on the terms
 * `ChatService` keeps a chat's: the row is written in the asker's own flow,
 * the card stands in the registry until the user answers it, and the verdict
 * reaches the asker (for a lead card, whoever leads at the press) as a host
 * wake in its own conversation.
 */
@Injectable()
export class TeamCardsService implements OwnedCardHost, OnModuleInit {
  private readonly logger = new Logger(TeamCardsService.name);
  /** The project card being raised per run, claimed before the first await. */
  private readonly raising = new Map<
    string,
    { key: string; outcome: Promise<HostProjectInstructionsOutcome> }
  >();
  /** The member question being raised per run and member, claimed before the first await. */
  private readonly asking = new Map<
    string,
    { key: string; outcome: Promise<HostQuestionOutcome> }
  >();
  /** Each run's writes of `Run.pendingMemberQuestions`, one at a time. */
  private readonly memberQuestionWrites = new Map<string, Promise<void>>();
  /** Member cards whose answer is being carried out — never retired meanwhile. */
  private readonly answering = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly seqs: ItemSeqAllocator,
    private readonly calls: ItemCallIndexService,
    private readonly bus: AgentEventBus,
    private readonly approvals: ApprovalRegistry,
    private readonly chats: ChatService,
    private readonly executor: TeamExecutorService,
    private readonly stageWakes: StageWakeService,
    private readonly changes: ProjectInstructionsChangeService,
  ) {}

  onModuleInit(): void {
    this.executor.useLeadProjectCards((runId, change) =>
      this.proposeProjectInstructions(runId, change),
    );
    this.executor.useMemberQuestionCards({
      ask: (runId, memberId, questions, title) =>
        this.askMember(runId, memberId, questions, title),
      retireForUserMessage: (runId) => this.retireMemberQuestions(runId),
    });
  }

  async raiseOwnedCard(
    runId: string,
    requestId: string,
    card: DeferredCard,
    respond: DeferredCardResponder,
  ): Promise<void> {
    if (await this.isArchived(runId)) {
      throw new ConflictException('RUN_ARCHIVED', 'this team run is archived');
    }
    const lead = await this.executor.currentLead(runId);
    await this.persist(runId, lead, 'approval_request', {
      id: requestId,
      ...(lead === null ? {} : { nodeId: lead }),
      toolName: card.toolName,
      input: card.input,
    });
    this.track(runId, lead, requestId, card, respond);
  }

  async trackOwnedCard(
    runId: string,
    requestId: string,
    card: DeferredCard,
    respond: DeferredCardResponder,
  ): Promise<void> {
    this.track(
      runId,
      await this.executor.currentLead(runId),
      requestId,
      card,
      respond,
    );
  }

  private track(
    runId: string,
    memberId: string | null,
    requestId: string,
    card: DeferredCard,
    respond: DeferredCardResponder,
    question = false,
  ): void {
    this.approvals.track({
      runId,
      memberId: memberId ?? '',
      requestId,
      toolName: card.toolName,
      input: card.input,
      question,
      deferred: true,
      standing: true,
      respond: (allow, answer) => {
        respond(allow, answer);
        return true;
      },
    });
    this.executor.announceAwaiting(runId);
  }

  /**
   * Retire one card as `unanswerable`, unless the transcript already closes
   * it — `ChatService.retireOwnedCard`'s rule.
   */
  async retireOwnedCard(
    runId: string,
    requestId: string,
    toolName: string,
  ): Promise<void> {
    if (
      this.approvals.abandon(runId, requestId) === null &&
      (await this.closed(runId, requestId))
    ) {
      return;
    }
    await this.persist(runId, null, 'unanswerable', {
      id: requestId,
      toolName,
    } satisfies UnanswerableWire);
    this.executor.announceAwaiting(runId);
  }

  isArchived(runId: string): Promise<boolean> {
    return this.chats.isArchived(runId);
  }

  async deliverOwnedCardVerdict(
    runId: string,
    requestId: string,
    allow: boolean,
    message: string,
    answer?: string,
    outcome?: TeamProposalOutcome,
  ): Promise<void> {
    await this.writeVerdict(runId, requestId, allow, {
      ...(answer === undefined ? {} : { answer }),
      ...(outcome === undefined ? {} : { outcome }),
    });
    await this.wakeLead(
      runId,
      requestId,
      message,
      'Told the lead your answer on the card',
    );
  }

  /**
   * The lead's `save_project_instructions`: put the card up and answer at
   * once. One standing per run — the same change adopts it, another is
   * refused — claimed synchronously, so two racing calls never both draw one.
   */
  proposeProjectInstructions(
    runId: string,
    change: HostProjectInstructions,
  ): Promise<HostProjectInstructionsOutcome> {
    const key = projectInstructionsCardKey(change);
    const inFlight = this.raising.get(runId);
    if (inFlight !== undefined) {
      return inFlight.key === key
        ? inFlight.outcome
        : Promise.resolve({
            status: 'unavailable',
            reason: QUESTION_ALREADY_STANDING,
          });
    }
    const outcome = this.raiseProjectCard(runId, key, change);
    this.raising.set(runId, { key, outcome });
    return outcome.finally(() => {
      if (this.raising.get(runId)?.outcome === outcome) {
        this.raising.delete(runId);
      }
    });
  }

  private async raiseProjectCard(
    runId: string,
    key: string,
    change: HostProjectInstructions,
  ): Promise<HostProjectInstructionsOutcome> {
    const em = this.em.fork();
    const standing = readTeamProjectCard(
      (await this.runDao.getById(runId, em))?.pendingTeamProjectCard ?? null,
    );
    if (standing !== null) {
      return projectInstructionsCardKey(standing.change) === key
        ? LEAD_CARD_POSTED
        : { status: 'unavailable', reason: QUESTION_ALREADY_STANDING };
    }
    const requestId = randomUUID();
    let raised = false;
    try {
      await this.raiseOwnedCard(
        runId,
        requestId,
        projectCard(change),
        this.projectResponder(runId, requestId, change),
      );
      raised = true;
      // AFTER the row: a pointer written first would survive a failed write as
      // a card nothing ever drew.
      await this.runDao.setPendingTeamProjectCard(
        runId,
        serializeTeamProjectCard({ requestId, change }),
        em,
      );
      // Again after the column: an archive that read it before this write
      // would leave the card standing on an archived run.
      if (await this.isArchived(runId)) {
        throw new ConflictException(
          'RUN_ARCHIVED',
          'the team run was archived while the card was raised',
        );
      }
    } catch (error) {
      this.logger.error(
        `team run ${runId} could not put a project-instructions card on screen: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (raised) {
        await this.undoRaise(runId, requestId);
      }
      return {
        status: 'unavailable',
        reason:
          error instanceof ConflictException
            ? 'this thread is archived, so the user cannot be asked'
            : 'the card could not be written',
      };
    }
    return LEAD_CARD_POSTED;
  }

  private async undoRaise(runId: string, requestId: string): Promise<void> {
    try {
      await this.retireOwnedCard(
        runId,
        requestId,
        HOST_PROJECT_INSTRUCTIONS_TOOL,
      );
      await this.runDao.setPendingTeamProjectCard(runId, null, this.em.fork());
    } catch (error) {
      this.logger.error(
        `team run ${runId} could not take back a project-instructions card: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private projectResponder(
    runId: string,
    requestId: string,
    change: HostProjectInstructions,
  ): DeferredCardResponder {
    return (allow) => {
      void this.carryOutProjectVerdict(runId, requestId, change, allow);
    };
  }

  /**
   * The user pressed the card. The column is cleared BEFORE the write, so a
   * crash between the two reads at the next boot as a card that expired,
   * never as a second write.
   */
  private async carryOutProjectVerdict(
    runId: string,
    requestId: string,
    change: HostProjectInstructions,
    allow: boolean,
  ): Promise<void> {
    let cleared = true;
    try {
      await this.runDao.setPendingTeamProjectCard(runId, null, this.em.fork());
    } catch (error) {
      cleared = false;
      this.logger.error(
        `team run ${runId} could not close a project-instructions card: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let outcome: HostProjectInstructionsOutcome = { status: 'declined' };
    if (allow && !cleared) {
      outcome = {
        status: 'stale',
        reason: 'the card could not be closed, so nothing was written',
      };
    } else if (allow) {
      try {
        outcome = await this.changes.write(runId, change);
      } catch (error) {
        this.logger.error(
          `team run ${runId} could not write project instructions: ${error instanceof Error ? error.message : String(error)}`,
        );
        outcome = {
          status: 'stale',
          reason: 'the instructions could not be written',
        };
      }
    }
    await this.writeVerdict(
      runId,
      requestId,
      allow,
      projectInstructionsVerdict(outcome),
    );
    await this.wakeLead(
      runId,
      requestId,
      hostProjectInstructionsResultText(outcome, true),
      'Told the lead what became of the project instructions',
    );
  }

  /**
   * Put every standing project card back in the registry at boot. A card the
   * transcript already closes loses its column; one whose change no longer
   * reads is closed. One run's failure never stops the rest.
   */
  async rehydrate(): Promise<void> {
    let runs: Awaited<ReturnType<RunDao['listRunsWithPendingTeamProjectCard']>>;
    try {
      runs = await this.runDao.listRunsWithPendingTeamProjectCard(
        this.em.fork(),
      );
    } catch (error) {
      this.logger.error(
        `team project card rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const run of runs) {
      try {
        await this.rehydrateRun(run.id, run.pendingTeamProjectCard);
      } catch (error) {
        this.logger.error(
          `team run ${run.id} project card rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.rehydrateMemberQuestions();
  }

  private async rehydrateRun(
    runId: string,
    column: string | null,
  ): Promise<void> {
    const cardId = teamProjectCardId(column);
    const closed = cardId !== null && (await this.closed(runId, cardId));
    const card = readTeamProjectCard(column);
    if (cardId !== null && !closed && card === null) {
      await this.retireOwnedCard(runId, cardId, HOST_PROJECT_INSTRUCTIONS_TOOL);
    }
    if (card === null || closed) {
      await this.runDao.setPendingTeamProjectCard(runId, null, this.em.fork());
      return;
    }
    await this.trackOwnedCard(
      runId,
      card.requestId,
      projectCard(card.change),
      this.projectResponder(runId, card.requestId, card.change),
    );
  }

  /**
   * A member's own question on a CLI that will not hold the call open: put the
   * card up and answer at once. One standing per member — the same words
   * adopt it, others are refused — claimed synchronously, so two racing calls
   * never both draw one.
   */
  askMember(
    runId: string,
    memberId: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    const key = StandingQuestions.keyFor(title, questions);
    const claim = `${runId}::${memberId}`;
    const inFlight = this.asking.get(claim);
    if (inFlight !== undefined) {
      return inFlight.key === key
        ? inFlight.outcome
        : Promise.resolve({
            status: 'unavailable',
            reason: QUESTION_ALREADY_STANDING,
          });
    }
    const outcome = this.raiseMemberQuestion(
      runId,
      memberId,
      key,
      questions,
      title,
    );
    this.asking.set(claim, { key, outcome });
    return outcome.finally(() => {
      if (this.asking.get(claim)?.outcome === outcome) {
        this.asking.delete(claim);
      }
    });
  }

  private async raiseMemberQuestion(
    runId: string,
    memberId: string,
    key: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    const standing = (await this.memberQuestions(runId)).find(
      (entry) => entry.memberId === memberId,
    );
    if (standing !== undefined) {
      return StandingQuestions.keyFor(
        standing.card.title,
        standing.card.questions,
      ) === key
        ? { status: 'posted' }
        : { status: 'unavailable', reason: QUESTION_ALREADY_STANDING };
    }
    const card: PendingQuestionSnapshot = {
      kind: 'question',
      requestId: randomUUID(),
      title,
      questions,
    };
    let raised = false;
    try {
      if (await this.isArchived(runId)) {
        throw new ConflictException(
          'RUN_ARCHIVED',
          'this team run is archived',
        );
      }
      await this.persist(runId, memberId, 'approval_request', {
        id: card.requestId,
        nodeId: memberId,
        toolName: HOST_QUESTION_TOOL,
        input: hostQuestionCardInput(title, questions),
        questions: hostCardQuestions(questions),
      });
      raised = true;
      this.trackMemberQuestion(runId, { memberId, card });
      await this.changeMemberQuestions(runId, (entries) => [
        ...entries.filter((entry) => entry.memberId !== memberId),
        { memberId, card },
      ]);
      if (await this.isArchived(runId)) {
        throw new ConflictException(
          'RUN_ARCHIVED',
          'the team run was archived while the card was raised',
        );
      }
    } catch (error) {
      this.logger.error(
        `team run ${runId} could not put ${memberId}'s question on screen: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (raised) {
        await this.closeMemberQuestions(runId, [card.requestId], false);
      }
      return {
        status: 'unavailable',
        reason:
          error instanceof ConflictException
            ? 'this thread is archived, so the user cannot be asked'
            : 'the question card could not be written',
      };
    }
    return { status: 'posted' };
  }

  private trackMemberQuestion(
    runId: string,
    { memberId, card }: PendingMemberQuestion,
  ): void {
    this.track(
      runId,
      memberId,
      card.requestId,
      {
        toolName: HOST_QUESTION_TOOL,
        input: hostQuestionCardInput(card.title, card.questions),
      },
      (allow, answer) => {
        this.answering.add(card.requestId);
        void this.answerMemberQuestion(
          runId,
          memberId,
          card.requestId,
          allow,
          answer,
        ).finally(() => this.answering.delete(card.requestId));
      },
      true,
    );
  }

  /**
   * The user answered a member's card. It leaves the column BEFORE the answer
   * goes out, so a crash between the two reads at the next boot as a card
   * that expired, never as an answer sent twice.
   */
  private async answerMemberQuestion(
    runId: string,
    memberId: string,
    requestId: string,
    allow: boolean,
    answer: string | undefined,
  ): Promise<void> {
    try {
      await this.changeMemberQuestions(runId, (entries) =>
        entries.filter((entry) => entry.card.requestId !== requestId),
      );
    } catch (error) {
      this.logger.error(
        `team run ${runId} could not close ${memberId}'s question card: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.writeVerdict(
      runId,
      requestId,
      allow,
      allow && answer !== undefined ? { answer } : {},
      memberId,
    );
    await this.wakeLead(
      runId,
      requestId,
      deferredAnswerMessage(allow, answer),
      'Told the agent your answer to its question',
      memberId,
    );
  }

  /**
   * The user wrote to the run instead of answering: every standing member
   * question is closed. Its registry entries go at once, before the message
   * starts a turn a press could otherwise still answer into.
   */
  retireMemberQuestions(runId: string): Promise<void> {
    const open = this.approvals
      .listByRun(runId)
      .filter(
        (entry) =>
          entry.toolName === HOST_QUESTION_TOOL && entry.deferred === true,
      );
    for (const entry of open) {
      this.approvals.abandon(runId, entry.requestId);
    }
    return this.closeMemberQuestions(
      runId,
      open.map((entry) => entry.requestId),
      true,
    ).catch((error: unknown) => {
      this.logger.error(
        `team run ${runId} could not retire its members' questions: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Close `requestIds` — and, with `everyListed`, every card the column still names. */
  private async closeMemberQuestions(
    runId: string,
    requestIds: readonly string[],
    everyListed: boolean,
  ): Promise<void> {
    const listed = everyListed
      ? memberQuestionIds(
          (await this.runDao.getById(runId, this.em.fork()))
            ?.pendingMemberQuestions ?? null,
        )
      : [];
    await this.changeMemberQuestions(runId, (entries) =>
      entries.filter(
        (entry) =>
          this.answering.has(entry.card.requestId) ||
          (!requestIds.includes(entry.card.requestId) &&
            !listed.includes(entry.card.requestId)),
      ),
    );
    for (const requestId of new Set([...requestIds, ...listed])) {
      if (!this.answering.has(requestId)) {
        await this.retireOwnedCard(runId, requestId, HOST_QUESTION_TOOL);
      }
    }
  }

  private async rehydrateMemberQuestions(): Promise<void> {
    let runs: Awaited<ReturnType<RunDao['listRunsWithPendingMemberQuestions']>>;
    try {
      runs = await this.runDao.listRunsWithPendingMemberQuestions(
        this.em.fork(),
      );
    } catch (error) {
      this.logger.error(
        `team member question rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const run of runs) {
      try {
        const standing: PendingMemberQuestion[] = [];
        for (const entry of readMemberQuestions(run.pendingMemberQuestions)) {
          if (!(await this.closed(run.id, entry.card.requestId))) {
            standing.push(entry);
          }
        }
        const kept = standing.map((entry) => entry.card.requestId);
        for (const requestId of memberQuestionIds(run.pendingMemberQuestions)) {
          if (!kept.includes(requestId)) {
            await this.retireOwnedCard(run.id, requestId, HOST_QUESTION_TOOL);
          }
        }
        await this.runDao.setPendingMemberQuestions(
          run.id,
          serializeMemberQuestions(standing),
          this.em.fork(),
        );
        for (const entry of standing) {
          this.trackMemberQuestion(run.id, entry);
        }
      } catch (error) {
        this.logger.error(
          `team run ${run.id} member question rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async memberQuestions(
    runId: string,
  ): Promise<PendingMemberQuestion[]> {
    return readMemberQuestions(
      (await this.runDao.getById(runId, this.em.fork()))
        ?.pendingMemberQuestions ?? null,
    );
  }

  /** Rewrite the run's member questions, one write at a time per run. */
  private changeMemberQuestions(
    runId: string,
    change: (entries: PendingMemberQuestion[]) => PendingMemberQuestion[],
  ): Promise<void> {
    const write = (this.memberQuestionWrites.get(runId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const em = this.em.fork();
        await this.runDao.setPendingMemberQuestions(
          runId,
          serializeMemberQuestions(change(await this.memberQuestions(runId))),
          em,
        );
      });
    this.memberQuestionWrites.set(runId, write);
    return write.finally(() => {
      if (this.memberQuestionWrites.get(runId) === write) {
        this.memberQuestionWrites.delete(runId);
      }
    });
  }

  private async closed(runId: string, requestId: string): Promise<boolean> {
    return (
      (
        await this.itemDao.rowsByPayloadId(
          runId,
          ['approval_verdict', 'unanswerable'],
          [requestId],
          undefined,
          this.em.fork(),
        )
      ).length > 0
    );
  }

  /** The verdict row, written even when the wake cannot go: it is the record of what the user chose. */
  private async writeVerdict(
    runId: string,
    requestId: string,
    allow: boolean,
    extra: Record<string, unknown>,
    asker?: string,
  ): Promise<void> {
    try {
      const lead = asker ?? (await this.executor.currentLead(runId));
      await this.persist(runId, lead, 'approval_verdict', {
        id: requestId,
        ...(lead === null ? {} : { nodeId: lead }),
        allow,
        ...extra,
      });
    } catch (error) {
      this.logger.error(
        `team run ${runId} card verdict write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.executor.announceAwaiting(runId);
  }

  private async wakeLead(
    runId: string,
    requestId: string,
    prompt: string,
    rowMessage: string,
    asker?: string,
  ): Promise<void> {
    try {
      await this.stageWakes.wakeLead(
        runId,
        asker ?? (await this.executor.currentLead(runId)),
        `card:${runId}:${requestId}`,
        prompt,
        rowMessage,
      );
    } catch (error) {
      this.logger.error(
        `team run ${runId} could not tell the lead the card's verdict: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persist(
    runId: string,
    memberId: string | null,
    kind: ItemKind,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return this.seqs.reserve(runId).then((seq) =>
      persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        this.em.fork(),
        { runId, memberId, seq, kind, role: null, payload },
      ),
    );
  }
}

function projectCard(change: HostProjectInstructions): DeferredCard {
  return {
    toolName: HOST_PROJECT_INSTRUCTIONS_TOOL,
    input: projectInstructionsCardInput(change),
  };
}
