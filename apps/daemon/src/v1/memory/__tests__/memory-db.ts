import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { tempDir } from '../../agents/__tests__/temp-dir';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { MemoryDao } from '../dao/memory.dao';
import { MemoryMarkDao } from '../dao/memory-mark.dao';
import { MemoryReviewFindingDao } from '../dao/memory-review-finding.dao';
import { MemoryUsageDao } from '../dao/memory-usage.dao';
import { Memory } from '../entity/memory.entity';
import { MemoryMark } from '../entity/memory-mark.entity';
import { MemoryReviewFinding } from '../entity/memory-review-finding.entity';
import { MemoryUsageBackfill } from '../entity/memory-usage-backfill.entity';
import { MemoryUsageDay } from '../entity/memory-usage-day.entity';
import { MemoryService } from '../services/memory.service';
import { MemoryEventBus } from '../services/memory-events.bus';
import { MemoryFindingsService } from '../services/memory-findings.service';
import { MemoryMarksService } from '../services/memory-marks.service';
import { MemoryTextIndexService } from '../services/memory-text-index.service';
import {
  MEMORY_USAGE_MARKER_FILE,
  MemoryUsageService,
} from '../services/memory-usage.service';

/** The repository a task worktree resolves to, as `ProjectRootsService` would. */
export const ROOTS = new Map([['/wt/task-1', '/repo/app']]);

export async function memoryDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [
        Memory,
        MemoryMark,
        MemoryUsageDay,
        MemoryUsageBackfill,
        MemoryReviewFinding,
        Run,
        Item,
        NodeState,
        Task,
        Project,
      ],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const index = () => new MemoryTextIndexService(new MemoryDao(em.fork()));
  await index().ensure();
  const events = new MemoryEventBus();
  const usageDao = new MemoryUsageDao(em);
  const markerPath = join(tempDir('memory-usage-'), MEMORY_USAGE_MARKER_FILE);
  const usage = new MemoryUsageService(usageDao, markerPath);
  await usage.start();
  const roots = {
    rootsOf: async (cwds: Iterable<string | null>) =>
      new Map(
        [...cwds]
          .filter((cwd): cwd is string => cwd !== null)
          .map((cwd) => [cwd, ROOTS.get(cwd) ?? cwd]),
      ),
  } as unknown as ProjectRootsService;
  const marks = new MemoryMarksService(
    new MemoryMarkDao(em),
    usageDao,
    new RunDao(em),
    new ItemDao(em),
  );
  const service = new MemoryService(
    em,
    new MemoryDao(em),
    new RunDao(em),
    new NodeStateDao(em),
    new ProjectDao(em),
    new ProjectScopeService(em, new TaskDao(em), new ProjectDao(em), roots),
    events,
    usage,
    new MemoryReviewFindingDao(em),
    marks,
  );
  const findings = new MemoryFindingsService(
    em,
    new MemoryDao(em),
    new MemoryReviewFindingDao(em),
  );
  return {
    orm,
    em,
    service,
    marks,
    findings,
    events,
    index,
    usage,
    usageDao,
    markerPath,
  };
}

/** An entity with its defaults, as a row the app itself would write. */
export function make<T extends object>(
  entity: new () => T,
  data: Partial<T>,
): T {
  return Object.assign(new entity(), data);
}
