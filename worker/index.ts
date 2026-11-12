/**
 * Cloudflare Worker entry point. Serves the built app from static assets and
 * answers /api/* itself.
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS             the built app in dist/
 *   ANTHROPIC_API_KEY  secret; photo import is off without it
 *   RATE_LIMIT         KV namespace; photo import is off without it
 *   VISION_MODEL       optional model override
 */

import type { CatalogBundle } from '../src/lib/catalog/seedBuilder';
import seedJson from '../src/data/catalogSeed.json';
import { createIngestApp, type KeyValueStore } from './ingest';
import { createClaudeVisionExtractor } from './vision';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ANTHROPIC_API_KEY?: string;
  RATE_LIMIT?: KeyValueStore;
  VISION_MODEL?: string;
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
            }),
          }
        : {}),
      ...(env.RATE_LIMIT ? { rateLimitStore: env.RATE_LIMIT } : {}),
    });
    return app.fetch(request);
  },
};
