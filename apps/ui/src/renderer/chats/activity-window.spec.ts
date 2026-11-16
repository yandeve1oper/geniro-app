import { describe, expect, it } from 'vitest';

import {
  customWindow,
  inWindow,
  windowOfPreset,
  windowQuery,
} from './activity-window';

const wednesday = new Date(2026, 10, 18, 15, 30);
const sunday = new Date(2026, 10, 22, 9, 0);

describe('windowOfPreset', () => {
  it('starts today at local midnight', () => {
    expect(windowOfPreset('today', wednesday)).toEqual({
      since: new Date(2026, 10, 18).toISOString(),
      until: null,
    });
  });

  it('starts since-yesterday at yesterday local midnight', () => {
    expect(windowOfPreset('since-yesterday', wednesday).since).toBe(
      new Date(2026, 10, 17).toISOString(),
    );
  });

  it('starts this week on Monday', () => {
    expect(windowOfPreset('this-week', wednesday).since).toBe(
      new Date(2026, 10, 16).toISOString(),
    );
  });

  it('starts this week six days back on a Sunday', () => {
    expect(windowOfPreset('this-week', sunday).since).toBe(
      new Date(2026, 10, 16).toISOString(),
    );
  });

  it('crosses a month boundary by calendar days', () => {
    expect(
      windowOfPreset('since-yesterday', new Date(2026, 11, 1, 1, 0)).since,
    ).toBe(new Date(2026, 10, 30).toISOString());
  });
});

describe('customWindow', () => {
  it('includes the first day and excludes the day after the last', () => {
    expect(customWindow('2026-11-10', '2026-11-12')).toEqual({
      since: new Date(2026, 10, 10).toISOString(),
      until: new Date(2026, 10, 13).toISOString(),
    });
  });

  it('accepts a single day', () => {
    expect(customWindow('2026-11-10', '2026-11-10')).toEqual({
      since: new Date(2026, 10, 10).toISOString(),
      until: new Date(2026, 10, 11).toISOString(),
    });
  });

  it('is null for empty, invalid or reversed input', () => {
    expect(customWindow('', '2026-11-12')).toBeNull();
    expect(customWindow('2026-11-10', '')).toBeNull();
    expect(customWindow('2026-13-40', '2026-11-12')).toBeNull();
    expect(customWindow('2026-11-12', '2026-11-10')).toBeNull();
  });
});

describe('inWindow', () => {
  const window = {
    since: '2026-11-16T00:00:00.000Z',
    until: '2026-11-17T00:00:00.000Z',
  };

  it('includes the start and excludes the end', () => {
    expect(inWindow({ lastActivityAt: window.since }, window)).toBe(true);
    expect(inWindow({ lastActivityAt: window.until }, window)).toBe(false);
  });

  it('excludes a row before the start', () => {
    expect(
      inWindow({ lastActivityAt: '2026-11-15T23:59:59.999Z' }, window),
    ).toBe(false);
  });

  it('never matches a row without activity', () => {
    expect(inWindow({ lastActivityAt: null }, window)).toBe(false);
    expect(inWindow({}, window)).toBe(false);
  });

  it('matches everything without a window', () => {
    expect(inWindow({ lastActivityAt: null }, null)).toBe(true);
  });

  it('is open-ended when until is null', () => {
    expect(
      inWindow(
        { lastActivityAt: '2030-01-01T00:00:00.000Z' },
        { since: window.since, until: null },
      ),
    ).toBe(true);
  });
});

describe('windowQuery', () => {
  it('is empty without a window', () => {
    expect(windowQuery(null)).toEqual({});
  });

  it('omits activeUntil when open-ended', () => {
    expect(windowQuery({ since: 'a', until: null })).toEqual({
      activeSince: 'a',
    });
  });

  it('carries both bounds', () => {
    expect(windowQuery({ since: 'a', until: 'b' })).toEqual({
      activeSince: 'a',
      activeUntil: 'b',
    });
  });
});
