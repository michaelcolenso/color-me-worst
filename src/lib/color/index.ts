/**
 * Public surface of the colour kernel. Zero runtime dependencies; safe to
 * import from the browser, a Web Worker, an edge runtime or Node.
 */

export * from './types';
export * from './colorConversions';
export * from './deltaE2000';
export * from './pigmentMixer';
export * from './matchSolver';
export { BAND_COUNT, WAVELENGTHS_NM } from './spectralData';
