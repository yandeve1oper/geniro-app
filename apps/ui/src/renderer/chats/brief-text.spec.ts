import { describe, expect, it } from 'vitest';

import {
  bareUrl,
  briefParts,
  plainMarkdownText,
  plainPreview,
} from './brief-text';

describe('plainMarkdownText', () => {
  it('removes paired emphasis, code, heading and quote markers, keeping the words', () => {
    expect(
      plainMarkdownText(
        '## Task\n⚠️ **DO NOT PARK A QUESTION.** Read `call-broker.ts` and _then_ *answer*.\n> quoted',
      ),
    ).toBe(
      'Task\n⚠️ DO NOT PARK A QUESTION. Read call-broker.ts and then answer.\nquoted',
    );
  });

  it('keeps a link’s text and drops its target', () => {
    expect(
      plainMarkdownText(
        'See [CI-784](https://linear.app/x/issue/CI-784) first',
      ),
    ).toBe('See CI-784 first');
  });

  it('leaves unpaired markers and identifiers alone', () => {
    expect(
      plainMarkdownText('Match src/**/*.ts in snake_case_name, 2 * 3'),
    ).toBe('Match src/**/*.ts in snake_case_name, 2 * 3');
    expect(
      plainMarkdownText(
        'Update src/**/*.ts and test/**/*.spec.ts, then __init__.py',
      ),
    ).toBe('Update src/**/*.ts and test/**/*.spec.ts, then __init__.py');
    expect(plainMarkdownText('edit __init__ now; if __name__ ==')).toBe(
      'edit __init__ now; if __name__ ==',
    );
    expect(plainMarkdownText('«**не трогать**» и **x**—y')).toBe(
      '«не трогать» и x—y',
    );
    // Code spans keep their contents exactly, markers and all.
    expect(plainMarkdownText('Run `__main__` with `**/*.ts`')).toBe(
      'Run __main__ with **/*.ts',
    );
  });
});

describe('plainPreview — the sidebar row', () => {
  it('reads as one plain line: no bold markers, bullets or image syntax', () => {
    // The row printed the raw message and let CSS collapse it.
    expect(
      plainPreview(
        "**Google Docs read:**\n\n- **Read:** Sagar's doc\n- **Not found:** the bug-bash doc",
      ),
    ).toBe("Google Docs read: Read: Sagar's doc Not found: the bug-bash doc");
    expect(
      plainPreview('Here is the icon: ![the app icon](apps/ui/icon.png) done'),
    ).toBe('Here is the icon: the app icon done');
  });

  it('keeps paths and code spans as written', () => {
    expect(plainPreview('Saved to `src/**/*.ts` and __init__.py')).toBe(
      'Saved to src/**/*.ts and __init__.py',
    );
  });

  it('drops code fences and keeps what they hold', () => {
    expect(
      plainPreview('```json\n{"threads": 3}\n```\nThe threads on this Mac'),
    ).toBe('{"threads": 3} The threads on this Mac');
    expect(plainPreview('~~~\nls -la\n~~~')).toBe('ls -la');
  });
});

describe('briefParts', () => {
  it('states the first line and keeps the rest without blank ends', () => {
    expect(
      briefParts('\n**Implement CI-784** — finish it\n\nhttps://x.dev/a\n\n'),
    ).toEqual({
      title: 'Implement CI-784 — finish it',
      rest: ['https://x.dev/a'],
    });
  });

  it('answers an empty title for a brief with no words', () => {
    expect(briefParts('\n  \n')).toEqual({ title: '', rest: [] });
  });
});

describe('bareUrl', () => {
  it('reads a line that is only a web link, and nothing else', () => {
    expect(bareUrl('https://linear.app/x/issue/CI-784')?.host).toBe(
      'linear.app',
    );
    expect(bareUrl('see https://linear.app/x')).toBeNull();
    expect(bareUrl('file:///etc/passwd')).toBeNull();
    expect(bareUrl('javascript:alert(1)')).toBeNull();
    // Shaped like a link and not parseable as one.
    expect(bareUrl('https://[')).toBeNull();
  });
});
