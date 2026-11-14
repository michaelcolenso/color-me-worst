/**
 * Turns pin results into the plain rows printed on a recipe card. Kept apart
 * from the canvas drawing so the wording is unit-tested.
 */

import type { CatalogItem, ColorCoordinates } from '../color/types';
import { VERDICT_LABELS, describeMix, formatDeltaE, type MatchSummary } from '../match/matchSummary';

export interface CardEntry {
  /** Pin number as shown on the photo. */
  number: number;
  /** Pin position in image pixels. */
  x: number;
  y: number;
  target: ColorCoordinates;
  /** Colour of the suggested item or mix, when there is one. */
  matchColor?: ColorCoordinates;
  /** Main line: the item, or the mix recipe. */
  title: string;
  /** Second line: range, code and caveats. */
  detail: string;
  /** Right-hand note: verdict and colour difference. */
  note: string;
}

export interface CardPin {
  number: number;
  x: number;
  y: number;
  target: ColorCoordinates;
  summary: MatchSummary;
}

/** Range and, where it is a real code, product code: enough to pick the right pot off a shelf. */
function rangeAndCode(item: CatalogItem): string {
  return /\d/.test(item.sku) ? `${item.line}, ${item.sku}` : item.line;
}

export function buildCardEntries(pins: readonly CardPin[]): CardEntry[] {
  return pins.map(({ number, x, y, target, summary }) => {
    const { owned, verdict, toBuy } = summary;
    const base = { number, x, y, target };
    const buy = toBuy ? `Closer if bought: ${toBuy.item.brand} ${toBuy.item.name} (dE ${formatDeltaE(toBuy.deltaE00)})` : '';
    const gap = verdict === 'gap' ? 'Nearest owned, not a good match. ' : '';

    if (owned === undefined) {
      return {
        ...base,
        title: toBuy ? `${toBuy.item.brand} ${toBuy.item.name}` : `Target ${target.hex}`,
        detail: toBuy ? `Not owned. ${toBuy.item.line}, dE ${formatDeltaE(toBuy.deltaE00)}` : 'Nothing in the stash to compare.',
        note: VERDICT_LABELS[verdict],
        ...(toBuy ? { matchColor: toBuy.item.color } : {}),
      };
    }
    if (owned.kind === 'mix') {
      return {
        ...base,
        matchColor: owned.mix.predictedColor,
        // A saved recipe has to say exactly which products to use: brand in
        // the title, range and code for each ingredient underneath.
        title: describeMix(owned.mix, { brands: true }),
        detail:
          `${gap}${owned.mix.itemA.name}: ${rangeAndCode(owned.mix.itemA)}. ` +
          `${owned.mix.itemB.name}: ${rangeAndCode(owned.mix.itemB)}. ` +
          `Predicted mix; test on a spare surface first.${buy ? ` ${buy}` : ''}`,
        note: `${VERDICT_LABELS[verdict]} · dE ${formatDeltaE(owned.mix.deltaE00)}`,
      };
    }
    const item = owned.match.item;
    return {
      ...base,
      matchColor: item.color,
      title: `${item.brand} ${item.name}`,
      detail: `${gap}${rangeAndCode(item)}${buy ? `. ${buy}` : ''}`,
      note: `${VERDICT_LABELS[verdict]} · dE ${formatDeltaE(owned.match.deltaE00)}`,
    };
  });
}
