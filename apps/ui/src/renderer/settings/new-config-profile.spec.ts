import { describe, expect, it } from 'vitest';

import {
  collectMcpServerChoices,
  type McpSource,
  type McpSourceDocument,
  withCopiedMcpServers,
} from './new-config-profile';

const DEFAULT: McpSource = { label: 'Default', configDir: null };
const WORK: McpSource = { label: 'Work', configDir: '/cfg/work' };
const LAB: McpSource = { label: 'Lab', configDir: '/cfg/lab' };

function doc(
  path: string,
  servers: Record<string, Record<string, unknown>>,
): McpSourceDocument {
  return { path, servers, unavailableReason: null };
}

describe('collectMcpServerChoices', () => {
  it('offers each server once, defined by the first source, naming every source that has it', async () => {
    const documents = new Map<string | null, McpSourceDocument>([
      [null, doc('/home/.claude.json', { github: { command: 'gh-mcp' } })],
      [
        '/cfg/work',
        doc('/cfg/work/.claude.json', {
          github: { command: 'other' },
          linear: { url: 'https://mcp.linear.app' },
        }),
      ],
    ]);

    const { choices, unreadable } = await collectMcpServerChoices(
      [DEFAULT, WORK],
      (source) => Promise.resolve(documents.get(source.configDir)!),
    );

    expect(choices).toEqual([
      {
        name: 'github',
        definition: { command: 'gh-mcp' },
        from: 'Default, Work',
        carriesKeys: false,
      },
      {
        name: 'linear',
        definition: { url: 'https://mcp.linear.app' },
        from: 'Work',
        carriesKeys: false,
      },
    ]);
    expect(unreadable).toEqual([]);
  });

  it('says so when every configuration reads one and the same file', async () => {
    const one = doc('/home/.cursor/mcp.json', { notion: { url: 'x' } });

    const { choices, shared } = await collectMcpServerChoices(
      [DEFAULT, WORK],
      () => Promise.resolve(one),
    );

    expect(shared).toBe(true);
    expect(choices.map((choice) => choice.from)).toEqual(['Default']);
  });

  it('is not shared with one source, or with separate files', async () => {
    const single = await collectMcpServerChoices([DEFAULT], () =>
      Promise.resolve(doc('/home/a', {})),
    );
    const separate = await collectMcpServerChoices([DEFAULT, WORK], (source) =>
      Promise.resolve(doc(`/${source.label}`, {})),
    );

    expect(single.shared).toBe(false);
    expect(separate.shared).toBe(false);
  });

  it('marks a server whose definition holds environment values or headers', async () => {
    const { choices } = await collectMcpServerChoices([DEFAULT], () =>
      Promise.resolve(
        doc('/home/a', {
          github: { command: 'gh', env: { GITHUB_TOKEN: 't' } },
          linear: { url: 'u', headers: { Authorization: 'Bearer x' } },
          plain: { command: 'p', env: {} },
        }),
      ),
    );

    expect(choices.map((choice) => [choice.name, choice.carriesKeys])).toEqual([
      ['github', true],
      ['linear', true],
      ['plain', false],
    ]);
  });

  it('names the sources it could not read, and still offers the rest', async () => {
    const { choices, unreadable } = await collectMcpServerChoices(
      [DEFAULT, WORK, LAB],
      (source) => {
        if (source === WORK) {
          return Promise.reject(new Error('timeout'));
        }
        if (source === LAB) {
          return Promise.resolve({
            path: '/cfg/lab/config.toml',
            servers: null,
            unavailableReason: 'unparseable',
          });
        }
        return Promise.resolve(doc('/home/a', { one: {} }));
      },
    );

    expect(choices.map((choice) => choice.name)).toEqual(['one']);
    expect(unreadable).toEqual(['Work', 'Lab']);
  });
});

describe('withCopiedMcpServers', () => {
  it('adds the picked servers and never overwrites one the target already defines', () => {
    const { servers, added } = withCopiedMcpServers(
      { github: { command: 'mine' } },
      [
        {
          name: 'github',
          definition: { command: 'theirs' },
          from: 'Work',
          carriesKeys: false,
        },
        {
          name: 'linear',
          definition: { url: 'u' },
          from: 'Work',
          carriesKeys: false,
        },
      ],
    );

    expect(servers).toEqual({
      github: { command: 'mine' },
      linear: { url: 'u' },
    });
    expect(added).toEqual(['linear']);
  });
});
