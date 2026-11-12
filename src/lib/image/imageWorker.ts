/**
 * Web Worker entry point for image work. Load it as a module worker:
 *
 *   new Worker(new URL('./imageWorker.ts', import.meta.url), { type: 'module' })
 *
 * and talk to it through `createImageWorkerClient` (imageWorkerClient.ts).
 * All the logic lives in imageWorkerProtocol.ts; this file only wires it to
 * the worker's message port.
 */

import { handleImageWorkerRequest, type ImageWorkerRequest, type ImageWorkerResponse } from './imageWorkerProtocol';

interface WorkerScope {
  onmessage: ((event: { data: ImageWorkerRequest }) => void) | null;
  postMessage(message: ImageWorkerResponse, transfer: ArrayBuffer[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { response, transfer } = handleImageWorkerRequest(event.data);
  scope.postMessage(response, transfer);
};
