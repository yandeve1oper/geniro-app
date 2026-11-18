import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { MemoryDao } from '../../memory/dao/memory.dao';
import { MemoryMarkDao } from '../../memory/dao/memory-mark.dao';
import { MemoryReviewFindingDao } from '../../memory/dao/memory-review-finding.dao';
import { MemoryUsageDao } from '../../memory/dao/memory-usage.dao';
import { Memory } from '../../memory/entity/memory.entity';
import { MemoryService } from '../../memory/services/memory.service';
import { MemoryEventBus } from '../../memory/services/memory-events.bus';
import { MemoryMarksService } from '../../memory/services/memory-marks.service';
import { MemoryUsageService } from '../../memory/services/memory-usage.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectInstructionChange } from '../../projects/entity/project-instruction-change.entity';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { RunGroup } from '../../runs/entity/run-group.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { LabelInstruction } from '../../tasks/entity/label-instruction.entity';
import { Task } from '../../tasks/entity/task.entity';
import { KnowledgeDocumentDao } from '../dao/knowledge-document.dao';
import { KnowledgeRevisionDao } from '../dao/knowledge-revision.dao';
import { KnowledgeDocument } from '../entity/knowledge-document.entity';
import { KnowledgeRevision } from '../entity/knowledge-revision.entity';
import { KnowledgeService } from '../services/knowledge.service';
import { KnowledgeEventBus } from '../services/knowledge-events.bus';
import { KnowledgeTextIndexService } from '../services/knowledge-text-index.service';

/** A real SQLite database with the knowledge store on it, as the app boots one. */
export async function knowledgeDb(options: { configured?: boolean } = {}) {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [
        KnowledgeDocument,
        KnowledgeRevision,
        Memory,
        Run,
        RunGroup,
        NodeState,
        Task,
        LabelInstruction,
        Project,
        ProjectInstructionChange,
      ],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const index = () =>
    new KnowledgeTextIndexService(new KnowledgeDocumentDao(em.fork()));
  await index().ensure();
  const events = new KnowledgeEventBus();
  const roots = {
    rootsOf: async (cwds: Iterable<string | null>) =>
      new Map(
        [...cwds]
          .filter((cwd): cwd is string => cwd !== null)
          .map((cwd) => [cwd, cwd]),
      ),
  } as unknown as ProjectRootsService;
  const scope = new ProjectScopeService(
    em,
    new TaskDao(em),
    new ProjectDao(em),
    roots,
  );
  const memory = new MemoryService(
    em,
    new MemoryDao(em),
    new RunDao(em),
    new NodeStateDao(em),
    new ProjectDao(em),
    scope,
    new MemoryEventBus(),
    new MemoryUsageService(new MemoryUsageDao(em)),
    new MemoryReviewFindingDao(em),
    new MemoryMarksService(
      new MemoryMarkDao(em),
      new MemoryUsageDao(em),
      new RunDao(em),
      new ItemDao(em),
    ),
  );
  const service = new KnowledgeService(
    em,
    new KnowledgeDocumentDao(em),
    new KnowledgeRevisionDao(em),
    new ProjectDao(em),
    scope,
    memory,
    events,
  );
  if (options.configured !== false) {
    service.setConfig({ enabled: true, agentWrites: 'review' });
  }
  return { orm, em, service, events, index, memory, scope };
}
