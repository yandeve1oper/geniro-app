import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every shared component is in the catalog, and every catalog entry is a
 * component.
 *
 * The design system's second hard rule — never duplicate a component, reuse the
 * primitive — had no mechanical check at all: the colour half is an eslint
 * override, and this half was review-only. A rule enforced by review alone is
 * enforced on the days someone remembers, and the failure is silent, because a
 * component nobody can SEE is a component the next person re-implements.
 *
 * What it enforces is DISCOVERABILITY, not de-duplication: no spec can tell
 * that two components do the same thing, only that both are in the catalog.
 *
 * The signal is the extension, which is exact here rather than a heuristic:
 * every component in these directories is `.tsx` and every helper and hook is
 * `.ts` (`ansi.ts`, `palette.ts`, `utils.ts`, `use-persisted-flag.ts`, …). So
 * "is this a component" needs no parsing of exports, and a hook cannot be
 * mistaken for one.
 *
 * Filesystem-only, on the same reasoning as `theme-tokens.spec.ts`: what is
 * being checked is which files exist, and jsdom can observe that nowhere.
 */

const RENDERER_ROOT = join(__dirname, '..');
const COMPONENTS_DIR = __dirname;

/**
 * The story namespace each component directory files under.
 *
 * Keyed by directory name, `''` being `components/` itself. Directories are
 * DISCOVERED from disk below and checked against this map, so adding
 * `components/<new-layer>/` fails here until its namespace is declared —
 * rather than going silently uncovered, which is the failure this whole spec
 * exists to close. The same shape as `theme-tokens.spec.ts` enumerating theme
 * files rather than listing themes.
 */
const NAMESPACES: Record<string, string> = {
  '': 'Components/',
  ui: 'Primitives/',
};

const FEATURE_NAMESPACES = {
  chats: 'Chats/',
  'chats/browser': 'Chats/',
  teams: 'Teams/',
  projects: 'Projects/',
  knowledge: 'Knowledge/',
  settings: 'Settings/',
  'command-center': 'Command center/',
};

/**
 * Components that legitimately have no story.
 *
 * Empty today. An entry here is a promise that the component cannot be
 * rendered in isolation at all — not that writing its story was awkward — and
 * it must carry the reason beside it. The test below earns itself the day an
 * entry is added: an exemption outliving its component silently re-opens the
 * hole it was opened for.
 */
const EXEMPT: readonly string[] = [];

const isStory = (name: string): boolean => /\.stories\.tsx?$/.test(name);
const isSpec = (name: string): boolean => /\.spec\.tsx?$/.test(name);

/** Component modules in a directory — `.tsx` that is neither story nor spec. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.tsx') && !isStory(name) && !isSpec(name))
    .sort();
}

function storyBaseNames(dir: string): Set<string> {
  return new Set(
    readdirSync(dir)
      .filter(isStory)
      .map((name) => name.replace(/\.stories\.tsx?$/, '')),
  );
}

/**
 * Every directory under `components/`, at any depth, plus `''` for the root.
 *
 * Recursive rather than one level down: a component parked in
 * `components/ui/forms/` would otherwise be seen by nothing — not the namespace
 * check, which only knew depth-1 names, and not the stray-story check, which
 * looks at stories rather than components.
 */
function componentDirectories(): string[] {
  const nested = readdirSync(COMPONENTS_DIR, {
    recursive: true,
    encoding: 'utf8',
  }).filter((entry) => statSync(join(COMPONENTS_DIR, entry)).isDirectory());
  return ['', ...nested].sort();
}

describe('the component catalog', () => {
  const directories = componentDirectories();

  it('declares a namespace for every component directory on disk', () => {
    // The uncoverage guard. A new `components/<layer>/` fails here rather than
    // being skipped by a hard-coded surface list.
    const undeclared = directories.filter(
      (dir) => NAMESPACES[dir] === undefined,
    );

    expect(undeclared).toEqual([]);
  });

  it('finds more than one directory, so the checks below span both layers', () => {
    // `readdirSync` THROWS on a missing directory, so a mistyped path fails
    // loudly rather than passing vacuously — what this guards is the other
    // case: a real directory that has gone empty.
    expect(directories.length).toBeGreaterThan(1);
  });

  describe.each(directories)('components/%s', (dir) => {
    const path = join(COMPONENTS_DIR, dir);
    const namespace = NAMESPACES[dir] ?? '';

    it('holds components to check', () => {
      expect(componentFiles(path).length).toBeGreaterThan(0);
    });

    it('gives every component a co-located story', () => {
      const stories = storyBaseNames(path);
      const missing = componentFiles(path)
        .map((name) => name.replace(/\.tsx$/, ''))
        .filter((base) => !EXEMPT.includes(base) && !stories.has(base));

      expect(missing).toEqual([]);
    });

    it('leaves no story without the component it documents', () => {
      // The reverse direction, on `theme-tokens.spec.ts`'s reasoning: a story
      // whose component was renamed or deleted still builds and still appears
      // in the sidebar, describing something that no longer exists.
      const components = new Set(
        componentFiles(path).map((name) => name.replace(/\.tsx$/, '')),
      );
      const orphans = [...storyBaseNames(path)].filter(
        (base) => !components.has(base),
      );

      expect(orphans).toEqual([]);
    });

    it('files every story under this directory’s own namespace', () => {
      // What organises the catalog's sidebar. Without it the directories
      // interleave under whatever title each story picked, and the
      // primitive/app-component layering stops being visible in the one place
      // it should be most obvious.
      const misfiled = readdirSync(path)
        .filter(isStory)
        .filter(
          (name) =>
            !readFileSync(join(path, name), 'utf8').includes(
              `title: '${namespace}`,
            ),
        );

      expect(misfiled).toEqual([]);
    });
  });

  it('keeps every story in the renderer inside a catalogued directory', () => {
    // `.storybook/main.ts` globs ALL of `src/renderer/**`, so a story authored
    // under a feature must still have its namespace and co-location checked.
    const known = new Set([
      ...directories.map((dir) => join(COMPONENTS_DIR, dir)),
      ...Object.keys(FEATURE_NAMESPACES).map((dir) => join(RENDERER_ROOT, dir)),
    ]);
    const strays = readdirSync(RENDERER_ROOT, {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((entry) => isStory(entry))
      .filter((entry) => !known.has(join(RENDERER_ROOT, entry, '..')));

    expect(strays).toEqual([]);
  });

  it.each(Object.entries(FEATURE_NAMESPACES))(
    'keeps %s stories co-located and in their namespace',
    (dir, namespace) => {
      const path = join(RENDERER_ROOT, dir);
      const components = new Set(
        componentFiles(path).map((name) => name.replace(/\.tsx$/, '')),
      );
      expect(
        [...storyBaseNames(path)].filter((base) => !components.has(base)),
      ).toEqual([]);
      expect(
        readdirSync(path)
          .filter(isStory)
          .filter(
            (name) =>
              !readFileSync(join(path, name), 'utf8').includes(
                `title: '${namespace}`,
              ),
          ),
      ).toEqual([]);
    },
  );

  it('names only components that still exist in the exemption list', () => {
    const known = directories.flatMap((dir) =>
      componentFiles(join(COMPONENTS_DIR, dir)).map((name) =>
        name.replace(/\.tsx$/, ''),
      ),
    );

    expect(EXEMPT.filter((base) => !known.includes(base))).toEqual([]);
  });
});
