import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  InternalException,
  NotFoundException,
} from '@packages/common';

import {
  type ArtifactAnswersWire,
  MAX_ARTIFACT_ANSWERS_BYTES,
  type RunArtifactsWire,
  type RunArtifactWire,
  type TitledArtifactAnswers,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { parseJsonColumn } from '../utils/json-util';
import { ArtifactStoreService } from './artifact-store.service';

/**
 * The pages one run has published, newest first, one entry per artifact.
 *
 * A daemon route rather than a fold in the client, for {@link
 * ChatTimelineService}'s reason and one sharper: the renderer holds at most
 * `HISTORY_PAGE` items, so a fold there answers about the newest page while
 * presenting it as the whole conversation — and an artifact published earlier
 * then vanishes from the panel, which is indistinguishable from a thread that
 * published none. The panel is the artifact's only stable entry point once its
 * card has scrolled away, so that is the one failure worth a route.
 *
 * Deliberately UNCAPPED, unlike the timeline beside it. A marker is written
 * per user message and a long thread has hundreds; an artifact is written when
 * an agent publishes a PAGE, and the fold collapses every revision of one id
 * to a single entry — so the response is bounded by how many distinct pages a
 * conversation produced, which is the list the panel is asked to show whole.
 */
@Injectable()
export class ChatArtifactsService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly store: ArtifactStoreService,
  ) {}

  async read(runId: string): Promise<RunArtifactsWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', 'no such chat');
    }

    // Keyed by artifact, so a republished id collapses to its newest row —
    // the version the page stands at now. The rows arrive oldest first, so the
    // last write per key wins without comparing seqs.
    const newest = new Map<string, RunArtifactWire>();
    for (const row of await this.itemDao.artifactRows(runId, em)) {
      const artifact = readRow(row);
      if (artifact !== null) {
        newest.set(artifact.artifactId, artifact);
      }
    }
    return { artifacts: [...newest.values()].sort((a, b) => b.seq - a.seq) };
  }

  /** What the user picked on one of the run's pages — see `ArtifactAnswersWireSchema`. */
  async readAnswers(
    runId: string,
    artifactId: string,
  ): Promise<ArtifactAnswersWire> {
    await this.requireRun(runId);
    return this.store.readAnswers(runId, artifactId) ?? noSuchPage();
  }

  /**
   * Merge what the user changed on one of the run's pages into what was kept,
   * answering the whole set. Refused past `MAX_ARTIFACT_ANSWERS_BYTES`, the limit
   * the page itself holds a save to.
   */
  async saveAnswers(
    runId: string,
    artifactId: string,
    changes: Record<string, unknown>,
  ): Promise<ArtifactAnswersWire> {
    await this.requireRun(runId);
    const kept = this.store.mergeAnswers(runId, artifactId, changes);
    if (kept === 'too-large') {
      throw new BadRequestException(
        'ARTIFACT_ANSWERS_TOO_LARGE',
        `a page's answers may hold ${MAX_ARTIFACT_ANSWERS_BYTES} characters of JSON`,
      );
    }
    if (kept === 'unreadable') {
      throw new InternalException(
        'ARTIFACT_ANSWERS_UNREADABLE',
        "this page's kept answers could not be read, so none were changed",
      );
    }
    return kept ?? noSuchPage();
  }

  /**
   * The answers kept for the run's pages — every page with any, or the one named —
   * each with the title its newest version carries, for the run's agent to read.
   */
  async keptAnswers(
    runId: string,
    artifactId: string | null,
  ): Promise<TitledArtifactAnswers[]> {
    const titles = new Map(
      (await this.read(runId)).artifacts.map((page) => [
        page.artifactId,
        page.title,
      ]),
    );
    return this.store
      .listAnswers(runId)
      .filter((kept) => artifactId === null || kept.artifactId === artifactId)
      .map((kept) => ({ ...kept, title: titles.get(kept.artifactId) ?? null }));
  }

  private async requireRun(runId: string): Promise<void> {
    if ((await this.runDao.getById(runId, this.em.fork())) === null) {
      throw new NotFoundException('RUN_NOT_FOUND', 'no such chat');
    }
  }
}

function noSuchPage(): never {
  throw new NotFoundException(
    'ARTIFACT_NOT_FOUND',
    'this chat has no such page',
  );
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * One stored row as the listing names it, or null when it cannot address a
 * page.
 *
 * Every field but `summary` is required: without an id, a version and a key
 * there is no URL to frame, so a row missing any of them describes a page
 * nobody can open and listing it would put a dead row in the panel. The same
 * reading `readPublishedArtifact` takes on the renderer side — this is a
 * projection of a `z.unknown()` payload either way, so both readers have to be
 * defensive about it independently.
 */
function readRow(row: {
  seq: number;
  payload: string;
  createdAt: Date;
}): RunArtifactWire | null {
  // The column holds JSON TEXT (`Item.payload` is a string), so it is parsed
  // here rather than read as an object — reading it as one drops every row,
  // silently, which is exactly what this route did until a live call found it.
  const payload: unknown = parseJsonColumn(row.payload);
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const bag = payload as Record<string, unknown>;
  const artifactId = text(bag.artifactId);
  const title = text(bag.title);
  const key = text(bag.key);
  const { version } = bag;
  if (
    artifactId === null ||
    title === null ||
    key === null ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return null;
  }
  return {
    artifactId,
    version,
    title,
    summary: text(bag.summary),
    key,
    at: row.createdAt.toISOString(),
    seq: row.seq,
  };
}
