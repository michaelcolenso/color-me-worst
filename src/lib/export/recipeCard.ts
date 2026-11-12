/**
 * Draws the shareable recipe card: the reference photo with numbered pins,
 * then one row per pin with target and match side by side. Browser only.
 *
 * The card is drawn at twice its layout size so it stays sharp when printed
 * or zoomed. PNG keeps the swatches exact; the PDF wraps a high-quality JPEG
 * of the same drawing (see pdf.ts).
 */

import type { PixelBuffer } from '../image/pixelMath';
import type { CardEntry } from './cardEntries';
import { buildImagePdf } from './pdf';

export interface RecipeCardInput {
  /** The photo as it should appear (after any lighting correction). */
  image: PixelBuffer;
  entries: readonly CardEntry[];
  title: string;
  /** Small line under the title, e.g. the date and match mode. */
  subtitle: string;
  footnote: string;
}

/** Layout width in CSS pixels; the canvas is this times {@link CARD_SCALE}. */
export const CARD_WIDTH = 1200;
export const CARD_SCALE = 2;

const PADDING = 56;
const ROW_HEIGHT = 104;
const SWATCH_WIDTH = 190;
const SWATCH_HEIGHT = 68;
const MAX_PHOTO_HEIGHT = 760;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const INK = '#1c1d21';
const MUTED = '#5d6068';
const SURROUND = '#7b7b7b';

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (context.measureText(candidate).width <= maxWidth || line === '') line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1] as string;
    while (last.length > 1 && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

/** Draw the card and return its canvas. */
export function renderRecipeCard(input: RecipeCardInput): HTMLCanvasElement {
  const { image, entries } = input;
  const contentWidth = CARD_WIDTH - PADDING * 2;
  const photoScale = Math.min(contentWidth / image.width, MAX_PHOTO_HEIGHT / image.height);
  const photoWidth = Math.round(image.width * photoScale);
  const photoHeight = Math.round(image.height * photoScale);
  const photoX = PADDING + Math.round((contentWidth - photoWidth) / 2);
  const headerHeight = 112;
  const photoY = PADDING + headerHeight;
  const rowsY = photoY + photoHeight + 36;
  const footerHeight = 84;
  const height = rowsY + Math.max(1, entries.length) * ROW_HEIGHT + footerHeight + PADDING;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH * CARD_SCALE;
  canvas.height = height * CARD_SCALE;
  const context = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (context === null) throw new Error('2D canvas is not available');
  context.scale(CARD_SCALE, CARD_SCALE);
  context.textBaseline = 'alphabetic';

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, CARD_WIDTH, height);

  // Header
  context.fillStyle = INK;
  context.font = `700 40px ${FONT}`;
  context.fillText(wrapText(context, input.title, contentWidth, 1)[0] ?? '', PADDING, PADDING + 44);
  context.fillStyle = MUTED;
  context.font = `400 20px ${FONT}`;
  context.fillText(wrapText(context, input.subtitle, contentWidth, 1)[0] ?? '', PADDING, PADDING + 80);

  // Photo, drawn through a scratch canvas so it can be scaled smoothly.
  const scratch = document.createElement('canvas');
  scratch.width = image.width;
  scratch.height = image.height;
  const pixels = new Uint8ClampedArray(image.data.length);
  pixels.set(image.data);
  scratch.getContext('2d')?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  context.fillStyle = SURROUND;
  context.fillRect(PADDING, photoY, contentWidth, photoHeight);
  context.imageSmoothingQuality = 'high';
  context.drawImage(scratch, photoX, photoY, photoWidth, photoHeight);

  // Pins
  for (const entry of entries) {
    const cx = photoX + ((entry.x + 0.5) / image.width) * photoWidth;
    const cy = photoY + ((entry.y + 0.5) / image.height) * photoHeight;
    context.beginPath();
    context.arc(cx, cy, 19, 0, Math.PI * 2);
    context.fillStyle = '#000000';
    context.fill();
    context.beginPath();
    context.arc(cx, cy, 16.5, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    context.beginPath();
    context.arc(cx, cy, 13, 0, Math.PI * 2);
    context.fillStyle = entry.target.hex;
    context.fill();
    context.font = `800 15px ${FONT}`;
    context.textAlign = 'center';
    context.lineWidth = 3.5;
    context.strokeStyle = '#000000';
    context.strokeText(String(entry.number), cx, cy + 5.5);
    context.fillStyle = '#ffffff';
    context.fillText(String(entry.number), cx, cy + 5.5);
    context.textAlign = 'left';
  }

  // Rows
  if (entries.length === 0) {
    context.fillStyle = MUTED;
    context.font = `400 22px ${FONT}`;
    context.fillText('No pins placed.', PADDING, rowsY + 56);
  }
  entries.forEach((entry, index) => {
    const top = rowsY + index * ROW_HEIGHT;
    context.strokeStyle = '#d5d2cb';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(PADDING, top + 0.5);
    context.lineTo(CARD_WIDTH - PADDING, top + 0.5);
    context.stroke();

    context.fillStyle = INK;
    context.font = `800 26px ${FONT}`;
    context.fillText(String(entry.number), PADDING, top + 62);

    // Swatch: target on the left, match on the right, sharing one edge.
    const swatchX = PADDING + 52;
    const swatchY = top + (ROW_HEIGHT - SWATCH_HEIGHT - 16) / 2;
    context.fillStyle = SURROUND;
    context.fillRect(swatchX, swatchY, SWATCH_WIDTH + 16, SWATCH_HEIGHT + 16);
    const half = SWATCH_WIDTH / 2;
    context.fillStyle = entry.target.hex;
    context.fillRect(swatchX + 8, swatchY + 8, entry.matchColor ? half : SWATCH_WIDTH, SWATCH_HEIGHT);
    if (entry.matchColor) {
      context.fillStyle = entry.matchColor.hex;
      context.fillRect(swatchX + 8 + half, swatchY + 8, half, SWATCH_HEIGHT);
    }

    const textX = swatchX + SWATCH_WIDTH + 16 + 28;
    context.font = `500 18px ${FONT}`;
    const noteWidth = Math.min(330, context.measureText(entry.note).width);
    const textWidth = CARD_WIDTH - PADDING - textX - noteWidth - 28;

    context.fillStyle = INK;
    context.font = `700 24px ${FONT}`;
    context.fillText(wrapText(context, entry.title, textWidth, 1)[0] ?? '', textX, top + 44);
    context.fillStyle = MUTED;
    context.font = `400 17px ${FONT}`;
    wrapText(context, entry.detail, textWidth, 2).forEach((line, lineIndex) => {
      context.fillText(line, textX, top + 70 + lineIndex * 21);
    });

    context.fillStyle = INK;
    context.font = `500 18px ${FONT}`;
    context.textAlign = 'right';
    context.fillText(wrapText(context, entry.note, 330, 1)[0] ?? '', CARD_WIDTH - PADDING, top + 44);
    context.fillStyle = MUTED;
    context.font = `400 15px ${FONT}`;
    context.fillText(`target ${entry.target.hex}`, CARD_WIDTH - PADDING, top + 70);
    context.textAlign = 'left';
  });

  // Footer
  const footerY = rowsY + Math.max(1, entries.length) * ROW_HEIGHT + 34;
  context.fillStyle = MUTED;
  context.font = `400 15px ${FONT}`;
  wrapText(context, input.footnote, contentWidth, 3).forEach((line, lineIndex) => {
    context.fillText(line, PADDING, footerY + lineIndex * 21);
  });

  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the card'))), type, quality);
  });
}

/** The card as a PNG file. */
export function recipeCardPng(input: RecipeCardInput): Promise<Blob> {
  return toBlob(renderRecipeCard(input), 'image/png');
}

/** The card as a one-page PDF. */
export async function recipeCardPdf(input: RecipeCardInput): Promise<Blob> {
  const canvas = renderRecipeCard(input);
  const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.95)).arrayBuffer());
  const pdf = buildImagePdf(jpeg, canvas.width, canvas.height, { title: input.title });
  const copy = new Uint8Array(pdf.length);
  copy.set(pdf);
  return new Blob([copy.buffer], { type: 'application/pdf' });
}

/** Hand a file to the browser's download flow. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
