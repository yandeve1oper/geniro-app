import {
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException, NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_ARTIFACT_MEDIA_BYTES,
  openArtifactMedia,
  sniffMediaExtension,
} from './artifact-media-policy';

function ftyp(brand: string): Buffer {
  return Buffer.from(
    `\u0000\u0000\u0000\u0018ftyp${brand}\u0000\u0000\u0000\u0000`,
    'latin1',
  );
}

const MP3_ID3 = Buffer.from(
  'ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000',
  'latin1',
);
const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
const AAC_ADTS = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f]);
const WAV = Buffer.from('RIFF$\u0000\u0000\u0000WAVEfmt ', 'latin1');
const OGG = Buffer.from('OggS\u0000\u0002\u0000\u0000', 'latin1');
const FLAC = Buffer.from('fLaC\u0000\u0000\u0000"', 'latin1');
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

function refusalOf(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      return error.errorCode;
    }
    throw error;
  }
}

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'geniro-artifact-media-'));
  outside = mkdtempSync(join(tmpdir(), 'geniro-artifact-media-outside-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('sniffMediaExtension', () => {
  it('names each format by its leading bytes', () => {
    const cases: [Buffer, string][] = [
      [MP3_ID3, 'mp3'],
      [MP3_FRAME, 'mp3'],
      [AAC_ADTS, 'aac'],
      [WAV, 'wav'],
      [OGG, 'ogg'],
      [FLAC, 'flac'],
      [WEBM, 'webm'],
      [ftyp('isom'), 'mp4'],
      [ftyp('mp42'), 'mp4'],
      [ftyp('M4A '), 'm4a'],
      [ftyp('qt  '), 'mov'],
    ];

    expect(cases.map(([bytes]) => sniffMediaExtension(bytes))).toEqual(
      cases.map(([, extension]) => extension),
    );
  });

  it('refuses a picture in the same container, and anything else', () => {
    expect(sniffMediaExtension(ftyp('avif'))).toBeNull();
    expect(sniffMediaExtension(ftyp('heic'))).toBeNull();
    expect(
      sniffMediaExtension(
        Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP', 'latin1'),
      ),
    ).toBeNull();
    expect(sniffMediaExtension(Buffer.from('plain text'))).toBeNull();
    expect(sniffMediaExtension(Buffer.alloc(0))).toBeNull();
  });
});

describe('openArtifactMedia', () => {
  it('opens a file inside an allowed folder, judged by its bytes, on a descriptor that reads it', () => {
    const body = Buffer.concat([
      ftyp('isom'),
      Buffer.from('rest of the movie'),
    ]);
    const file = join(root, 'clip.bin');
    writeFileSync(file, body);

    const media = openArtifactMedia(file, [root]);
    try {
      expect(media.extension).toBe('mp4');
      expect(media.size).toBe(body.length);
      expect(readFileSync(media.fd).equals(body)).toBe(true);
    } finally {
      closeSync(media.fd);
    }
  });

  it('refuses a file outside every allowed folder under its own code', () => {
    const file = join(outside, 'song.mp3');
    writeFileSync(file, MP3_ID3);

    expect(refusalOf(() => openArtifactMedia(file, [root]))).toBe(
      'MEDIA_OUTSIDE_ALLOWED_FOLDERS',
    );
  });

  it('refuses a link inside an allowed folder that leads out of it', () => {
    const target = join(outside, 'song.mp3');
    writeFileSync(target, MP3_ID3);
    const link = join(root, 'song.mp3');
    symlinkSync(target, link);

    expect(refusalOf(() => openArtifactMedia(link, [root]))).toBe(
      'MEDIA_OUTSIDE_ALLOWED_FOLDERS',
    );
  });

  it('refuses a file that is not audio or video, whatever its name', () => {
    const file = join(root, 'song.mp3');
    writeFileSync(file, 'not a song');

    expect(refusalOf(() => openArtifactMedia(file, [root]))).toBe(
      'MEDIA_TYPE_UNSUPPORTED',
    );
  });

  it('refuses a file over the per-file limit and accepts one exactly at it', () => {
    const over = join(root, 'over.webm');
    writeFileSync(over, WEBM);
    truncateSync(over, MAX_ARTIFACT_MEDIA_BYTES + 1);
    const at = join(root, 'at.webm');
    writeFileSync(at, WEBM);
    truncateSync(at, MAX_ARTIFACT_MEDIA_BYTES);

    expect(refusalOf(() => openArtifactMedia(over, [root]))).toBe(
      'MEDIA_TOO_LARGE',
    );
    const media = openArtifactMedia(at, [root]);
    closeSync(media.fd);
    expect(media.size).toBe(MAX_ARTIFACT_MEDIA_BYTES);
  });

  it('refuses a path that names no file as not found', () => {
    expect(
      refusalOf(() => openArtifactMedia(join(root, 'gone.mp3'), [root])),
    ).toBe('MEDIA_NOT_FOUND');
  });
});
