import type { FilterQuery } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonProposalStatus } from '../lessons.types';

@Injectable()
export class LessonProposalDao extends BaseDao<LessonProposal> {
  constructor(em: EntityManager) {
    super(em, LessonProposal);
  }

  /** Proposals newest first, narrowed by status and source thread. */
  list(
    filter: { status?: LessonProposalStatus; sourceRunId?: string },
    txEm?: EntityManager,
  ): Promise<LessonProposal[]> {
    const where: FilterQuery<LessonProposal> = {};
    if (filter.status !== undefined) {
      where.status = filter.status;
    }
    if (filter.sourceRunId !== undefined) {
      where.sourceRunId = filter.sourceRunId;
    }
    return this.getRepo(txEm).find(where, {
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      disableIdentityMap: true,
    });
  }

  /**
   * The newest proposals the user rejected in one place: the same team for a
   * team run, else the same project, else those of no project and no team.
   */
  rejectedIn(
    place: { projectId: string | null; teamSlug: string | null },
    limit: number,
    txEm?: EntityManager,
  ): Promise<LessonProposal[]> {
    const where: FilterQuery<LessonProposal> =
      place.teamSlug !== null
        ? { status: 'rejected', teamSlug: place.teamSlug }
        : { status: 'rejected', projectId: place.projectId, teamSlug: null };
    return this.getRepo(txEm).find(where, {
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      limit,
      disableIdentityMap: true,
    });
  }
}
