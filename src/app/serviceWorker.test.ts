/**
 * Runs the service worker's event handlers in a Node VM against fake
 * caches and a fake network. This checks the caching decisions; it is not a
 * browser upgrade test (scripts/e2e.mjs covers install and offline start).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

type Handler = (event: FakeEvent) => void;

interface FakeEvent {
  request?: { url: string; method: string; mode: string };
  respondWith?(response: Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

function createCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (request: string | { url: string }) => {
    const url = typeof request === 'string' ? request : request.url;
    return new URL(url, 'https://app.test').pathname;
  };
  const open = (name: string) => {
    let store = stores.get(name);
    if (store === undefined) {
      store = new Map();
      stores.set(name, store);
    }
    const entries = store;
    return Promise.resolve({
      put: (request: string | { url: string }, response: Response) => {
        entries.set(keyOf(request), response);
        return Promise.resolve();
      },
      addAll: (urls: string[]) => {
        for (const url of urls) entries.set(keyOf(url), new Response(`precached ${url}`, { headers: { 'content-type': 'text/html' } }));
        return Promise.resolve();
      },
    });
  };
  return {
    stores,
    api: {
      open,
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name: string) => Promise.resolve(stores.delete(name)),
      match: (request: string | { url: string }) => {
        for (const store of stores.values()) {
          const hit = store.get(keyOf(request));
          if (hit) return Promise.resolve(hit.clone());
        }
        return Promise.resolve(undefined);
      },
    },
  };
}

function loadWorker(network: (url: string) => Promise<Response>) {
  const template = readFileSync(resolve(__dirname, 'serviceWorker.js'), 'utf8');
  const source = template
    .replace('self.__PRECACHE_MANIFEST__', JSON.stringify(['/', '/assets/app.js']))
    .replace('self.__PRECACHE_VERSION__', JSON.stringify('v2'));
  const handlers = new Map<string, Handler>();
  const caches = createCaches();
  const self = {
    location: { origin: 'https://app.test' },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
  };
  runInNewContext(source, {
    self,
    caches: caches.api,
    fetch: (request: { url: string }) => network(request.url),
    URL,
    Response,
    Promise,
  });

  const pending: Promise<unknown>[] = [];
  const dispatch = async (type: string, request?: FakeEvent['request']) => {
    let responded: Promise<Response> | undefined;
    const event: FakeEvent = {
      ...(request ? { request } : {}),
      respondWith: (response) => {
        responded = response;
      },
      waitUntil: (promise) => pending.push(promise),
    };
    handlers.get(type)?.(event);
    const response = responded ? await responded : undefined;
    await Promise.all(pending);
    return response;
  };
  const get = (path: string, mode = 'no-cors') => dispatch('fetch', { url: `https://app.test${path}`, method: 'GET', mode });
  return { dispatch, get, caches };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

describe('service worker', () => {
  it('never replaces the offline shell with a server error', async () => {
    let next = () => Promise.resolve(html('good shell'));
    const worker = loadWorker(() => next());
    await worker.dispatch('install');
    expect(await (await worker.get('/', 'navigate'))?.text()).toBe('good shell');

    next = () => Promise.resolve(html('server broken', 500));
    // While online, a broken server is answered with the last good shell.
    expect(await (await worker.get('/', 'navigate'))?.text()).toBe('good shell');
    // And offline, the shell is still the good one.
    next = () => Promise.reject(new TypeError('offline'));
    expect(await (await worker.get('/', 'navigate'))?.text()).toBe('good shell');
  });

  it('does not cache a non-HTML answer to a navigation', async () => {
    let next = () => Promise.resolve(html('good shell'));
    const worker = loadWorker(() => next());
    await worker.get('/', 'navigate');
    next = () => Promise.resolve(new Response('{"oops":true}', { headers: { 'content-type': 'application/json' } }));
    await worker.get('/', 'navigate');
    next = () => Promise.reject(new TypeError('offline'));
    expect(await (await worker.get('/', 'navigate'))?.text()).toBe('good shell');
  });

  it('leaves the API alone', async () => {
    const worker = loadWorker(() =>
      Promise.resolve(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })),
    );
    expect(await worker.get('/api/health')).toBeUndefined(); // not intercepted at all
    const cached = [...worker.caches.stores.values()].flatMap((store) => [...store.keys()]);
    expect(cached).not.toContain('/api/health');
  });

  it('does not cache responses marked no-store', async () => {
    const worker = loadWorker(() => Promise.resolve(new Response('x', { headers: { 'cache-control': 'no-store' } })));
    await worker.get('/some/file.txt');
    const cached = [...worker.caches.stores.values()].flatMap((store) => [...store.keys()]);
    expect(cached).not.toContain('/some/file.txt');
  });

  it('deletes only this app’s old caches on activation, and does not take over open pages early', async () => {
    const worker = loadWorker(() => Promise.resolve(html('shell')));
    await worker.caches.api.open('color-me-worst-v1');
    await worker.caches.api.open('other-app-cache');
    await worker.dispatch('install');
    // Installing must not delete anything: open tabs still use the old version.
    expect([...worker.caches.stores.keys()].sort()).toEqual(['color-me-worst-v1', 'color-me-worst-v2', 'other-app-cache']);
    await worker.dispatch('activate');
    expect([...worker.caches.stores.keys()].sort()).toEqual(['color-me-worst-v2', 'other-app-cache']);
    const template = readFileSync(resolve(__dirname, 'serviceWorker.js'), 'utf8');
    expect(template).not.toMatch(/skipWaiting\(\)/);
  });
});
