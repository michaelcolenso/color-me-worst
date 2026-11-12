/**
 * Browser-only glue between files, canvases and the pixel pipeline. This is
 * the one module in src/lib/image that touches the DOM.
 */

import type { PixelBuffer } from './pixelMath';

export interface DecodeOptions {
  /**
   * Longest side of the decoded image in pixels. Larger photos are scaled
   * down. Default 2048: enough detail to place pins accurately, small enough
   * to process quickly on a phone.
   */
  maxDimension?: number;
}

/**
 * Decode an image file (JPEG, PNG, WebP, …) into sRGB pixels.
 *
 * Two details matter for colour accuracy:
 *   - EXIF orientation is applied, so phone photos are not sideways;
 *   - the canvas is explicitly sRGB, so a wide-gamut (Display P3) phone photo
 *     is converted rather than having its numbers reinterpreted.
 *
 * @throws when the browser cannot decode the file.
 */
export async function decodeImage(source: Blob, options: DecodeOptions = {}): Promise<ImageData> {
  const maxDimension = Math.max(1, Math.floor(options.maxDimension ?? 2048));
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (context === null) throw new Error('2D canvas is not available');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height, { colorSpace: 'srgb' });
  } finally {
    bitmap.close();
  }
}

/** Wrap a pixel buffer as `ImageData` for drawing with `putImageData`. */
export function toImageData(image: PixelBuffer): ImageData {
  const data = new Uint8ClampedArray(image.data.length);
  data.set(image.data);
  return new ImageData(data, image.width, image.height);
}

/**
 * Convert a pointer position on a displayed canvas or image element into
 * image pixel coordinates, accounting for CSS scaling.
 */
export function clientToImagePoint(
  element: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } },
  imageSize: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * imageSize.width;
  const y = ((clientY - rect.top) / rect.height) * imageSize.height;
  return {
    x: Math.min(imageSize.width - 1, Math.max(0, Math.floor(x))),
    y: Math.min(imageSize.height - 1, Math.max(0, Math.floor(y))),
  };
}
