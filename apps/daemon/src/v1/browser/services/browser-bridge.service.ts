import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { awakeTimeout, type AwakeTimer } from '../../../utils/sleep-watch';
import {
  BROWSER_REQUEST_TIMEOUT_MS,
  type BrowserOutcome,
  BrowserReplySchema,
  type BrowserRequest,
} from '../browser.types';

export const BROWSER_NO_WINDOW_REASON =
  "No Geniro window on the Mac is connected to the daemon — open or reload Geniro's window, then try again.";
export const BROWSER_WINDOW_DISCONNECTED_REASON =
  "Geniro's window disconnected before the browser answered — try again.";
export const BROWSER_TIMEOUT_REASON = `The browser did not answer within ${BROWSER_REQUEST_TIMEOUT_MS / 1000} s.`;
export const BROWSER_CANCELLED_REASON = 'The call was cancelled.';

export type BrowserRequestEmitter = (
  socketId: string,
  event: 'browser_request',
  payload: BrowserRequest,
) => void;

interface PendingRequest {
  socketId: string;
  runId: string;
  settle: (outcome: BrowserOutcome) => void;
}

/**
 * The daemon's one line to the Mac's window: a browser operation goes out as
 * `browser_request` to the most recent desktop socket that offered to host it
 * and is still connected, and its `browser_reply` settles the promise. Never a
 * room, because the operation acts with the Mac's own browser.
 */
@Injectable()
export class BrowserBridgeService {
  private readonly logger = new Logger(BrowserBridgeService.name);
  private emitter: BrowserRequestEmitter | null = null;
  private readonly hostSocketIds: string[] = [];
  private readonly pending = new Map<string, PendingRequest>();

  attachEmitter(emit: BrowserRequestEmitter): void {
    this.emitter = emit;
  }

  register(socketId: string): void {
    this.forget(socketId);
    this.hostSocketIds.push(socketId);
  }

  unregister(socketId: string): void {
    if (!this.forget(socketId)) {
      return;
    }
    this.failWhere(
      (entry) => entry.socketId === socketId,
      BROWSER_WINDOW_DISCONNECTED_REASON,
    );
  }

  hasHost(): boolean {
    return this.hostSocketId() !== null && this.emitter !== null;
  }

  request(
    req: Omit<BrowserRequest, 'id'>,
    signal?: AbortSignal,
  ): Promise<BrowserOutcome> {
    const socketId = this.hostSocketId();
    const emit = this.emitter;
    if (socketId === null || emit === null) {
      return Promise.resolve({
        status: 'failed',
        reason: BROWSER_NO_WINDOW_REASON,
      });
    }
    if (signal?.aborted) {
      return Promise.resolve({
        status: 'failed',
        reason: BROWSER_CANCELLED_REASON,
      });
    }
    const id = randomUUID();
    return new Promise<BrowserOutcome>((resolve) => {
      let timer: AwakeTimer | null = null;
      const onAbort = (): void =>
        settle({ status: 'failed', reason: BROWSER_CANCELLED_REASON });
      const settle = (outcome: BrowserOutcome): void => {
        if (!this.pending.delete(id)) {
          return;
        }
        timer?.clear();
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      this.pending.set(id, { socketId, runId: req.runId, settle });
      timer = awakeTimeout(
        () => settle({ status: 'failed', reason: BROWSER_TIMEOUT_REASON }),
        BROWSER_REQUEST_TIMEOUT_MS,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        emit(socketId, 'browser_request', { ...req, id });
      } catch (err) {
        this.logger.warn(
          `failed to send browser_request: ${err instanceof Error ? err.message : String(err)}`,
        );
        settle({
          status: 'failed',
          reason: BROWSER_WINDOW_DISCONNECTED_REASON,
        });
      }
    });
  }

  reply(socketId: string, raw: unknown): void {
    if (!this.hostSocketIds.includes(socketId)) {
      this.logger.debug('ignored a browser_reply from an unregistered socket');
      return;
    }
    const parsed = BrowserReplySchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.debug('ignored a malformed browser_reply');
      return;
    }
    const reply = parsed.data;
    const entry = this.pending.get(reply.id);
    if (!entry || entry.socketId !== socketId) {
      return;
    }
    if (reply.ok) {
      entry.settle({
        status: 'done',
        text: reply.text,
        ...(reply.png === undefined ? {} : { png: reply.png }),
        ...(reply.viewPng === undefined ? {} : { viewPng: reply.viewPng }),
        ...(reply.tab === undefined ? {} : { tab: reply.tab }),
      });
    } else {
      entry.settle({ status: 'failed', reason: reply.error });
    }
  }

  rejectRun(runId: string, reason: string): void {
    this.failWhere((entry) => entry.runId === runId, reason);
  }

  private hostSocketId(): string | null {
    return this.hostSocketIds.at(-1) ?? null;
  }

  private forget(socketId: string): boolean {
    const index = this.hostSocketIds.indexOf(socketId);
    if (index === -1) {
      return false;
    }
    this.hostSocketIds.splice(index, 1);
    return true;
  }

  private failWhere(
    matches: (entry: PendingRequest) => boolean,
    reason: string,
  ): void {
    for (const entry of [...this.pending.values()]) {
      if (matches(entry)) {
        entry.settle({ status: 'failed', reason });
      }
    }
  }
}
