import { closeSync, readSync } from 'node:fs';

import { BadRequestException } from '@packages/common';

import type { ArtifactMediaExtension } from './artifact-html-images';
import {
  type ArtifactFileKind,
  megabytes,
  openArtifactFile,
} from './artifact-image-policy';

/** The largest single audio or video file one published page may play. */
export const MAX_ARTIFACT_MEDIA_BYTES = 256 * 1024 * 1024;

/**
 * The most audio and video bytes one published page may hold. Each distinct file
 * counts once: the page streams it from the media route rather than carrying it.
 */
export const MAX_ARTIFACT_PAGE_MEDIA_BYTES = 1024 * 1024 * 1024;

/** The most distinct audio and video files one published page may hold. */
export const MAX_ARTIFACT_PAGE_MEDIA = 16;

const MEDIA_FILES: ArtifactFileKind = {
  code: 'MEDIA',
  noun: 'audio or video',
  plural: 'audio or video',
};

/** How many leading bytes the format is judged from. */
const SNIFF_BYTES = 16;

/** One local audio or video file a page plays, open for streaming into the store. */
export interface OpenedArtifactMedia {
  /** Owned by the caller, who streams from it and closes it. */
  readonly fd: number;
  readonly size: number;
  readonly extension: ArtifactMediaExtension;
}

/**
 * Opens one local audio or video file a page refers to, or refuses it with the reason.
 *
 * The path is judged by the same rules as a picture's (`openArtifactFile`); the type
 * is decided by the file's first bytes, never its name. The file is left open rather
 * than read, because it can be hundreds of megabytes: the store streams it from this
 * same descriptor, so what is copied is the file that was judged.
 */
export function openArtifactMedia(
  path: string,
  allowedRoots: readonly string[],
): OpenedArtifactMedia {
  const { fd, size } = openArtifactFile(path, allowedRoots, MEDIA_FILES);
  try {
    if (size > MAX_ARTIFACT_MEDIA_BYTES) {
      throw new BadRequestException(
        'MEDIA_TOO_LARGE',
        `${path} is ${megabytes(size)} MB, over the ${megabytes(MAX_ARTIFACT_MEDIA_BYTES)} MB per-file limit`,
      );
    }
    const head = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, head, 0, SNIFF_BYTES, 0);
    const extension = sniffMediaExtension(head.subarray(0, read));
    if (extension === null) {
      throw new BadRequestException(
        'MEDIA_TYPE_UNSUPPORTED',
        `${path} is not an mp3, aac, m4a, mp4, mov, wav, ogg, flac or webm file`,
      );
    }
    return { fd, size, extension };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** ISO base media brands that are pictures, not audio or video. */
const PICTURE_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'mif1',
  'msf1',
]);

/**
 * The format a file's leading bytes declare, or null for anything else. MP4, M4A
 * and MOV share one container, told apart by its major brand; MP3 and ADTS AAC
 * share a frame sync, told apart by the layer bits, which AAC leaves at zero.
 */
export function sniffMediaExtension(
  bytes: Buffer,
): ArtifactMediaExtension | null {
  const head = bytes.toString('latin1');
  if (head.startsWith('ID3')) {
    return 'mp3';
  }
  const second = bytes[1] ?? 0;
  if (bytes[0] === 0xff && (second & 0xe0) === 0xe0) {
    return (second & 0x06) === 0 ? 'aac' : 'mp3';
  }
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') {
    return 'wav';
  }
  if (head.startsWith('OggS')) {
    return 'ogg';
  }
  if (head.startsWith('fLaC')) {
    return 'flac';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'webm';
  }
  if (head.slice(4, 8) === 'ftyp' && head.length >= 12) {
    const brand = head.slice(8, 12);
    if (PICTURE_BRANDS.has(brand)) {
      return null;
    }
    if (brand === 'qt  ') {
      return 'mov';
    }
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) {
      return 'm4a';
    }
    return 'mp4';
  }
  return null;
}
