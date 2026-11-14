/**
 * Cloudflare Worker entry point. Serves the built app from static assets and
 * answers /api/* itself.
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS             the built app in dist/
 *   RATE_LIMITER        Durable Object namespace that counts photo imports
 *   ANTHROPIC_API_KEY   secret; photo import is off without it
 *   VISION_MODEL        optional model override
 *   ANTHROPIC_BASE_URL  optional; route model calls through a gateway
 */

import type { CatalogBundle } from '../src/lib/catalog/seedBuilder';
import seedJson from '../src/data/catalogSeed.json';
import { createIngestApp } from './ingest';
import { createDurableRateLimiter, type RateLimitNamespace } from './rateLimiter';
import { createClaudeVisionExtractor } from './vision';

// The runtime finds Durable Object classes among the entry module's exports.
export { RateLimitCounter } from './rateLimiter';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER?: RateLimitNamespace;
  ANTHROPIC_API_KEY?: string;
  VISION_MODEL?: string;
  ANTHROPIC_BASE_URL?: string;
}

const catalog = (seedJson as unknown as CatalogBundle).items;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const app = createIngestApp({
      catalog,
      ...(env.ANTHROPIC_API_KEY
        ? {
            extract: createClaudeVisionExtractor({
              apiKey: env.ANTHROPIC_API_KEY,
              ...(env.VISION_MODEL ? { model: env.VISION_MODEL } : {}),
              ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
            }),
          }
        : {}),
      ...(env.RATE_LIMITER ? { rateLimiter: createDurableRateLimiter(env.RATE_LIMITER) } : {}),
    });
    return app.fetch(request);
  },
};
