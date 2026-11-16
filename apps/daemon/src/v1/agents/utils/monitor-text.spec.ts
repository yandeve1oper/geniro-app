import { describe, expect, it } from 'vitest';

import type { HostRowWire, MonitorRowPayload } from '../chat.types';
import {
  monitorMessageText,
  promptNamingRunning,
  wakesOnMonitorProgress,
} from './monitor-text';

const message = (kind: 'stopped' | 'timeout') => ({
  id: 'm2',
  description: 'long wait',
  batch: { lines: [], omitted: 0 },
  end: { kind },
});

describe('monitorMessageText', () => {
  it('tells the agent the user stopped its monitor from the process panel', () => {
    const text = monitorMessageText(message('stopped'));
    expect(text).toContain(
      '<message from="long wait · monitor · stopped" monitor="m2">',
    );
    expect(text).toContain('The user stopped it from the process panel.');
  });

  it('names no one for an end that is not a stop', () => {
    expect(monitorMessageText(message('timeout'))).not.toContain('The user');
  });
});

describe('promptNamingRunning', () => {
  it('leaves the prompt alone when nothing runs', () => {
    expect(promptNamingRunning('output', [])).toBe('output');
  });

  it('names each running monitor after the output and how to stop it', () => {
    const text = promptNamingRunning('output', [
      { id: 'm1', description: 'seed run' },
      { id: 'm2', description: 'CI' },
    ]);
    expect(text.startsWith('output\n\n[geniro] Still running:')).toBe(true);
    expect(text).toContain('m1 (seed run), m2 (CI)');
    expect(text).toContain('stop_monitor');
  });
});

describe('wakesOnMonitorProgress', () => {
  const entry = (event: MonitorRowPayload['event']): MonitorRowPayload => ({
    id: 'm1',
    description: 'CI',
    event,
    lines: [],
    omitted: 0,
  });
  const row = (fields: Partial<HostRowWire>): HostRowWire => ({
    severity: 'info',
    message: '',
    woke: true,
    ...fields,
  });

  it('is true only while every monitor the row names is still running', () => {
    expect(
      wakesOnMonitorProgress(
        row({ monitors: [entry('batch'), entry('batch')] }),
      ),
    ).toBe(true);
    expect(
      wakesOnMonitorProgress(row({ monitors: [entry('batch'), entry('end')] })),
    ).toBe(false);
  });

  it('is false for a row that names no monitor batch', () => {
    expect(wakesOnMonitorProgress(row({ monitors: [] }))).toBe(false);
    expect(
      wakesOnMonitorProgress(
        row({ threadWake: { fromRunId: 'r2', fromTitle: 'Other' } }),
      ),
    ).toBe(false);
  });
});
