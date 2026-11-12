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
import { wrapLines } from './cardLayout';
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

const TITLE_FONT = `700 24px ${FONT}`;
const DETAIL_FONT = `400 17px ${FONT}`;
const NOTE_FONT = `500 18px ${FONT}`;
const TITLE_LINE = 30;
const DETAIL_LINE = 21;
const NOTE_MAX_WIDTH = 330;

/** Wrap with the context's current font. */
function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines?: number): string[] {
  return wrapLines(text, maxWidth, (value) => context.measureText(value).width, maxLines === undefined ? {} : { maxLines });
}

interface RowLayout {
  titleLines: string[];
  detailLines: string[];
  note: string;
  height: number;
}

/**
 * Work out each row's text and height before drawing. The title carries the
 * item or the mix recipe, which is the one thing on the card that must be
 * complete, so it wraps onto as many lines as it needs and the row grows.
 */
function layoutRows(context: CanvasRenderingContext2D, entries: readonly CardEntry[], textX: number): RowLayout[] {
  return entries.map((entry) => {
    context.font = NOTE_FONT;
    const note = wrap(context, entry.note, NOTE_MAX_WIDTH, 1)[0] ?? '';
    const textWidth = CARD_WIDTH - PADDING - textX - Math.min(NOTE_MAX_WIDTH, context.measureText(note).width) - 28;
    context.font = TITLE_FONT;
    const titleLines = wrap(context, entry.title, textWidth);
    context.font = DETAIL_FONT;
    const detailLines = wrap(context, entry.detail, textWidth, 3);
    const textHeight = 20 + titleLines.length * TITLE_LINE + detailLines.length * DETAIL_LINE + 12;
    return { titleLines, detailLines, note, height: Math.max(ROW_HEIGHT, textHeight) };
  });
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
  const swatchX = PADDING + 52;
  const textX = swatchX + SWATCH_WIDTH + 16 + 28;

  // Rows are measured first, because their heights decide the canvas height.
  const measuring = document.createElement('canvas').getContext('2d');
  if (measuring === null) throw new Error('2D canvas is not available');
  const rows = layoutRows(measuring, entries, textX);
  const rowsHeight = entries.length === 0 ? ROW_HEIGHT : rows.reduce((sum, row) => sum + row.height, 0);
  const height = rowsY + rowsHeight + footerHeight + PADDING;

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
  context.fillText(wrap(context, input.title, contentWidth, 1)[0] ?? '', PADDING, PADDING + 44);
  context.fillStyle = MUTED;
  context.font = `400 20px ${FONT}`;
  context.fillText(wrap(context, input.subtitle, contentWidth, 1)[0] ?? '', PADDING, PADDING + 80);

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
  let top = rowsY;
  entries.forEach((entry, index) => {
    const row = rows[index] as RowLayout;
    context.strokeStyle = '#d5d2cb';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(PADDING, top + 0.5);
    context.lineTo(CARD_WIDTH - PADDING, top + 0.5);
    context.stroke();

    context.fillStyle = INK;
    context.font = `800 26px ${FONT}`;
    context.fillText(String(entry.number), PADDING, top + 62);

    // Swatch: target on the left, match on the right, sharing one edge. It
    // stays at the top of the row however tall the text makes the row.
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

    context.fillStyle = INK;
    context.font = TITLE_FONT;
    row.titleLines.forEach((line, lineIndex) => {
      context.fillText(line, textX, top + 44 + lineIndex * TITLE_LINE);
    });
    const detailY = top + 44 + (row.titleLines.length - 1) * TITLE_LINE + 26;
    context.fillStyle = MUTED;
    context.font = DETAIL_FONT;
    row.detailLines.forEach((line, lineIndex) => {
      context.fillText(line, textX, detailY + lineIndex * DETAIL_LINE);
    });

    context.fillStyle = INK;
    context.font = NOTE_FONT;
    context.textAlign = 'right';
    context.fillText(row.note, CARD_WIDTH - PADDING, top + 44);
    context.fillStyle = MUTED;
    context.font = `400 15px ${FONT}`;
    context.fillText(`target ${entry.target.hex}`, CARD_WIDTH - PADDING, top + 70);
    context.textAlign = 'left';

    top += row.height;
  });

  // Footer
  const footerY = rowsY + rowsHeight + 34;
  context.fillStyle = MUTED;
  context.font = `400 15px ${FONT}`;
  wrap(context, input.footnote, contentWidth, 3).forEach((line, lineIndex) => {
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
