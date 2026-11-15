import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import {
  readTriageAnswer,
  TRIAGE_EXCERPT_MAX_CHARS,
  TRIAGE_REASON_MAX_CHARS,
  triagePrompt,
} from './memory-triage';

const notes = [
  { key: 'k1', title: 'first', body: 'one', folder: '/repo' },
  { key: 'k2', title: 'second', body: 'two', folder: null },
  { key: 'k3', title: 'third', body: 'three', folder: null },
];

describe('triagePrompt', () => {
  afterEach(() => clearSecrets());

  it('numbers each note, names its folder, clips its body and masks registered secrets', () => {
    registerSecret('sk-live-123456789', 'test');
    const prompt = triagePrompt([
      {
        key: 'k',
        title: 'token  note',
        body: `key sk-live-123456789 ${'x'.repeat(TRIAGE_EXCERPT_MAX_CHARS)}`,
        folder: '/repo/app',
      },
      { key: 'k2', title: 'plain', body: 'short', folder: null },
    ]);

    expect(prompt).toContain('[n1] token note\nfolder: /repo/app\n');
    expect(prompt).toContain('[n2] plain\nshort');
    expect(prompt).not.toContain('sk-live-123456789');
    expect(prompt).toContain('…');
  });

  it('asks about notes moving in for an import, and about entries already kept for a cleanup', () => {
    const forImport = triagePrompt(notes);
    const forCleanup = triagePrompt(notes, 'cleanup');

    expect(forImport).toContain(
      'The person is moving these notes into one shared memory',
    );
    expect(forImport).toContain('\nSKIP a note that is transient or noise');
    expect(forCleanup).not.toContain('moving these notes into');
    expect(forCleanup).toContain(
      'These notes are already in the shared memory that every future coding',
    );
    expect(forCleanup).toContain('still worth keeping or should be forgotten.');
    expect(forCleanup).toContain('\nFORGET a note that is transient or noise');
    expect(forCleanup).toContain('[{"id":"n1","keep":true,');
  });
});

describe('readTriageAnswer', () => {
  it('reads a fenced array, mapping ids back to keys in the answer order', () => {
    expect(
      readTriageAnswer(
        '```json\n[{"id":"n3","keep":true,"reason":"durable"},{"id":"n1","keep":false,"reason":"status"}]\n```',
        notes,
      ),
    ).toEqual([
      { key: 'k3', keep: true, reason: 'durable' },
      { key: 'k1', keep: false, reason: 'status' },
    ]);
  });

  it('drops entries naming no note, a note twice, or no verdict, and clips a long reason', () => {
    const verdicts = readTriageAnswer(
      JSON.stringify([
        { id: 'n9', keep: true },
        { id: 'n2', keep: 'yes' },
        { id: 'n1', keep: true, reason: 'r'.repeat(500) },
        { id: 'n1', keep: false, reason: 'again' },
        { id: 'x', keep: true },
        'n3',
      ]),
      notes,
    );

    expect(verdicts).toHaveLength(1);
    expect(verdicts![0]!.key).toBe('k1');
    expect(verdicts![0]!.keep).toBe(true);
    expect(verdicts![0]!.reason).toHaveLength(TRIAGE_REASON_MAX_CHARS);
  });

  it('answers null for prose or broken JSON', () => {
    expect(readTriageAnswer('keep them all', notes)).toBeNull();
    expect(readTriageAnswer('[{"id":"n1",', notes)).toBeNull();
    expect(readTriageAnswer('[] and [', notes)).toEqual([]);
  });
});
