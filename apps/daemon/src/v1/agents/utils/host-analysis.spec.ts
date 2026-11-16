import { describe, expect, it } from 'vitest';

import {
  isHostAnalysisReadCall,
  isHostLessonsCall,
  isHostRecommendationsCall,
} from './host-analysis';

const SERVER = 'geniro-run1';

describe('host analysis tools', () => {
  it('approves the reader and the card tools on geniro’s own server only', () => {
    expect(
      isHostAnalysisReadCall(SERVER, `mcp__${SERVER}__read_analyzed_thread`),
    ).toBe(true);
    expect(
      isHostRecommendationsCall(
        SERVER,
        `mcp__${SERVER}__report_recommendations`,
      ),
    ).toBe(true);
    expect(
      isHostRecommendationsCall(SERVER, `mcp__${SERVER}__mark_recommendations`),
    ).toBe(true);
    expect(
      isHostAnalysisReadCall(SERVER, 'mcp__other__read_analyzed_thread'),
    ).toBe(false);
  });

  it('approves propose_lessons and check_lessons on geniro’s own server only', () => {
    expect(isHostLessonsCall(SERVER, `mcp__${SERVER}__propose_lessons`)).toBe(
      true,
    );
    expect(isHostLessonsCall(SERVER, `mcp__${SERVER}__check_lessons`)).toBe(
      true,
    );
    expect(isHostLessonsCall(SERVER, 'mcp__other__check_lessons')).toBe(false);
    expect(isHostLessonsCall(SERVER, `mcp__${SERVER}__read_chat_context`)).toBe(
      false,
    );
  });

  it('never approves the team save or the general history readers', () => {
    expect(
      isHostRecommendationsCall(SERVER, `mcp__${SERVER}__save_team_change`),
    ).toBe(false);
    expect(
      isHostAnalysisReadCall(SERVER, `mcp__${SERVER}__read_chat_context`),
    ).toBe(false);
  });
});
