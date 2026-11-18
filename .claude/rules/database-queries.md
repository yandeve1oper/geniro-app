---
description: Build daemon database queries with typed query builders, never raw SQL
paths:
  - "apps/daemon/src/**"
---

# Database queries

Every daemon query goes through MikroORM's QueryBuilder or its typed Kysely builder (`EntityManager.getKysely()`).

- Never hand-write SQL or SQL fragments: no SQL strings to `execute()`, no `raw()`, no SQL template tags. Express joins, filters, ordering, pagination, functions and mutations through builder methods.
- Pass dynamic values as builder parameters; never interpolate input into table names, column names or query text.
- Inside a transaction, build every read and write from that transaction's `EntityManager`.
- When a builder bypasses MikroORM's entity filters, add the soft-delete and scope filters explicitly.
- Read a row other code writes through a fork (`this.em.fork()`) or the caller's `EntityManager`, never the DAO's default. With `allowGlobalContext: true` that default is the global `EntityManager`, whose identity map keeps the first copy it loaded, so a later read returns stale fields — `BaseDao.getById(id)` without an `em` included.

## The three exceptions: the full-text indexes' DDL

- `db/chat-text-index.ddl.ts` (`chat_text`, FTS5 over `message`/`reasoning` items, triggers on `items`, repaired at boot by `ChatTextIndexService.ensure()`) `db/memory-text-index.ddl.ts` (`memories_fts`, FTS5 over each shared-memory entry's title and body, triggers on `memories`, repaired at boot by `MemoryTextIndexService.ensure()`) and `db/knowledge-text-index.ddl.ts` (`knowledge_fts`, FTS5 over each knowledge document's title, when-to-read line and body, triggers on `knowledge_documents`, repaired at boot by `KnowledgeTextIndexService.ensure()`).
- Their DDL (the FTS5 virtual table, its three triggers, and the rebuild's `DROP`s) is hand-written because no builder can express it, and so is `knowledge_fts`'s `rank` setting, an INSERT stored in `knowledge_fts_config` and lost on a drop and recreate, so `ensure()` runs it before its early return and after every rebuild. Each index sits outside the schema sync; its triggers keep it current.
- Every statement there is built from constants only, and it is DDL only — every query against an index uses the Kysely builder.
- Change a statement only by bumping that file's version (see its doc block).
- The FTS tables are listed in `schemaGenerator.skipTables` (`CHAT_TEXT_TABLES`, `MEMORY_TEXT_TABLES`, `KNOWLEDGE_TEXT_TABLES`); keep each in step with its table on a rename.
- The migration journal (`app_migrations`) is created by `MigrationRunnerService` through the Kysely schema builder, not hand-written DDL, and sits in `skipTables` too (`APP_MIGRATIONS_TABLES`). Migration steps express their DDL through the same builder (`apps/daemon/AGENTS.md` → *Migrations*).
- Any other need for raw SQL needs its own reason recorded here, or a typed way to say it.

## Recorded exception: compacting the database

- `v1/storage/utils/vacuum-database.ts` runs `VACUUM` and `wal_checkpoint(TRUNCATE)` on a connection of its own in a worker thread, for Settings → Storage. No builder expresses either, and both are constants. On the daemon's own connection the statement would hold the event loop for its whole length. It holds the write lock throughout, and the daemon's writes give up after better-sqlite3's 5 s busy timeout, so it runs only at daemon start, before listen (`StorageService.compactIfScheduled`).
- `StorageService.freeBytes` reads `freelist_count` and `page_size` through better-sqlite3's `pragma()`, as `main.ts` sets the journal mode.

## Recorded exception: pinning a query plan in a spec

- A spec may prefix `EXPLAIN QUERY PLAN` to a statement a DAO method sent and read the plan, to pin which index the read takes: captured from the connection's `execute` with its bound values (`item.dao.spec.ts` → `planOf`), or, for a `getKysely()` read, which never passes the connection, recorded as better-sqlite3 prepared it (`db/__tests__/sent-statements.ts`, `item.dao.spec.ts` → `inCallRowsOfKind`), and run again through the connection with the same values. No builder expresses it, it runs only in specs, and it executes nothing but the DAO's own statement. Production code never sends it.
