import { describe, expect, it } from 'vitest';

import {
  shortenPath,
  stripLineNumbers,
  toolInputBody,
  toolLocationsBody,
  toolResultBody,
} from './tool-render';

describe('toolInputBody', () => {
  it('renders a shell call as its command, highlighted as shell', () => {
    // The screenshot bug: this used to print the whole {"command":…,
    // "description":…} envelope as raw JSON.
    expect(
      toolInputBody('Bash', {
        command: 'git show origin/develop:a.tf | head -160',
        description: 'Read the terraform',
      }),
    ).toEqual({
      kind: 'code',
      code: 'git show origin/develop:a.tf | head -160',
      language: 'bash',
      caption: 'Read the terraform',
    });
  });

  it('renders an edit as a diff, reusing the existing DiffView contract', () => {
    const body = toolInputBody('Edit', {
      file_path: '/proj/a.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(body).toEqual({
      kind: 'diff',
      oldText: 'const a = 1;',
      newText: 'const a = 2;',
      caption: '/proj/a.ts',
    });
  });

  it('renders a write as an all-additions diff, not a wall of JSON', () => {
    // editDiffOf already treats Write as "no old text, all new" — a new file
    // reads best as green additions, and reusing that beats a second path.
    expect(
      toolInputBody('Write', {
        file_path: '/proj/thing.py',
        content: 'x = 1\n',
      }),
    ).toEqual({
      kind: 'diff',
      oldText: null,
      newText: 'x = 1\n',
      caption: '/proj/thing.py',
    });
  });

  it('dispatches on SHAPE, so a differently-named shell tool still works', () => {
    // cursor-agent names its tools differently; keying on the name alone would
    // silently drop every one of them back to raw JSON.
    expect(
      toolInputBody('run_terminal_cmd', { command: 'ls -la' }),
    ).toMatchObject({ kind: 'code', code: 'ls -la', language: 'bash' });
  });

  it('falls back to highlighted JSON for a tool it does not recognize', () => {
    const body = toolInputBody('SomeFutureTool', { alpha: 1, beta: [2] });
    expect(body).toMatchObject({ kind: 'code', language: 'json' });
    expect(body?.kind === 'code' && body.code).toContain('"alpha": 1');
  });

  it('captions a path-only call with the path it targets', () => {
    expect(toolInputBody('Read', { file_path: '/proj/a.ts' })).toMatchObject({
      kind: 'code',
      caption: '/proj/a.ts',
    });
  });

  it('survives a payload JSON cannot stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toolInputBody('X', cyclic)).not.toThrow();
  });

  it('renders NO body for a call that disclosed no arguments', () => {
    // The reported defect: cursor names a read/search/edit call and sends an
    // EMPTY argument bag, which this function used to render as the literal
    // `{}` — stating the arguments were empty rather than absent. The row's
    // header already carries the tool name, which is the part that is known.
    expect(toolInputBody('Read File', {})).toBeNull();
  });

  it('renders NO body when there are no arguments at all', () => {
    // The daemon normalizes an empty bag to null before it ever reaches here
    // (`disclosedInput` in acp-driver.ts), so null is the shape this actually
    // receives in production — and `prettyJson` would have printed `null`.
    expect(toolInputBody('Read File', null)).toBeNull();
    expect(toolInputBody('Read File', undefined)).toBeNull();
  });
});

describe('toolResultBody', () => {
  it('highlights a file read in the language of the file that was read', () => {
    // The result is bare text — only the CALL's input can say what it is.
    expect(
      toolResultBody(
        { file_path: '/proj/a.py' },
        '     1\tx = 1\n     2\ty = 2',
      ),
    ).toEqual({
      kind: 'code',
      code: 'x = 1\ny = 2',
      language: 'python',
      caption: null,
    });
  });

  it('leaves command OUTPUT unhighlighted', () => {
    // Painting arbitrary stdout as shell would colour ordinary words as
    // keywords, which reads as noise rather than structure.
    expect(toolResultBody({ command: 'ls' }, 'a.ts\nb.ts')).toMatchObject({
      language: null,
    });
  });

  it('says a settled call reported no result instead of printing null', () => {
    for (const result of [null, undefined]) {
      expect(toolResultBody({ command: 'ls' }, result)).toEqual({
        kind: 'code',
        code: 'No result reported',
        language: null,
        caption: null,
      });
    }
  });

  it('highlights a structured result as JSON', () => {
    expect(toolResultBody(null, { ok: true })).toMatchObject({
      language: 'json',
    });
  });

  it('collapses a CLI content-block array to its text', () => {
    // Moved here with the function: the caller used to normalize this before
    // calling, which is what made a diff unrecognisable by the time it arrived.
    expect(
      toolResultBody(null, [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).toMatchObject({ code: 'one\ntwo' });
  });

  describe('a diff the agent reported as the result', () => {
    // The reported defect: a cursor edit discloses no arguments and reports the
    // whole change on completion, which rendered as
    // `[{"type":"diff","path":"/private/tmp/…","oldText":"alpha\nbeta\n"…}]` —
    // escaped newlines in a JSON block, for a change the app can draw.
    const diffResult = {
      diffs: [
        {
          path: '/w/notes.txt',
          oldText: 'alpha\nbeta\n',
          newText: 'alpha\nBETA edited\n',
        },
      ],
    };

    it('renders as a diff, captioned with the file it changed', () => {
      expect(toolResultBody(null, diffResult)).toEqual({
        kind: 'diff',
        oldText: 'alpha\nbeta\n',
        newText: 'alpha\nBETA edited\n',
        caption: '/w/notes.txt',
      });
    });

    it('treats a creation (no previous text) as an all-added diff', () => {
      expect(
        toolResultBody(null, {
          diffs: [{ path: '/w/new.txt', newText: 'hi' }],
        }),
      ).toMatchObject({ kind: 'diff', oldText: null, newText: 'hi' });
    });

    it('SAYS what it is not showing when a call reported several diffs', () => {
      // A body is one diff. Silently rendering the first would leave a reader
      // believing they had seen the whole change.
      expect(
        toolResultBody(null, {
          diffs: [
            { path: '/w/a.txt', newText: 'a' },
            { path: '/w/b.txt', newText: 'b' },
            { path: '/w/c.txt', newText: 'c' },
          ],
        }),
      ).toMatchObject({
        kind: 'diff',
        newText: 'a',
        caption: '/w/a.txt · 2 more files changed, not shown',
      });
    });

    it('falls back to JSON for a diffs field that is not renderable', () => {
      // Defensive: the shape is read off an untyped payload, so a drifted one
      // must degrade to the old rendering rather than an empty diff panel.
      expect(
        toolResultBody(null, { diffs: [{ path: '/w/a.txt' }] }),
      ).toMatchObject({ kind: 'code', language: 'json' });
      expect(toolResultBody(null, { diffs: 'nope' })).toMatchObject({
        kind: 'code',
      });
    });
  });
});

describe('stripLineNumbers', () => {
  it('drops a cat -n gutter so the body highlights as its language', () => {
    expect(stripLineNumbers('     1\tconst a = 1;\n     2\tconst b = 2;')).toBe(
      'const a = 1;\nconst b = 2;',
    );
  });

  it('leaves text alone unless EVERY line carries a gutter', () => {
    // A file whose first line merely starts with a number must not be shaved.
    expect(stripLineNumbers('     1\tconst a = 1;\nplain line')).toBe(
      '     1\tconst a = 1;\nplain line',
    );
  });
});

describe('shortenPath', () => {
  it('leaves a path that already fits alone', () => {
    expect(shortenPath('/w/notes.txt')).toBe('/w/notes.txt');
  });

  it('elides from the FRONT, so the filename survives', () => {
    // The defect this exists for: a caption of
    // `/private/tmp/claude-501/-Users-…/scrat…` named a directory prefix and
    // never reached the file that had changed.
    const long =
      '/private/tmp/claude-501/-Users-sergeirazumovskij-Desktop-Projects/7d4eb474/scratchpad/chat-cwd/notes.txt';
    const short = shortenPath(long);

    expect(short.startsWith('…/')).toBe(true);
    expect(short.endsWith('notes.txt')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(52);
  });

  it('keeps the filename even when one segment alone exceeds the budget', () => {
    const path = `/${'x'.repeat(80)}/file.ts`;
    expect(shortenPath(path)).toBe('…/file.ts');
  });
});

describe('toolLocationsBody — the files a call named', () => {
  it('names the file, with its line only where the agent set one', () => {
    // Measured on cursor-agent 2026.08.31-4057e58: `read` is the one kind that
    // sets a line, from `args.offset`, and only above zero.
    expect(
      toolLocationsBody({
        locations: [
          { path: '/repo/src/a.ts', line: 42 },
          { path: '/repo/src/b.ts', line: null },
        ],
      }),
    ).toMatchObject({
      kind: 'code',
      code: '/repo/src/a.ts:42\n/repo/src/b.ts',
      // Not highlighted: a path list is not code, and painting it as some
      // language would be a claim about it.
      language: null,
    });
  });

  it('answers null when the call named no files', () => {
    // Which is every claude row — its calls disclose their arguments, so the
    // ordinary body path has already answered and this must not override it.
    expect(
      toolLocationsBody({ input: { file_path: '/repo/a.ts' } }),
    ).toBeNull();
    expect(toolLocationsBody({ locations: [] })).toBeNull();
    expect(toolLocationsBody(null)).toBeNull();
  });

  it('drops an entry that names no file rather than rendering a blank line', () => {
    expect(
      toolLocationsBody({ locations: [{ line: 3 }, { path: '/repo/c.ts' }] }),
    ).toMatchObject({ code: '/repo/c.ts' });
  });
});
