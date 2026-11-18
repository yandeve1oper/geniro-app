import 'reflect-metadata';

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as SqliteMikroOrm } from '@mikro-orm/sqlite';
import { type INestApplication, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { buildBootstrapper } from '@packages/common';
import { buildHttpServerExtension } from '@packages/http-server';
import { buildMetricExtension } from '@packages/metrics';
import { buildMikroOrmExtension } from '@packages/mikroorm';

import { AppModule } from './app.module';
import { mintToken } from './auth/mint-token';
import type { RuntimeInfo } from './auth/runtime';
import { safeEqual } from './auth/safe-equal';
import mikroOrmConfig from './db/mikro-orm.config';
import { SqlEntityManagerModule } from './db/sql-entity-manager.module';
import { environment } from './environments';
import { installCrashGuards } from './utils/crash-guards';
import { type DaemonInfo, stampEntry } from './utils/handshake';
import {
  acquireInstanceLock,
  DAEMON_LOCK_FILE_NAME,
  DaemonAlreadyRunningError,
} from './utils/instance-lock';
import { closeInterruptedRuns } from './utils/interrupted-runs';
import { writeCrashMark, writePidfile } from './utils/pidfile';
import { consumeStopCause } from './utils/stop-cause';
import { MAX_REQUEST_BODY_BYTES } from './v1/agents/chat.types';
import { AgentAdapterRegistry } from './v1/agents/services/agent-adapter.registry';
import { ChatService } from './v1/agents/services/chat.service';
import { ChatTextIndexService } from './v1/agents/services/chat-text-index.service';
import { HostWakeChatDelivery } from './v1/agents/services/host-wake-chat-delivery.service';
import { ItemCallIndexService } from './v1/agents/services/item-call-index.service';
import { MonitorChatDelivery } from './v1/agents/services/monitor-chat-delivery.service';
import { PartialStreamService } from './v1/agents/services/partial-stream.service';
import { PayloadRefsSweepService } from './v1/agents/services/payload-refs-sweep.service';
import { PullRequestCaptureService } from './v1/agents/services/pull-request-capture.service';
import { StrandedChildReaper } from './v1/agents/services/stranded-child-reaper.service';
import { StrandedWorkReconcileService } from './v1/agents/services/stranded-work-reconcile.service';
import { WallWorkService } from './v1/agents/services/wall-work.service';
import {
  CHILD_JOURNAL_FILE_NAME,
  configureChildJournal,
} from './v1/agents/utils/child-journal';
import {
  configureDebugSink,
  DEBUG_LOG_DIR_NAME,
} from './v1/diagnostics/utils/debug-sink';
import { createPinoSinkStream } from './v1/diagnostics/utils/pino-sink-stream';
import { registerSecret } from './v1/diagnostics/utils/redact';
import { SinkLogger } from './v1/diagnostics/utils/sink-logger';
import { KnowledgeTextIndexService } from './v1/knowledge/services/knowledge-text-index.service';
import { MemoryReviewService } from './v1/memory/services/memory-review.service';
import { MemoryTextIndexService } from './v1/memory/services/memory-text-index.service';
import { MemoryUsageBackfillService } from './v1/memory/services/memory-usage-backfill.service';
import { MIGRATION_FAILED_EXIT_CODE } from './v1/migrations/migrations.types';
import { MigrationRunnerService } from './v1/migrations/services/migration-runner.service';
import { MigrationFailedError } from './v1/migrations/utils/migration-failed-error';
import { ShareService } from './v1/shares/services/share.service';
import { TeamLedgerService } from './v1/stats/services/team-ledger.service';
import { StorageService } from './v1/storage/services/storage.service';
import { TaskSettleService } from './v1/tasks/services/task-settle.service';
import { TeamCardsService } from './v1/teams/services/team-cards.service';
import { TeamExecutorService } from './v1/teams/services/team-executor.service';
import { TeamProposalService } from './v1/teams/services/team-proposal.service';
import { ThreadDeliveryService } from './v1/teams/services/thread-delivery.service';

/**
 * The one method of better-sqlite3's `Database` this file calls. No type
 * declarations for better-sqlite3 are installed, so the connection's
 * `getNativeClient()` hands the database back untyped.
 */
interface SqlitePragmas {
  pragma(source: string): unknown;
}

installCrashGuards({
  markCrash: () => writeCrashMark(environment.userDataDir, process.pid),
});

const startedAt = Date.now();
const token = mintToken();

// BEFORE the bootstrapper, and before the token can reach a log line.
//
// The sink has to exist ahead of Nest because the lines worth having when a
// launch goes wrong — the instance lock, the schema sync, the stranded-child
// reap — are all emitted before the first injectable exists. And the launch
// token is registered here, one statement after it is minted, so there is no
// window in which it could be written to a file unredacted. A credential a CLI
// inherits from the launching shell is registered as the adapter registry is
// built (`AgentAdapterRegistry` → `registerEnvIsolation`), before any turn can
// run.
configureDebugSink({
  dir: join(environment.userDataDir, DEBUG_LOG_DIR_NAME),
});
registerSecret(token, 'launch token');

// The daemon logs down TWO paths and only one of them was going anywhere. The
// vendored pino logger is teed by `createPinoSinkStream` below; everything
// using `new Logger(X)` from @nestjs/common — nearly every service here, plus
// Nest's own InstanceLoader/RouterExplorer/ExceptionHandler — went to the
// console alone. This captures that second path, which is the one that says
// WHY a boot failed. Console output is unchanged: SinkLogger extends
// ConsoleLogger and only adds a destination.
Logger.overrideLogger(new SinkLogger());
const runtime: RuntimeInfo = {
  token,
  version: environment.version,
  startedAt,
  port: null,
};

// Assembled exactly like Geniro's apps/api: a bootstrapper + extensions, started
// via `init()`. The local-first specifics — bind 127.0.0.1 (never a routable
// address), negotiate a free port if the preferred one is taken, and write the
// pidfile only after a healthy listen — ride on the http-server extension's
// `host` / `portFallback` / `onListening` options instead of a hand-rolled
// bootstrap. Shutdown is Nest-owned (enableShutdownHooks); PidfileLifecycle
// clears the pidfile on the way out, so main.ts needs no signal handling.
const bootstrapper = buildBootstrapper({
  environment: environment.env,
  appName: environment.appName,
  appVersion: environment.version,
});

/**
 * Resolved in the appChangeCb below and read from `onListening`, because the
 * sweep must start AFTER the ready print and `onListening` has no Nest app in
 * scope.
 *
 * The order is fixed by `packages/http-server/src/setup.ts` —
 * `buildHttpNestApp` → appChangeCb → `runHttpApp` → `listen` → `onListening` —
 * so this is always assigned by the time the listen callback fires.
 */
let callIndex: ItemCallIndexService | null = null;
let monitorChats: MonitorChatDelivery | null = null;
let hostWakeChats: HostWakeChatDelivery | null = null;
let shares: ShareService | null = null;
let threadDelivery: ThreadDeliveryService | null = null;
let wallWork: WallWorkService | null = null;
let payloadRefs: PayloadRefsSweepService | null = null;
let memoryUsage: MemoryUsageBackfillService | null = null;
let memoryMarks: MemoryReviewService | null = null;
let pullRequests: PullRequestCaptureService | null = null;
bootstrapper.addExtension(
  buildHttpServerExtension(
    {
      port: environment.preferredPort,
      host: environment.host,
      portFallback: true,
      // The swagger routes and the Scalar reference never reach the Nest
      // guard, and CORS is `*` — so the launch token is checked where they
      // are mounted, or any web page could read the whole API schema.
      swagger: {
        guard: (authorization) =>
          typeof authorization === 'string' &&
          safeEqual(authorization, `Bearer ${token}`),
      },
      // Fastify's default is 1MB, which silently under-cut the attachment
      // contract by 40x — see MAX_REQUEST_BODY_BYTES, which is computed from
      // that contract so the two can never again be set independently.
      fastifyOptions: { bodyLimit: MAX_REQUEST_BODY_BYTES },
      // Allow the renderer (file://, or the electron-vite dev origin) to call
      // the loopback REST API directly. Safe here: the daemon binds 127.0.0.1
      // only and every non-public route is token-gated — same posture as the
      // WS gateway's `cors.origin: '*'`. The bearer token, not the origin, is
      // the gate.
      corsOrigin: '*',
      onListening: ({ host, port }) => {
        // Written only after the schema is migrated (appChangeCb) and the server
        // is listening — a reader that sees the pidfile is guaranteed a healthy,
        // migrated daemon. `port` is the actually-bound one (may differ from the
        // preferred port when portFallback kicked in). The shared RuntimeInfo
        // learns it here — the executor mints per-run MCP URLs from it.
        runtime.port = port;
        const info: DaemonInfo = {
          pid: process.pid,
          host,
          port,
          token,
          version: environment.version,
          // `process.argv[1]` and not the resolved module path: it is the file
          // the supervisor named on the command line, so it is the same string
          // the supervisor will stamp when deciding whether this daemon is its
          // own current build.
          entry: stampEntry(process.argv[1] ?? '', statSync),
          pidStartedAtMs: Math.round(Date.now() - process.uptime() * 1000),
          startedAt: new Date(startedAt).toISOString(),
        };
        writePidfile(environment.pidfilePath, info);
        process.stdout.write(
          `GENIRO_DAEMON_READY ${JSON.stringify({ port })}\n`,
        );
        // AFTER the ready print, and deliberately NOT awaited: it stamps every
        // row of every team run written before `Item.inCall` existed, and
        // Nest awaits `onModuleInit` before the socket binds, so awaiting it
        // would hold the pidfile write and this print behind it — the app would
        // look hung on the first launch after an update. A run it has not
        // reached yet is stamped on its first read anyway.
        void callIndex?.indexAllQuietly();
        // Only now can a woken chat turn be handed geniro's tools, and every
        // boot reconcile it must not race has run — the interrupted-monitor
        // wakes the boot sweep held go out from here.
        monitorChats?.startDelivering();
        // On the same terms: an agent still owed the outcome of a share that
        // waited on the user's sign-in is woken again, once per boot.
        hostWakeChats?.startDelivering();
        void shares?.republishOwedWakes();
        void threadDelivery?.republishOwed();
        // Off the boot path too: it folds every agent of every run settled
        // before the wall ledger existed, and the ledger's per-turn key makes
        // it safe beside the live catch-up.
        void wallWork?.sweepAllQuietly();
        // Off the boot path for the same reason: it copies the payload fields
        // lookups filter on into their columns for every row written before
        // the columns existed — a run it has not reached is read the slow way.
        // The memory usage backfill follows it, since it finds a run's memory
        // calls through those columns and passes over a run not stamped yet.
        void (async () => {
          await payloadRefs?.sweepAllQuietly();
          await memoryUsage?.runQuietly();
          await memoryMarks?.sweepQuietly();
        })();
        // Off the boot path for the same reason: it re-reads from the start
        // every run scanned under an older pull-request rule — the one pass that
        // does, since a listing only carries a run on from its marker.
        void pullRequests?.rescanOutdatedQuietly();
      },
    },
    async (app: INestApplication) => {
      // FIRST, ahead of every other reconcile: a previous launch's SIGKILL
      // leaves detached agent groups reparented to launchd, still holding the
      // session files the reconciles below are about to reason over. Kill them
      // before this launch can resume any of those sessions — and before the
      // server listens, so no new turn can race the sweep.
      app.get(StrandedChildReaper).reap();

      // The journaled migrations, BEFORE the schema sync: a rename must run
      // before the sync can add the new name beside the old one. A failure
      // exits with MIGRATION_FAILED_EXIT_CODE (the catch below).
      await app.get(MigrationRunnerService).run();

      // Then the additive sync from the entities. `safe: true` never emits
      // destructive DDL, so a removed or renamed column keeps its data.
      const orm = app.get(MikroORM) as unknown as SqliteMikroOrm;
      await orm.schema.update({ safe: true });
      // WAL, so a process READING the database cannot make this daemon's
      // writes fail. Under the default rollback journal a reader holds a lock
      // the writer's commit must wait out, and better-sqlite3 gives up after
      // 5s with `database is locked` — which fails that turn's event chain and
      // marks the run failed when the turn ends. TRACED 2026-09-13 13:43: an
      // agent's own `sqlite3 -readonly … geniro.db` join, the minute the
      // daemon's write for that run failed. The mode is stored in the file, so
      // this only changes anything once. Switching needs a moment's exclusive
      // access, so a reader holding the file at this instant costs the switch
      // until the next launch, never the launch itself. Set through
      // better-sqlite3's own `pragma()` on the connection's database.
      await orm.em
        .getConnection()
        .getNativeClient()
        .then((database) =>
          (database as SqlitePragmas).pragma('journal_mode = wal'),
        )
        .catch((err: unknown) => {
          new Logger('Database').warn(
            `could not switch the database to WAL — staying on its current journal mode until the next launch: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });

      // A compaction the user asked for in Settings → Storage: here, before
      // listen, because it holds the write lock for its whole length and the
      // daemon's own writes give up after better-sqlite3's 5 s busy timeout.
      await app.get(StorageService).compactIfScheduled();

      // The full-text indexes (`db/chat-text-index.ddl.ts`,
      // `db/memory-text-index.ddl.ts`, `db/knowledge-text-index.ddl.ts`): AFTER
      // the schema sync, because a sync that rebuilds `items`, `memories` or
      // `knowledge_documents` drops the triggers these re-create,
      // and BEFORE listen, so no row can be written between the backfill and
      // the triggers that keep it current.
      await app.get(ChatTextIndexService).ensure();
      await app.get(MemoryTextIndexService).ensure();
      await app.get(KnowledgeTextIndexService).ensure();

      // Reconcile chat runs left `running` by a prior crash / SIGKILL. Runs HERE
      // (after the schema sync, before listen), in this explicit order. Nest's
      // OnApplicationBootstrap hooks fire later, inside `listen()`, with no
      // order among them that this sequence could rely on.
      const stopCause = await closeInterruptedRuns({
        readCause: () => consumeStopCause(environment.userDataDir),
        chats: app.get(ChatService),
        teams: app.get(TeamExecutorService),
        tasks: app.get(TaskSettleService),
        logError: (message) => new Logger('TaskSettleService').error(message),
      });

      // Close the background sub-agents, detached commands, command actions
      // and monitors a prior daemon left open: their ordinary writers run
      // in-process, so a SIGKILL leaves them open forever. No session can
      // exist this early, so every one still open on disk is stranded.
      await app.get(StrandedWorkReconcileService).reconcile(stopCause);

      // Put every STANDING question card back in the approval registry. Unlike
      // the reconciles above this restores something rather than closing it:
      // a deferred card is answered by starting a new turn, so it leaves the
      // daemon idle — and the idle shutdown then exits the process ten minutes
      // after the last window closes, long before a person who said "I'll
      // answer that later" comes back. AFTER the schema sync for the same
      // reason as its neighbours; it reads the `runs` table.
      await app.get(ChatService).rehydrateDeferredQuestions();
      // And every standing team proposal card, for the same reason.
      await app.get(TeamProposalService).rehydrate();
      // And a team lead's standing project-instructions card.
      await app.get(TeamCardsService).rehydrate();

      // Arm again every continue geniro PROMISED a team run at a
      // usage-limit reset. Its agents were told to wait for it rather than set
      // a timer of their own, so without this a restart in those hours leaves
      // a team waiting on a promise nothing is keeping any more.
      await app.get(TeamExecutorService).rehydrateResetWakes();

      // Put back what every agent had spent and no row records yet. Without it
      // a restart mid-turn made the header read the recorded total as the
      // whole bill — the money is real, and on the CLI's own ledger, but this
      // column is the only place geniro still knows it.
      await app.get(PartialStreamService).rehydrateUnrecordedSpend();

      // Stamp every team run the version ledger does not describe yet,
      // BEFORE listen: the renderer's archive-retention sweep reaches the
      // daemon only once it listens, and a run it deletes first would lose its
      // version for good. The ledger's bus subscriptions start in
      // `onModuleInit`, inside listen, so they never race this.
      await app.get(TeamLedgerService).sweep();

      // Resolved here, STARTED from `onListening` — see that comment. This is
      // the only line of it that may run before the server is up, and it only
      // reads the container.
      callIndex = app.get(ItemCallIndexService);
      monitorChats = app.get(MonitorChatDelivery);
      hostWakeChats = app.get(HostWakeChatDelivery);
      shares = app.get(ShareService);
      threadDelivery = app.get(ThreadDeliveryService);
      wallWork = app.get(WallWorkService);
      payloadRefs = app.get(PayloadRefsSweepService);
      memoryUsage = app.get(MemoryUsageBackfillService);
      memoryMarks = app.get(MemoryReviewService);
      pullRequests = app.get(PullRequestCaptureService);

      // Sweep what a prior crash left behind — per-turn files and directories
      // whose disposer only runs on a clean settle. Each adapter knows its own;
      // a SIGKILLed daemon skips every disposer.
      for (const adapter of app.get(AgentAdapterRegistry).all().values()) {
        adapter.sweepStaleState();
      }

      // Socket.IO transport for the renderer ⇄ daemon channel (token-gated in
      // NotificationsGateway), mirroring how Geniro's apps/api installs its
      // IoAdapter here — set before listen so the gateway binds to it.
      app.useWebSocketAdapter(new IoAdapter(app));

      return app;
    },
  ),
);

bootstrapper.addExtension(buildMikroOrmExtension(mikroOrmConfig));
bootstrapper.addExtension({ modules: [SqlEntityManagerModule] });
bootstrapper.addExtension(buildMetricExtension());
bootstrapper.setupLogger({
  prettyPrint: environment.prettyLog,
  level: environment.logLevel,
  // Everything the daemon logs ALSO lands in the debug sink — the ring the
  // panel reads and the file under `<userData>/logs`. Without this the daemon
  // only ever wrote to stdout, which in a packaged app launched from Finder
  // goes nowhere: every line was discarded in exactly the build where a user
  // would need it.
  streams: [createPinoSinkStream()],
});
bootstrapper.addModules([AppModule.forRoot({ runtime })]);

/**
 * Boot: claim the userData dir, start recording spawned child groups, then hand
 * over to the bootstrapper.
 *
 * The lock comes FIRST, ahead of the journal and of Nest. Everything below it
 * assumes a single writer — the SQLite file, the pidfile, the child journal —
 * so a second daemon must be turned away before it can touch any of them, not
 * after. It is also why the journal is configured here rather than at module
 * scope: a launch that stands down must not have written anything.
 */
acquireInstanceLock(join(environment.userDataDir, DAEMON_LOCK_FILE_NAME))
  .then(async (releaseLock) => {
    // Backstop only, for the failures BELOW that exit before Nest exists. The
    // clean-shutdown release is `InstanceLockLifecycle`: Nest re-raises the
    // signal after its hooks, and default signal termination never runs `exit`
    // listeners, so this one does not fire on a normal stop.
    process.on('exit', releaseLock);

    // Every detached child group is written here the moment it exists, so a
    // SIGKILL that skips Nest's shutdown hooks still leaves a record for the
    // next launch to reap. Unconfigured, `trackDetachedChild` is a no-op.
    configureChildJournal(
      join(environment.userDataDir, CHILD_JOURNAL_FILE_NAME),
      new Logger('ChildJournal'),
    );

    await bootstrapper.init();
  })
  .catch((err: unknown) => {
    if (err instanceof MigrationFailedError) {
      // Its own code, so the desktop app reads `migration-error.json` and stops
      // respawning a daemon that would fail the same step again.
      console.error(err.message);
      process.exit(MIGRATION_FAILED_EXIT_CODE);
    }
    if (err instanceof DaemonAlreadyRunningError) {
      // Not a crash: the app already has a daemon. Say so plainly rather than
      // burying it in a stack trace — this is the message a developer sees
      // when `pnpm daemon:dev` meets a running app.
      console.error(err.message);
      process.exit(1);
    }
    console.error('daemon failed to start', { err: String(err) });
    process.exit(1);
  });
