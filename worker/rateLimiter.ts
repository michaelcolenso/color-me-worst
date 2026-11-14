/**
 * Rate limiting backed by Durable Objects.
 *
 * Each key (one per client address, plus one shared key for the daily cap)
 * gets its own Durable Object holding a single counter. A Durable Object
 * handles one request at a time and its storage operations are atomic with
 * respect to other requests, so two simultaneous imports can never be counted
 * as one, and there is no per-key write-rate limit to trip over. Nothing has
 * to be created by hand before deploying: the binding and migration in
 * wrangler.jsonc are enough.
 */

import { DurableObject } from 'cloudflare:workers';

import type { RateLimiter } from './ingest';

interface Window {
  count: number;
  /** Milliseconds since the epoch at which this window ends. */
  resetAt: number;
}

const WINDOW_KEY = 'window';

/** One counter. Addressed by name; the name is the rate-limit key. */
export class RateLimitCounter extends DurableObject {
  /** Record one event. Resolves true when it is within `limit` for the current window. */
  async consume(limit: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    let window = await this.ctx.storage.get<Window>(WINDOW_KEY);
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowSeconds * 1000 };
      // Wipe this object's storage shortly after the window ends, so idle
      // counters (one per client address) do not accumulate for ever.
      await this.ctx.storage.setAlarm(window.resetAt + 60_000);
    }
    if (window.count >= limit) return false;
    window.count += 1;
    await this.ctx.storage.put(WINDOW_KEY, window);
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** The part of a Durable Object namespace binding this module uses. */
export interface RateLimitNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { consume(limit: number, windowSeconds: number): Promise<boolean> };
}

export function createDurableRateLimiter(namespace: RateLimitNamespace): RateLimiter {
  return {
    consume: (key, limit, windowSeconds) => namespace.get(namespace.idFromName(key)).consume(limit, windowSeconds),
  };
}
