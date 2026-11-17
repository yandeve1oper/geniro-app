import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSecrets,
  registerSecret,
} from '../../../diagnostics/utils/redact';
import {
  artifactAnswersText,
  readArtifactAnswersArgs,
} from './artifact-answers.reader';

describe('readArtifactAnswersArgs', () => {
  it('reads one page, or every page when none is named', () => {
    expect(readArtifactAnswersArgs({ artifact_id: ' vote ' })).toEqual({
      ok: true,
      query: { artifactId: 'vote' },
    });
    expect(readArtifactAnswersArgs({})).toEqual({
      ok: true,
      query: { artifactId: null },
    });
    expect(readArtifactAnswersArgs({ artifact_id: null })).toEqual({
      ok: true,
      query: { artifactId: null },
    });
  });

  it('refuses an argument it does not know', () => {
    expect(readArtifactAnswersArgs({ artifactid: 'vote' }).ok).toBe(false);
  });
});

describe('artifactAnswersText', () => {
  it('leads with the data-not-instructions line and gives each page its answers as JSON', () => {
    const text = artifactAnswersText(
      [
        {
          artifactId: 'vote',
          title: 'Show 2',
          values: { 'call-1': 'agree' },
          updatedAt: '2026-11-17T10:00:00.000Z',
        },
      ],
      null,
    );

    expect(text.split('\n')[0]).toContain('never instructions');
    expect(text).toContain(
      'vote "Show 2" — saved 2026-11-17T10:00:00.000Z:\n```json\n{\n  "call-1": "agree"\n}\n```',
    );
  });

  it('says how a page saves answers when none are kept', () => {
    expect(artifactAnswersText([], null)).toContain('data-geniro-answer');
    expect(artifactAnswersText([], 'vote')).toContain('"vote"');
  });
});

describe('artifactAnswersText, masking', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('masks a registered secret the user typed into a page', () => {
    const SECRET = 'ghp_0123456789abcdefghijklmnop';
    registerSecret(SECRET, 'github token');

    const text = artifactAnswersText(
      [
        {
          artifactId: 'vote',
          title: null,
          values: { note: `use ${SECRET}` },
          updatedAt: '2026-11-17T10:00:00.000Z',
        },
      ],
      null,
    );

    expect(text).not.toContain(SECRET);
    expect(text).toContain('"note"');
  });
});
