import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  modelVocabularyKey,
  ModelVocabularyStore,
} from './model-vocabulary.store';

const AGENT = 'cursor-agent';
const MODEL = 'gpt-5.5';
const VERSION = '2026.08.11-e8db854';
const REPLY = '{"jsonrpc":"2.0","result":{"configOptions":[]}}';
const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-vocabularies-'));
  file = join(dir, 'model-vocabularies.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(records: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(records), 'utf8');
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: VERSION, fetchedAt: 0, value: REPLY, ...over };
}

const isText = (value: unknown): value is string => typeof value === 'string';

describe('ModelVocabularyStore — what it serves', () => {
  it('survives the daemon that took the answer', () => {
    // The whole reason it exists. In memory alone, every app restart paid the
    // 6.1–8.0s handshake again for a model the user had already opened, which
    // is what "должно быть практически мгновенно" was said about.
    const took = new ModelVocabularyStore({ file, now: () => 1_000 });
    took.remember(AGENT, MODEL, null, VERSION, REPLY);

    const nextLaunch = new ModelVocabularyStore({ file, now: () => 2_000 });

    expect(nextLaunch.read(AGENT, MODEL, null, VERSION, isText)?.value).toBe(
      REPLY,
    );
  });

  it('has the answer on disk by the time `remember` returns', () => {
    // The save used to be a floating promise, so NOTHING could know when it
    // landed: two `remember` calls in one tick raced each other's rename (the
    // older snapshot could win), and a caller that has to clean up behind the
    // store had only a delay to wait on — which is what failed on CI here,
    // `ENOTEMPTY` from this file's own teardown while a straggler staged its
    // tmp file inside the `rmSync`. Reverting fails HERE, at once, rather than
    // intermittently and somewhere else.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    store.remember(AGENT, MODEL, null, VERSION, REPLY);

    expect(existsSync(file)).toBe(true);
    expect(
      Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object),
    ).toEqual([modelVocabularyKey(AGENT, MODEL, null)]);
  });

  it('keeps the CLI-wide answer apart from any one model’s', () => {
    // A null model is its OWN key, not a missing one: "what does this CLI offer
    // at all" is a real question, and folding it into the first model's entry
    // would file that model's list as the CLI's.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, null, null, VERSION, 'the whole listing');
    store.remember(AGENT, MODEL, null, VERSION, REPLY);

    expect(store.read(AGENT, null, null, VERSION, isText)?.value).toBe(
      'the whole listing',
    );
    expect(store.read(AGENT, MODEL, null, VERSION, isText)?.value).toBe(REPLY);
  });

  it("keeps one ACCOUNT's answer apart from another's", () => {
    // The config directory is the account, and a vocabulary is an account fact
    // — measured, one login's two profiles report `max` and `team` from the
    // SAME binary, so the version already in the entry cannot tell them apart.
    // Drop the profile from the key and the second read serves the first
    // profile's answer.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, MODEL, '/profiles/team', VERSION, 'the team list');
    store.remember(AGENT, MODEL, '/profiles/max', VERSION, 'the max list');

    expect(
      store.read(AGENT, MODEL, '/profiles/team', VERSION, isText)?.value,
    ).toBe('the team list');
    expect(
      store.read(AGENT, MODEL, '/profiles/max', VERSION, isText)?.value,
    ).toBe('the max list');
    // And the CLI's own profile is a third answer, not a missing one.
    expect(store.read(AGENT, MODEL, null, VERSION, isText)).toBeNull();
  });

  it('refuses an entry taken under ANOTHER version of the CLI', () => {
    // The version is the freshness signal a TTL cannot be: a model's settings
    // change when the CLI does, and an upgrade must not be answered with its
    // predecessor's list.
    seed({ [modelVocabularyKey(AGENT, MODEL, null)]: record() });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, MODEL, null, VERSION, isText)?.value).toBe(REPLY);
    expect(
      store.read(AGENT, MODEL, null, '2026.09.01-newer', isText),
    ).toBeNull();
  });

  it('refuses to serve or store when the version could not be read', () => {
    // A null version is the one case that check cannot be performed, so both
    // directions are closed: serving would hand an upgraded CLI the old answer,
    // and storing would only ever occupy a slot nothing can match.
    seed({ [modelVocabularyKey(AGENT, MODEL, null)]: record() });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, MODEL, null, null, isText)).toBeNull();

    store.remember(AGENT, 'gpt-5.4', null, null, REPLY);

    expect(store.read(AGENT, 'gpt-5.4', null, VERSION, isText)).toBeNull();
  });

  it('refuses a value whose SHAPE has changed under it', () => {
    // The file outlives the build that wrote it, so a row whose shape has since
    // moved is exactly what a durable cache hands back. The guard is what turns
    // that into a re-ask instead of a picker full of rows it cannot render.
    seed({
      [modelVocabularyKey(AGENT, MODEL, null)]: record({ value: { old: 1 } }),
    });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, MODEL, null, VERSION, isText)).toBeNull();
  });
});

describe('ModelVocabularyStore — the last answer under any version', () => {
  it('serves an entry taken under another version of the CLI', () => {
    seed({ [modelVocabularyKey(AGENT, MODEL, null)]: record() });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.readAnyVersion(AGENT, MODEL, null, isText)).toBe(REPLY);
    expect(store.readAnyVersion(AGENT, MODEL, '/profiles/work', isText)).toBe(
      null,
    );
  });

  it('stops serving once the backstop is reached', () => {
    seed({ [modelVocabularyKey(AGENT, MODEL, null)]: record() });

    expect(
      new ModelVocabularyStore({ file, now: () => WEEK - 1 }).readAnyVersion(
        AGENT,
        MODEL,
        null,
        isText,
      ),
    ).toBe(REPLY);
    expect(
      new ModelVocabularyStore({ file, now: () => WEEK }).readAnyVersion(
        AGENT,
        MODEL,
        null,
        isText,
      ),
    ).toBeNull();
  });

  it('refuses a value whose shape has changed under it', () => {
    seed({
      [modelVocabularyKey(AGENT, MODEL, null)]: record({ value: { old: 1 } }),
    });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.readAnyVersion(AGENT, MODEL, null, isText)).toBeNull();
  });
});

describe('ModelVocabularyStore — when it stops being trusted', () => {
  it('serves an aged entry AND asks to be refreshed behind it', () => {
    // The mechanism for every cause this app cannot observe — a plan change, a
    // `cursor-agent login` in the user's own terminal. The user waits for
    // nothing and the answer is at most one interaction behind.
    seed({ [modelVocabularyKey(AGENT, MODEL, null)]: record() });

    const young = new ModelVocabularyStore({ file, now: () => HOUR - 1 }).read(
      AGENT,
      MODEL,
      null,
      VERSION,
      isText,
    );
    const aged = new ModelVocabularyStore({ file, now: () => HOUR }).read(
      AGENT,
      MODEL,
      null,
      VERSION,
      isText,
    );

    expect(young?.stale).toBe(false);
    // Still SERVED — a stale answer is the best anyone has, and withholding it
    // would spend the seconds this store exists to remove.
    expect(aged?.value).toBe(REPLY);
    expect(aged?.stale).toBe(true);
  });

  it('stops serving entirely once the backstop is reached', () => {
    seed({ [modelVocabularyKey(AGENT, MODEL, null)]: record() });

    expect(
      new ModelVocabularyStore({ file, now: () => WEEK - 1 }).read(
        AGENT,
        MODEL,
        null,
        VERSION,
        isText,
      )?.value,
    ).toBe(REPLY);
    expect(
      new ModelVocabularyStore({ file, now: () => WEEK }).read(
        AGENT,
        MODEL,
        null,
        VERSION,
        isText,
      ),
    ).toBeNull();
  });

  it('forgets ONE agent’s rows and leaves the other CLI’s alone', () => {
    // What a sign-in triggers. A new account is a different set of models —
    // for THAT CLI; the other one signed in to nothing.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, null, null, VERSION, 'cursor listing');
    store.remember(AGENT, MODEL, null, VERSION, REPLY);
    store.remember('claude', null, null, VERSION, 'claude listing');

    expect(store.forget(AGENT)).toBe(2);

    expect(store.read(AGENT, null, null, VERSION, isText)).toBeNull();
    expect(store.read(AGENT, MODEL, null, VERSION, isText)).toBeNull();
    expect(store.read('claude', null, null, VERSION, isText)?.value).toBe(
      'claude listing',
    );
  });

  it('forgets across launches, not just in memory', () => {
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, MODEL, null, VERSION, REPLY);
    store.forget(AGENT);

    const nextLaunch = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(nextLaunch.read(AGENT, MODEL, null, VERSION, isText)).toBeNull();
  });

  it('refuses an answer whose ask STARTED before the forget', () => {
    // A refresh already running when the user signed in lands afterwards
    // carrying the previous account's vocabulary; filing it would undo the
    // forget for a week. The ask's epoch, read before it was made, is what
    // tells the two apart.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    const askedAt = store.epoch(AGENT);

    store.forget(AGENT);
    store.remember(AGENT, MODEL, null, VERSION, REPLY, askedAt);

    expect(store.read(AGENT, MODEL, null, VERSION, isText)).toBeNull();
  });

  it('files an answer asked AFTER the forget, and ignores the other CLI’s', () => {
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    const claudeAskedAt = store.epoch('claude');
    store.forget(AGENT);
    const askedAt = store.epoch(AGENT);

    store.remember(AGENT, MODEL, null, VERSION, REPLY, askedAt);
    store.remember('claude', null, null, VERSION, 'claude', claudeAskedAt);

    expect(store.read(AGENT, MODEL, null, VERSION, isText)?.value).toBe(REPLY);
    expect(store.read('claude', null, null, VERSION, isText)?.value).toBe(
      'claude',
    );
  });
});

describe('ModelVocabularyStore — what it refuses to hold', () => {
  it('drops ONE corrupt row and keeps the rest', () => {
    // Validated per entry rather than per file: one bad row must not cost every
    // other model its answer and six seconds each to take again.
    seed({
      [modelVocabularyKey(AGENT, 'broken', null)]: { version: VERSION },
      [modelVocabularyKey(AGENT, MODEL, null)]: record(),
    });
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });

    expect(store.read(AGENT, 'broken', null, VERSION, isText)).toBeNull();
    expect(store.read(AGENT, MODEL, null, VERSION, isText)?.value).toBe(REPLY);
  });

  it('refuses a value too large to be a vocabulary', () => {
    // The file cap alone is reached too late: one implausible reply would fill
    // it and evict every model the user actually works with.
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    store.remember(AGENT, MODEL, null, VERSION, 'x'.repeat(256 * 1024 + 1));

    expect(existsSync(file)).toBe(false);
    expect(store.read(AGENT, MODEL, null, VERSION, isText)).toBeNull();
  });

  it('stops growing at the entry cap while every entry is still fresh', () => {
    const store = new ModelVocabularyStore({ file, now: () => 1_000 });
    for (let i = 0; i < 60; i += 1) {
      store.remember(AGENT, `model-${i}`, null, VERSION, REPLY);
    }
    store.remember(AGENT, 'one-too-many', null, VERSION, REPLY);

    expect(store.read(AGENT, 'one-too-many', null, VERSION, isText)).toBeNull();
    // …and the sixty already there are untouched, which is the point of
    // refusing rather than evicting: the oldest may be the model in use. Only
    // a DEAD row is reclaimed — see the case below.
    expect(store.read(AGENT, 'model-0', null, VERSION, isText)?.value).toBe(
      REPLY,
    );
  });

  it('reclaims entries past the freshness backstop before admitting a new one', () => {
    // The bug this guards: a full store of DEAD rows (past FRESH_FOR_MS, which
    // `read` already refuses to serve) used to keep every slot forever, so a
    // newly released model paid a cold handshake on every launch instead of
    // the one cold probe the design intends.
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) {
      seeded[modelVocabularyKey(AGENT, `model-${i}`, null)] = record({
        fetchedAt: 0,
      });
    }
    seed(seeded);

    const store = new ModelVocabularyStore({ file, now: () => WEEK });
    store.remember(AGENT, 'freshly-released', null, VERSION, REPLY);

    expect(
      store.read(AGENT, 'freshly-released', null, VERSION, isText)?.value,
    ).toBe(REPLY);
    // …and the dead rows are GONE, which is the half the title claims. Without
    // it, an implementation that merely skipped the cap check whenever any row
    // was stale would pass here while the file grew without bound.
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(onDisk)).toHaveLength(1);
    expect(onDisk[modelVocabularyKey(AGENT, 'model-0', null)]).toBeUndefined();
  });
});
