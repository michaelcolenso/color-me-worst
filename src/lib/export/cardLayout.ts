/**
 * Text wrapping for the recipe card, kept free of the canvas so it can be
 * unit-tested: the caller supplies a function that measures a string.
 */

export type MeasureText = (text: string) => number;

export interface WrapOptions {
  /**
   * Stop after this many lines and end the last one with an ellipsis. Omit
   * for text that must never be cut, such as a mix recipe: it then takes as
   * many lines as it needs.
   */
  maxLines?: number;
}

/** Break one over-long word into pieces that each fit the width. */
function breakWord(word: string, maxWidth: number, measure: MeasureText): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const character of word) {
    if (piece !== '' && measure(piece + character) > maxWidth) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/**
 * Wrap text to a width. Words are kept whole where possible; a single word
 * wider than the line is split so that nothing overflows and nothing is lost.
 */
export function wrapLines(text: string, maxWidth: number, measure: MeasureText, options: WrapOptions = {}): string[] {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (measure(word) > maxWidth ? breakWord(word, maxWidth, measure) : [word]));
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line === '' || measure(candidate) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);

  const { maxLines } = options;
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  let last = kept[kept.length - 1] as string;
  while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[kept.length - 1] = `${last}…`;
  return kept;
}
