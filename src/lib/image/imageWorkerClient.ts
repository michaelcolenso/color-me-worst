/**
 * Promise-based client for the image worker. It keeps pixel crunching off the
 * main thread so the page stays responsive while a palette is extracted or a
 * photo is re-balanced.
 */

import {
  handleImageWorkerRequest,
  type ImageWorkerRequest,
  type ImageWorkerResponse,
  type ImageWorkerResults,
} from './imageWorkerProtocol';
import type { PaletteOptions, PaletteResult } from './paletteExtractor';
import type { Matrix3, PixelBuffer } from './pixelMath';
import type { AutoWhiteBalanceOptions, WhiteBalance } from './whiteBalance';

/** The part of the DOM `Worker` interface the client needs. */
export interface WorkerLike {
  postMessage(message: ImageWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: { data: ImageWorkerResponse }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

export interface ImageWorkerClient {
  /** Dominant colours of an image. The image is copied to the worker; the caller keeps its buffer. */
  extractPalette(image: PixelBuffer, options?: PaletteOptions): Promise<PaletteResult>;
  /** Estimate a white-balance correction from image statistics. */
  autoWhiteBalance(image: PixelBuffer, options?: AutoWhiteBalanceOptions): Promise<WhiteBalance>;
  /** A corrected copy of an image. */
  applyWhiteBalance(image: PixelBuffer, matrix: Matrix3): Promise<PixelBuffer>;
  /** Stop the worker. Requests still in flight are rejected. */
  terminate(): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<ImageWorkerRequest, 'id'>;

interface Pending {
  resolve(value: ImageWorkerResults[keyof ImageWorkerResults]): void;
  reject(reason: Error): void;
}

function toError(error: { name: string; message: string }): Error {
  const result = error.name === 'RangeError' ? new RangeError(error.message) : new Error(error.message);
  result.name = error.name;
  return result;
}

/** Wrap a worker running imageWorker.ts. */
export function createImageWorkerClient(worker: WorkerLike): ImageWorkerClient {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminated = false;
  /** Set once the worker itself has failed; it will never answer again. */
  let fatal: Error | undefined;

  const failAll = (reason: Error) => {
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  };

  worker.addEventListener('message', (event) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (entry === undefined) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(toError(response.error));
  });
  // A worker-level error (script failed to load, uncaught exception) cannot
  // be tied to one request, so every waiting caller is told. The worker is
  // then treated as dead: later calls reject at once instead of waiting for
  // an answer that will never come.
  worker.addEventListener('error', (event) => {
    fatal = new Error(`Image worker failed: ${event.message ?? 'unknown error'}`);
    failAll(fatal);
    if (!terminated) {
      terminated = true;
      worker.terminate();
    }
  });

  const call = <K extends keyof ImageWorkerResults>(body: RequestBody & { type: K }): Promise<ImageWorkerResults[K]> =>
    new Promise((resolve, reject) => {
      if (fatal !== undefined) {
        reject(fatal);
        return;
      }
      if (terminated) {
        reject(new Error('Image worker has been terminated'));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      try {
        worker.postMessage({ ...body, id } as ImageWorkerRequest);
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  return {
    extractPalette: (image, options) =>
      call({ type: 'extractPalette', image, ...(options !== undefined ? { options } : {}) }),
    autoWhiteBalance: (image, options) =>
      call({ type: 'autoWhiteBalance', image, ...(options !== undefined ? { options } : {}) }),
    applyWhiteBalance: (image, matrix) => call({ type: 'applyWhiteBalance', image, matrix }),
    terminate() {
      if (terminated) return;
      terminated = true;
      worker.terminate();
      failAll(new Error('Image worker has been terminated'));
    },
  };
}

/**
 * The same interface without a worker: requests run on the calling thread,
 * one per macrotask. For environments where workers are unavailable, and for tests.
 */
export function createInlineImageClient(): ImageWorkerClient {
  let terminated = false;
  const run = <K extends keyof ImageWorkerResults>(body: RequestBody & { type: K }): Promise<ImageWorkerResults[K]> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        if (terminated) {
          reject(new Error('Image worker has been terminated'));
          return;
        }
        const { response } = handleImageWorkerRequest({ ...body, id: 0 } as ImageWorkerRequest);
        if (response.ok) resolve(response.result as ImageWorkerResults[K]);
        else reject(toError(response.error));
      }, 0);
    });
  return {
    extractPalette: (image, options) =>
      run({ type: 'extractPalette', image, ...(options !== undefined ? { options } : {}) }),
    autoWhiteBalance: (image, options) =>
      run({ type: 'autoWhiteBalance', image, ...(options !== undefined ? { options } : {}) }),
    applyWhiteBalance: (image, matrix) => run({ type: 'applyWhiteBalance', image, matrix }),
    terminate() {
      terminated = true;
    },
  };
}
