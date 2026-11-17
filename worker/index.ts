/**
 * Cloudflare Worker entry point. Serves the built app from static assets and
 * answers /api/* itself.
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS             the built app in dist/
 *   RATE_LIMITER        Durable Object namespace that counts photo imports
 *   GEMINI_API_KEY      secret; photo import is off without it
 *   VISION_MODEL        optional model override
 *   GEMINI_BASE_URL     optional; route model calls through a gateway
 */

import type { CatalogBundle } from '../src/lib/catalog/seedBuilder';
import seedJson from '../src/data/catalogSeed.json';
import { createIngestApp } from './ingest';
import { createDurableRateLimiter, type RateLimitNamespace } from './rateLimiter';
import { createGeminiVisionExtractor } from './vision';

// The runtime finds Durable Object classes among the entry module's exports.
export { RateLimitCounter } from './rateLimiter';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER?: RateLimitNamespace;
  GEMINI_API_KEY?: string;
  VISION_MODEL?: string;
  GEMINI_BASE_URL?: string;
}

const bundle = seedJson as unknown as CatalogBundle;
const catalog = bundle.items;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const app = createIngestApp({
      catalog,
      catalogRevision: bundle.revision,
      ...(env.GEMINI_API_KEY
        ? {
            extract: createGeminiVisionExtractor({
              apiKey: env.GEMINI_API_KEY,
              ...(env.VISION_MODEL ? { model: env.VISION_MODEL } : {}),
              ...(env.GEMINI_BASE_URL ? { baseUrl: env.GEMINI_BASE_URL } : {}),
            }),
          }
        : {}),
      ...(env.RATE_LIMITER ? { rateLimiter: createDurableRateLimiter(env.RATE_LIMITER) } : {}),
    });
    return app.fetch(request);
  },
};
