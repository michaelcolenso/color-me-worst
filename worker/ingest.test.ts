import { describe, expect, it } from 'vitest';

import { createRecipeResolver } from '../src/lib/catalog/recipeParser';
import type { CatalogBundle } from '../src/lib/catalog/seedBuilder';
import seedBundle from '../src/data/catalogSeed.json';
import {
  MAX_IMAGE_BYTES,
  MAX_LABELS,
  MAX_TEXT_LENGTH,
  createIngestApp,
  createMemoryRateLimiter,
  matchLabels,
  type IngestDependencies,
  type IngestError,
  type IngestResponse,
  type RateLimiter,
  type VisionExtractor,
} from './ingest';

const catalog = (seedBundle as unknown as CatalogBundle).items;
const resolver = createRecipeResolver(catalog);

/** A tiny valid base64 payload standing in for an image. */
const IMAGE = { mediaType: 'image/jpeg', data: 'AAAA' };

/** A limiter that records what it was asked, on top of the real in-memory one. */
function recordingLimiter(now: () => number = Date.now): RateLimiter & { keys: string[] } {
  const inner = createMemoryRateLimiter(now);
  const keys: string[] = [];
  return {
    keys,
    consume(key, limit, windowSeconds) {
      keys.push(`${key}|${limit}|${windowSeconds}`);
      return inner.consume(key, limit, windowSeconds);
    },
  };
}

/** Like Partial, but a key may be set to undefined explicitly to switch a dependency off. */
type Overrides = { [K in keyof IngestDependencies]?: IngestDependencies[K] | undefined };

function setup(overrides: Overrides = {}) {
  const calls: Array<{ mediaType: string; data: string }> = [];
  const extract: VisionExtractor = (image) => {
    calls.push(image);
    return Promise.resolve({
      kind: 'labels',
      labels: [
        { brand: 'Citadel', name: 'Mephiston Red', code: null },
        { brand: 'Vallejo', name: 'Black', code: '70.950' },
      ],
    });
  };
  const limiter = recordingLimiter();
  const app = createIngestApp({ catalog, extract, rateLimiter: limiter, ...overrides } as IngestDependencies);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('http://app.test/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, post, calls, limiter };
}

const errorCode = async (response: Response) => ((await response.json()) as IngestError).error.code;

describe('label matching', () => {
  const ids = (labels: Parameters<typeof matchLabels>[0]) =>
    matchLabels(labels, resolver).map((entry) => entry.match?.id ?? `unmatched:${entry.label}`);

  it('matches what was read to catalogue items by name, brand and code', () => {
    expect(
      ids([
        { brand: 'Citadel', name: 'Mephiston Red', code: null },
        { brand: null, name: null, code: '70.950' },
        { brand: 'DMC', name: null, code: '310' },
        { brand: 'Monument', name: 'Bold Titanium White', code: '001' },
      ]),
    ).toEqual([
      'citadel:base:mephiston-red',
      'vallejo:model-color:70-950',
      'dmc:six-strand-cotton-floss:310',
      'monument-hobbies:pro-acryl:001',
    ]);
  });

  it('reports unmatched labels instead of guessing, and skips empty ones', () => {
    expect(
      ids([
        { brand: 'Acme', name: 'Unicorn Tears', code: null },
        { brand: null, name: null, code: null },
        { brand: '  ', name: '', code: null },
      ]),
    ).toEqual(['unmatched:Acme Unicorn Tears']);
  });

  it('falls back to the name when the code was misread', () => {
    expect(ids([{ brand: 'Vallejo', name: 'Flat Red', code: '7O.9S7' }])).toEqual(['vallejo:model-color:70-957']);
  });

  it('merges repeats of the same product and flags ambiguous names', () => {
    const entries = matchLabels(
      [
        { brand: 'Citadel', name: 'Nuln Oil', code: null },
        { brand: null, name: 'Nuln Oil', code: null },
        { brand: null, name: 'Ivory', code: null },
      ],
      resolver,
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]?.alternatives).toHaveLength(1);
    expect(new Set([entries[1]?.match?.brand, entries[1]?.alternatives[0]?.brand])).toEqual(
      new Set(['Vallejo', 'Monument Hobbies']),
    );
  });

  it('treats model output as untrusted text', () => {
    const entries = matchLabels(
      [
        // Separators and control characters must not split one label into several entries.
        { brand: 'Citadel', name: 'Mephiston Red, Nuln Oil; Abaddon Black\u0000\n', code: null },
        { brand: 42 as unknown as string, name: { evil: true } as unknown as string, code: null },
        { brand: null, name: 'x'.repeat(5000), code: null },
      ],
      resolver,
    );
    // One label in, one entry out. It names three products, so it is offered
    // as a choice between them rather than silently becoming three additions.
    expect(entries).toHaveLength(2);
    expect(entries[0]?.label).toBe('Citadel Mephiston Red, Nuln Oil; Abaddon Black');
    expect(entries[0]?.alternatives).toHaveLength(2);
    expect(entries[1]?.label).toHaveLength(120);
    expect(entries[1]?.match).toBeNull();
  });

  it('caps the number of labels processed', () => {
    const many = Array.from({ length: MAX_LABELS + 50 }, (_, index) => ({ brand: null, name: `Thing ${index}`, code: null }));
    expect(matchLabels(many, resolver)).toHaveLength(MAX_LABELS);
  });
});

describe('POST /api/ingest with text', () => {
  it('resolves a pasted list without calling the model', async () => {
    const { post, calls, limiter } = setup();
    const response = await post({ text: 'Mephiston Red\nVallejo 70.950 Black, Unicorn Tears\nIvory' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as IngestResponse;
    expect(body.source).toBe('text');
    expect(body.entries.map((entry) => entry.match?.id ?? null)).toEqual([
      'citadel:base:mephiston-red',
      'vallejo:model-color:70-950',
      null,
      expect.stringMatching(/ivory|023|70-918/) as unknown as string,
    ]);
    expect(body.entries[2]?.label).toBe('Unicorn Tears');
    expect(body.entries[3]?.alternatives).toHaveLength(1);
    expect(body.entries[0]?.match).toEqual({
      id: 'citadel:base:mephiston-red',
      brand: 'Citadel',
      line: 'Base',
      name: 'Mephiston Red',
      sku: 'mephiston-red',
    });
    expect(calls).toHaveLength(0);
    expect(limiter.keys).toEqual([]); // text is free, so it is not rate limited
  });

  it('works when photo import is not configured', async () => {
    const { post } = setup({ extract: undefined, rateLimiter: undefined });
    expect((await post({ text: 'Nuln Oil' })).status).toBe(200);
  });

  it('rejects over-long lists', async () => {
    const { post } = setup();
    const response = await post({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('too_large');
  });
});

describe('POST /api/ingest with an image', () => {
  it('sends the image to the label reader and matches what comes back', async () => {
    const { post, calls } = setup();
    const response = await post({ image: IMAGE }, { 'cf-connecting-ip': '203.0.113.7' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as IngestResponse;
    expect(body.source).toBe('image');
    expect(body.entries.map((entry) => entry.match?.id)).toEqual(['citadel:base:mephiston-red', 'vallejo:model-color:70-950']);
    expect(calls).toEqual([IMAGE]);
  });

  it('is unavailable without a label reader or without a rate limiter', async () => {
    for (const overrides of [{ extract: undefined }, { rateLimiter: undefined }]) {
      const { post } = setup(overrides);
      const response = await post({ image: IMAGE });
      expect(response.status).toBe(503);
      expect(await errorCode(response)).toBe('photo_import_unavailable');
    }
  });

  it('limits photos per client per hour', async () => {
    const { post, calls, limiter } = setup({ limits: { perClientPerHour: 2, perDay: 100 } });
    const from = (ip: string) => post({ image: IMAGE }, { 'cf-connecting-ip': ip });
    expect((await from('203.0.113.7')).status).toBe(200);
    expect((await from('203.0.113.7')).status).toBe(200);
    const blocked = await from('203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('rate_limited');
    expect((await from('198.51.100.9')).status).toBe(200); // a different client is unaffected
    expect(calls).toHaveLength(3); // the blocked request never reached the model
    expect(limiter.keys[0]).toBe('client:203.0.113.7|2|3600');
    expect(limiter.keys[1]).toBe('everyone|100|86400');
  });

  it('caps total photos per day across all clients', async () => {
    const { post, calls } = setup({ limits: { perClientPerHour: 100, perDay: 2 } });
    const from = (ip: string) => post({ image: IMAGE }, { 'cf-connecting-ip': ip });
    expect((await from('203.0.113.1')).status).toBe(200);
    expect((await from('203.0.113.2')).status).toBe(200);
    const blocked = await from('203.0.113.3');
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('daily_limit');
    expect(calls).toHaveLength(2);
  });

  it('starts a fresh allowance once the hour has passed', async () => {
    let time = Date.UTC(2026, 0, 15, 10, 30);
    const { post } = setup({ limits: { perClientPerHour: 1, perDay: 100 }, rateLimiter: createMemoryRateLimiter(() => time) });
    expect((await post({ image: IMAGE })).status).toBe(200);
    expect((await post({ image: IMAGE })).status).toBe(429);
    time += 59 * 60 * 1000;
    expect((await post({ image: IMAGE })).status).toBe(429);
    time += 2 * 60 * 1000;
    expect((await post({ image: IMAGE })).status).toBe(200);
  });

  it('counts simultaneous requests exactly', async () => {
    const { post, calls } = setup({ limits: { perClientPerHour: 5, perDay: 100 } });
    const responses = await Promise.all(Array.from({ length: 12 }, () => post({ image: IMAGE }, { 'cf-connecting-ip': '203.0.113.7' })));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
    expect(calls).toHaveLength(5);
  });

  it('does not spend when the limiter itself fails', async () => {
    const broken: RateLimiter = { consume: () => Promise.reject(new Error('KV PUT failed: 429 Too Many Requests')) };
    const { post, calls } = setup({ rateLimiter: broken });
    const response = await post({ image: IMAGE });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('limiter_unavailable');
    expect(calls).toHaveLength(0);
  });

  it('maps label-reader outcomes to clear errors', async () => {
    const cases: Array<[VisionExtractor, number, string]> = [
      [() => Promise.resolve({ kind: 'refused' }), 422, 'vision_refused'],
      [() => Promise.resolve({ kind: 'unreadable' }), 502, 'vision_unreadable'],
      [() => Promise.reject(new Error('upstream 529: sk-ant-secret')), 502, 'vision_failed'],
    ];
    for (const [extract, status, code] of cases) {
      const response = await setup({ extract }).post({ image: IMAGE });
      expect(response.status).toBe(status);
      const text = await response.clone().text();
      expect(await errorCode(response)).toBe(code);
      expect(text).not.toContain('sk-ant'); // upstream error text is never echoed
    }
  });

  it('returns an empty list when nothing was legible', async () => {
    const response = await setup({ extract: () => Promise.resolve({ kind: 'labels', labels: [] }) }).post({ image: IMAGE });
    expect(((await response.json()) as IngestResponse).entries).toEqual([]);
  });

  it('validates the image before spending anything', async () => {
    const { post, calls, limiter } = setup();
    const bad: Array<[unknown, number, string]> = [
      [{ image: { mediaType: 'image/svg+xml', data: 'AAAA' } }, 415, 'unsupported_image'],
      [{ image: { mediaType: 'image/png', data: 'data:image/png;base64,AAAA' } }, 400, 'invalid_request'],
      [{ image: { mediaType: 'image/png', data: 'AAA' } }, 400, 'invalid_request'],
      [{ image: { mediaType: 'image/png', data: '' } }, 400, 'invalid_request'],
      [{ image: 'AAAA' }, 400, 'invalid_request'],
      [{ image: { mediaType: 'image/png', data: 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 3) * 4) / 3 / 4) * 4) } }, 413, 'too_large'],
    ];
    for (const [body, status, code] of bad) {
      const response = await post(body);
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
    expect(calls).toHaveLength(0);
    expect(limiter.keys).toEqual([]);
  });
});

describe('request validation', () => {
  it('rejects malformed requests', async () => {
    const { post, app } = setup();
    const cases: Array<[Promise<Response> | Response, number, string]> = [
      [post('{not json'), 400, 'invalid_json'],
      [post([1, 2]), 400, 'invalid_request'],
      [post({}), 400, 'invalid_request'],
      [post({ text: 'a', image: IMAGE }), 400, 'invalid_request'],
      [post({ text: 5 }), 400, 'invalid_request'],
      [
        app.request('http://app.test/api/ingest', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }),
        415,
        'unsupported_media_type',
      ],
      [post({ text: 'a' }, { 'content-length': String(50 * 1024 * 1024) }), 413, 'too_large'],
    ];
    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
  });

  it('refuses requests from another website but allows its own origin and non-browser clients', async () => {
    const { post } = setup();
    const foreign = await post({ text: 'Nuln Oil' }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe('forbidden_origin');
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect((await post({ text: 'Nuln Oil' }, { origin: 'http://app.test' })).status).toBe(200);
    expect((await post({ text: 'Nuln Oil' })).status).toBe(200);
  });

  it('reports health and whether photo import is configured', async () => {
    const ready = await setup().app.request('http://app.test/api/health');
    expect(await ready.json()).toEqual({ ok: true, catalogSize: catalog.length, photoImport: true });
    const textOnly = await setup({ extract: undefined }).app.request('http://app.test/api/health');
    expect(((await textOnly.json()) as { photoImport: boolean }).photoImport).toBe(false);
    expect((await setup().app.request('http://app.test/api/nope')).status).toBe(404);
    expect((await setup().app.request('http://app.test/api/ingest')).status).toBe(404); // GET is not offered
  });
});
