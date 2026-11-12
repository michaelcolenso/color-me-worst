/**
 * Stash onboarding API: turn a pasted list or a photo of a paint rack into
 * catalogue items.
 *
 * Division of labour, which is the point of the design:
 *   - A vision model only READS: it returns the brand, name and code printed
 *     on each label it can see, as plain strings in a fixed JSON shape.
 *   - Deterministic code then MATCHES those strings against the catalogue
 *     with the same rule-based resolver the recipe translator uses.
 * The model never chooses a catalogue item, never returns a colour, and
 * anything it reads that matches nothing is reported as unmatched. Its output
 * is treated as untrusted text throughout.
 *
 * This module has no dependency on Cloudflare or on the Anthropic SDK: the
 * vision call and the rate-limit store are passed in, so the whole request
 * path is unit-tested with fakes.
 */

import { Hono } from 'hono';

import { createRecipeResolver, type RecipeResolver, type ResolvedRecipeLine } from '../src/lib/catalog/recipeParser';
import type { CatalogItem } from '../src/lib/color/types';

/** Media types the vision model accepts. */
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Largest decoded image accepted, in bytes. The app downsizes photos well below this before upload. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest pasted list accepted, in characters. */
export const MAX_TEXT_LENGTH = 20_000;
/** Most labels kept from one photo; a guard against a runaway model response. */
export const MAX_LABELS = 300;

export interface IngestImage {
  mediaType: ImageMediaType;
  /** Base64, no data-URL prefix. */
  data: string;
}

/** One product label as read from a photo. Every field is untrusted text. */
export interface ExtractedLabel {
  brand: string | null;
  name: string | null;
  code: string | null;
}

export type VisionResult =
  | { kind: 'labels'; labels: ExtractedLabel[] }
  /** The model declined to process the image. */
  | { kind: 'refused' }
  /** The model answered, but not in the required shape. */
  | { kind: 'unreadable' };

/** Reads product labels out of an image. Implemented with Claude in vision.ts. */
export type VisionExtractor = (image: IngestImage) => Promise<VisionResult>;

/** The slice of a Workers KV namespace the rate limiter uses. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface IngestLimits {
  /** Photo requests allowed per client address per hour. */
  perClientPerHour: number;
  /** Photo requests allowed in total per UTC day: a ceiling on spend. */
  perDay: number;
}

export const DEFAULT_LIMITS: IngestLimits = { perClientPerHour: 20, perDay: 500 };

export interface IngestDependencies {
  catalog: readonly CatalogItem[];
  /** Omit to disable photo import; text import still works. */
  extract?: VisionExtractor;
  /** Required for photo import: without a counter there is no brake on cost. */
  rateLimitStore?: KeyValueStore;
  limits?: IngestLimits;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** A catalogue item reference small enough to send to the client. */
export interface IngestItemRef {
  id: string;
  brand: string;
  line: string;
  name: string;
  sku: string;
}

export interface IngestEntry {
  /** What was read or typed. */
  label: string;
  /** Best catalogue match, or null when nothing matched. */
  match: IngestItemRef | null;
  /** Other items that matched equally well; the user should choose. */
  alternatives: IngestItemRef[];
}

export interface IngestResponse {
  source: 'text' | 'image';
  entries: IngestEntry[];
}

export interface IngestError {
  error: { code: string; message: string };
}

const toRef = (item: CatalogItem): IngestItemRef => ({
  id: item.id,
  brand: item.brand,
  line: item.line,
  name: item.name,
  sku: item.sku,
});

function toEntry(label: string, resolved: ResolvedRecipeLine): IngestEntry {
  if (resolved.kind !== 'item') return { label, match: null, alternatives: [] };
  return { label, match: toRef(resolved.item), alternatives: resolved.alternatives.map(toRef) };
}

/** Collapse whitespace, drop control characters and cap the length of model- or user-supplied text. */
function cleanText(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Match labels read from a photo against the catalogue, merging repeats of the same item. */
export function matchLabels(labels: readonly ExtractedLabel[], resolver: RecipeResolver): IngestEntry[] {
  const entries: IngestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of labels.slice(0, MAX_LABELS)) {
    const brand = cleanText(raw.brand);
    const name = cleanText(raw.name);
    const code = cleanText(raw.code);
    const label = [brand, name, code].filter(Boolean).join(' ');
    if (label === '') continue;
    // Commas would be read as separators between entries; a label is one entry.
    let resolved = resolver.resolveLine(label.replace(/[,;]/g, ' '));
    // A misread code must not block a good name match, so retry without it.
    if (resolved.kind !== 'item' && code !== '' && name !== '') {
      resolved = resolver.resolveLine([brand, name].filter(Boolean).join(' ').replace(/[,;]/g, ' '));
    }
    const entry = toEntry(label, resolved);
    const key = entry.match ? `item:${entry.match.id}` : `text:${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/** Decoded size of a base64 string, without decoding it. */
function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

async function overLimit(store: KeyValueStore, key: string, limit: number, ttlSeconds: number): Promise<boolean> {
  const current = Number.parseInt((await store.get(key)) ?? '0', 10) || 0;
  if (current >= limit) return true;
  // KV has no atomic increment, so two simultaneous requests can both count
  // as the same number. The limits are a cost brake, not an exact quota.
  await store.put(key, String(current + 1), { expirationTtl: ttlSeconds });
  return false;
}

/**
 * Build the API as a Hono app. Mount it under the Worker, or call
 * `app.request(...)` directly in tests.
 */
export function createIngestApp(dependencies: IngestDependencies) {
  const resolver = createRecipeResolver(dependencies.catalog);
  const limits = dependencies.limits ?? DEFAULT_LIMITS;
  const now = dependencies.now ?? Date.now;
  const app = new Hono();

  const fail = (status: 400 | 403 | 413 | 415 | 422 | 429 | 502 | 503, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } } satisfies IngestError), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      catalogSize: dependencies.catalog.length,
      photoImport: dependencies.extract !== undefined && dependencies.rateLimitStore !== undefined,
    }),
  );

  app.post('/api/ingest', async (c) => {
    // Browsers attach Origin to cross-site POSTs. Refusing a foreign origin
    // stops other websites spending this endpoint's budget through a
    // visitor's browser. (It does not stop scripts; the rate limit does.)
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== new URL(c.req.url).origin) {
      return fail(403, 'forbidden_origin', 'This endpoint only accepts requests from its own site.');
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return fail(415, 'unsupported_media_type', 'Send a JSON body.');
    }
    // Reject oversized bodies before reading them where the size is declared.
    const declared = Number(c.req.header('content-length') ?? '0');
    const maxBody = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;
    if (declared > maxBody) return fail(413, 'too_large', 'That upload is too large.');

    let body: unknown;
    try {
      const text = await c.req.text();
      if (text.length > maxBody) return fail(413, 'too_large', 'That upload is too large.');
      body = JSON.parse(text);
    } catch {
      return fail(400, 'invalid_json', 'The request body is not valid JSON.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return fail(400, 'invalid_request', 'Send an object with either "text" or "image".');
    }
    const { text, image } = body as { text?: unknown; image?: unknown };
    if ((text === undefined) === (image === undefined)) {
      return fail(400, 'invalid_request', 'Send exactly one of "text" or "image".');
    }

    // -- text: no model involved ---------------------------------------------
    if (text !== undefined) {
      if (typeof text !== 'string') return fail(400, 'invalid_request', '"text" must be a string.');
      if (text.length > MAX_TEXT_LENGTH) return fail(413, 'too_large', 'That list is too long. Send it in parts.');
      const entries = resolver.resolve(text).map((resolved) => toEntry(cleanText(resolved.raw), resolved));
      return c.json({ source: 'text', entries } satisfies IngestResponse, 200, { 'cache-control': 'no-store' });
    }

    // -- image ------------------------------------------------------------------
    if (typeof image !== 'object' || image === null) {
      return fail(400, 'invalid_request', '"image" must be an object with "mediaType" and "data".');
    }
    const { mediaType, data } = image as { mediaType?: unknown; data?: unknown };
    if (typeof mediaType !== 'string' || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
      return fail(415, 'unsupported_image', 'Send a JPEG, PNG, WebP or GIF image.');
    }
    if (typeof data !== 'string' || data === '' || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      return fail(400, 'invalid_request', '"image.data" must be base64 without a data-URL prefix.');
    }
    if (base64ByteLength(data) > MAX_IMAGE_BYTES) return fail(413, 'too_large', 'That photo is too large.');

    const { extract, rateLimitStore } = dependencies;
    if (extract === undefined || rateLimitStore === undefined) {
      return fail(503, 'photo_import_unavailable', 'Photo import is not set up on this server.');
    }

    const time = now();
    const day = new Date(time).toISOString().slice(0, 10);
    const hour = Math.floor(time / 3_600_000);
    const client = c.req.header('cf-connecting-ip') ?? 'unknown';
    if (await overLimit(rateLimitStore, `ingest:client:${client}:${hour}`, limits.perClientPerHour, 7200)) {
      return fail(429, 'rate_limited', 'Too many photos from this connection. Try again in an hour.');
    }
    if (await overLimit(rateLimitStore, `ingest:day:${day}`, limits.perDay, 172_800)) {
      return fail(429, 'daily_limit', 'Photo import has reached its limit for today. Paste a list instead.');
    }

    let result: VisionResult;
    try {
      result = await extract({ mediaType: mediaType as ImageMediaType, data });
    } catch {
      return fail(502, 'vision_failed', 'The label reader is unavailable right now. Try again, or paste a list.');
    }
    if (result.kind === 'refused') {
      return fail(422, 'vision_refused', 'The label reader declined that image. Try a different photo.');
    }
    if (result.kind === 'unreadable') {
      return fail(502, 'vision_unreadable', 'The label reader returned something unusable. Try again.');
    }
    return c.json({ source: 'image', entries: matchLabels(result.labels, resolver) } satisfies IngestResponse, 200, {
      'cache-control': 'no-store',
    });
  });

  return app;
}
