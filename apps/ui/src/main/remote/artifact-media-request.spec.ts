import { describe, expect, it } from 'vitest';

import { isArtifactMediaRequest } from './artifact-media-request';

const RUN = '11111111-2222-4333-8444-555555555555';
const FILE = `${'a'.repeat(64)}.mp4`;
const KEY = 'b'.repeat(64);
const url = (path: string): URL => new URL(path, 'http://mac.local:4000');

describe('isArtifactMediaRequest', () => {
  it('admits a read of one page’s own audio or video under a key', () => {
    expect(
      isArtifactMediaRequest(
        'GET',
        url(`/v1/artifacts/${RUN}/walkthrough/media/${FILE}?key=${KEY}`),
      ),
    ).toBe(true);
    expect(
      isArtifactMediaRequest(
        'HEAD',
        url(`/v1/artifacts/${RUN}/walkthrough/media/${FILE}?key=${KEY}`),
      ),
    ).toBe(true);
  });

  it('refuses the page itself, another route, a write, a missing or malformed key, or an extra parameter', () => {
    const refused: [string, string][] = [
      ['GET', `/v1/artifacts/${RUN}/walkthrough?key=${KEY}`],
      ['GET', `/v1/chats/${RUN}/artifacts`],
      ['POST', `/v1/artifacts/${RUN}/walkthrough/media/${FILE}?key=${KEY}`],
      ['GET', `/v1/artifacts/${RUN}/walkthrough/media/${FILE}`],
      ['GET', `/v1/artifacts/${RUN}/walkthrough/media/${FILE}?key=short`],
      [
        'GET',
        `/v1/artifacts/${RUN}/walkthrough/media/${FILE}?key=${KEY}&raw=1`,
      ],
      ['GET', `/v1/artifacts/${RUN}/walkthrough/media/../meta.json?key=${KEY}`],
      [
        'GET',
        `/v1/artifacts/${RUN}/walkthrough/media/${'a'.repeat(64)}.html?key=${KEY}`,
      ],
      ['GET', `/v1/artifacts/not-a-run/walkthrough/media/${FILE}?key=${KEY}`],
    ];
    for (const [method, path] of refused) {
      expect(
        isArtifactMediaRequest(method, url(path)),
        `${method} ${path}`,
      ).toBe(false);
    }
  });
});
