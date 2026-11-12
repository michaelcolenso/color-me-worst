/**
 * Message protocol between the page and the image Web Worker, plus the
 * function that executes a request. The executor is separate from the worker
 * entry point so it can be unit-tested, and so the client can fall back to
 * running it on the main thread where workers are unavailable.
 */

import { extractPalette, type PaletteOptions, type PaletteResult } from './paletteExtractor';
import type { Matrix3, PixelBuffer } from './pixelMath';
import {
  applyWhiteBalance,
  autoWhiteBalance,
  type AutoWhiteBalanceOptions,
  type WhiteBalance,
} from './whiteBalance';

export type ImageWorkerRequest =
  | { id: number; type: 'extractPalette'; image: PixelBuffer; options?: PaletteOptions }
  | { id: number; type: 'autoWhiteBalance'; image: PixelBuffer; options?: AutoWhiteBalanceOptions }
  | { id: number; type: 'applyWhiteBalance'; image: PixelBuffer; matrix: Matrix3 };

export interface ImageWorkerResults {
  extractPalette: PaletteResult;
  autoWhiteBalance: WhiteBalance;
  applyWhiteBalance: PixelBuffer;
}

export type ImageWorkerResponse =
  | { id: number; ok: true; result: ImageWorkerResults[keyof ImageWorkerResults] }
  | { id: number; ok: false; error: { name: string; message: string } };

export interface HandledRequest {
  response: ImageWorkerResponse;
  /** Buffers to hand over rather than copy when posting the response. */
  transfer: ArrayBuffer[];
}

/** Execute one request. Never throws: failures come back as `ok: false`. */
export function handleImageWorkerRequest(request: ImageWorkerRequest): HandledRequest {
  try {
    switch (request.type) {
      case 'extractPalette':
        return {
          response: { id: request.id, ok: true, result: extractPalette(request.image, request.options) },
          transfer: [],
        };
      case 'autoWhiteBalance':
        return {
          response: { id: request.id, ok: true, result: autoWhiteBalance(request.image, request.options) },
          transfer: [],
        };
      case 'applyWhiteBalance': {
        const result = applyWhiteBalance(request.image, request.matrix);
        return {
          response: { id: request.id, ok: true, result },
          transfer: result.data.buffer instanceof ArrayBuffer ? [result.data.buffer] : [],
        };
      }
      default: {
        const unknown = request as { id?: number; type?: unknown };
        return {
          response: {
            id: unknown.id ?? -1,
            ok: false,
            error: { name: 'TypeError', message: `Unknown request type "${String(unknown.type)}"` },
          },
          transfer: [],
        };
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return {
      response: { id: request.id, ok: false, error: { name: failure.name, message: failure.message } },
      transfer: [],
    };
  }
}
