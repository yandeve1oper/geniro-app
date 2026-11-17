import { describe, expect, it } from 'vitest';

import { parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  it('reads an open-ended, a closed and a suffix span', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 });
  });

  it('cuts a span running past the end at the last byte, and a suffix longer than the file at its start', () => {
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('answers unsatisfiable for a span that starts past the end or an empty suffix', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-5', 0)).toBe('unsatisfiable');
  });

  it('serves the whole file for no header, several spans, another unit or a reversed span', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
    expect(parseByteRange('bytes=20-10', 100)).toBeNull();
  });
});
