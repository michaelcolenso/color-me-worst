/**
 * Turns pin results into the plain rows printed on a recipe card. Kept apart
 * from the canvas drawing so the wording is unit-tested.
 */

import type { ColorCoordinates } from '../color/types';
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
        title: describeMix(owned.mix),
        detail: `${gap}Predicted mix; test on a spare surface first.${buy ? ` ${buy}` : ''}`,
        note: `${VERDICT_LABELS[verdict]} · dE ${formatDeltaE(owned.mix.deltaE00)}`,
      };
    }
    const item = owned.match.item;
    const code = /\d/.test(item.sku) ? `, ${item.sku}` : '';
    return {
      ...base,
      matchColor: item.color,
      title: `${item.brand} ${item.name}`,
      detail: `${gap}${item.line}${code}${buy ? `. ${buy}` : ''}`,
      note: `${VERDICT_LABELS[verdict]} · dE ${formatDeltaE(owned.match.deltaE00)}`,
    };
  });
}
