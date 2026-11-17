import { describe, expect, it } from 'vitest';

import { isHostArtifactAnswersCall, isHostArtifactCall } from './host-artifact';

describe('isHostArtifactCall', () => {
  const SERVER = 'geniro-ab12cd34';

  it('names the artifact tool on geniro’s own run-scoped server', () => {
    expect(isHostArtifactCall(SERVER, `mcp__${SERVER}__show_artifact`)).toBe(
      true,
    );
  });

  it('matches cursor’s measured title, `<server>-<tool>: <tool>`', () => {
    expect(
      isHostArtifactCall(SERVER, `${SERVER}-show_artifact: show_artifact`),
    ).toBe(true);
  });

  it('does not claim a same-named tool from another server', () => {
    expect(
      isHostArtifactCall(SERVER, 'mcp__some-other-server__show_artifact'),
    ).toBe(false);
  });

  it('refuses when the turn was granted no such tool', () => {
    expect(isHostArtifactCall(null, `mcp__${SERVER}__show_artifact`)).toBe(
      false,
    );
  });
});

describe('isHostArtifactAnswersCall', () => {
  const SERVER = 'geniro-ab12cd34';

  it('names the answers tool on geniro’s own server, and not the page tool or another server’s', () => {
    expect(
      isHostArtifactAnswersCall(SERVER, `mcp__${SERVER}__artifact_answers`),
    ).toBe(true);
    expect(
      isHostArtifactAnswersCall(SERVER, `mcp__${SERVER}__show_artifact`),
    ).toBe(false);
    expect(
      isHostArtifactAnswersCall(SERVER, 'mcp__other__artifact_answers'),
    ).toBe(false);
    expect(
      isHostArtifactAnswersCall(null, `mcp__${SERVER}__artifact_answers`),
    ).toBe(false);
  });
});
