/**
 * Turns a solver result into what the interface shows: one verdict, the best
 * option the user owns, and whether something worth buying exists. Keeping
 * this out of the components means the wording rules are unit-tested and the
 * workspace and recipe views cannot disagree about what a result means.
 */

import { classifyDeltaE, type MatchQuality } from '../color/deltaE2000';
import type { MatchMode, SolvedMatch } from '../color/matchSolver';
import type { ColorCoordinates, SingleMatch, TwoPartMix } from '../color/types';

/**
 * - `exact`: an owned item is an imperceptible match.
 * - `close`: an owned item is a close substitute.
 * - `mix`: two owned items mixed get within reach.
 * - `approximate`: the best owned item is noticeably off but usable.
 * - `gap`: nothing owned gets close; this belongs on a shopping list.
 * - `empty`: the user owns nothing eligible to compare.
 */
export type MatchVerdict = 'exact' | 'close' | 'mix' | 'approximate' | 'gap' | 'empty';

export type OwnedOption = { kind: 'single'; match: SingleMatch } | { kind: 'mix'; mix: TwoPartMix };

export interface MatchSummary {
  verdict: MatchVerdict;
  /** The best thing the user can do with what they own, if anything. */
  owned?: OwnedOption;
  /** ΔE00 of `owned`, or null when there is none. */
  ownedDeltaE: number | null;
  /** Colour to draw beside the target for `owned`. */
  ownedColor?: ColorCoordinates;
  /** Perceptual band of `ownedDeltaE`. */
  quality?: MatchQuality;
  /**
   * An item the user does not own that is clearly better than anything they
   * do. Only offered in full-catalogue mode.
   */
  toBuy?: SingleMatch;
}

/** A purchase is only suggested when it beats the owned option by this much ΔE00. */
export const BUY_MIN_IMPROVEMENT = 1;

export const VERDICT_LABELS: Readonly<Record<MatchVerdict, string>> = {
  exact: 'Exact match',
  close: 'Close substitute',
  mix: 'Mix from your stash',
  approximate: 'Nearest you own',
  gap: 'Not in your stash',
  empty: 'Nothing to compare',
};

export function summarizeMatch(solved: SolvedMatch, mode: MatchMode): MatchSummary {
  const single = solved.bestOwnedSingle;
  const mix = solved.bestTwoPartMix;
  const useMix = mix !== undefined && (single === undefined || mix.deltaE00 < single.deltaE00);

  let owned: OwnedOption | undefined;
  if (useMix) owned = { kind: 'mix', mix };
  else if (single !== undefined) owned = { kind: 'single', match: single };

  const ownedDeltaE = owned === undefined ? null : owned.kind === 'mix' ? owned.mix.deltaE00 : owned.match.deltaE00;

  let verdict: MatchVerdict;
  if (owned === undefined) verdict = 'empty';
  else if (solved.coverage === 'gap') verdict = 'gap';
  else if (solved.coverage === 'owned_mix') verdict = 'mix';
  else if (solved.coverage === 'owned_approximate') verdict = 'approximate';
  else verdict = classifyDeltaE(ownedDeltaE as number) === 'exact' ? 'exact' : 'close';

  const summary: MatchSummary = { verdict, ownedDeltaE };
  if (owned !== undefined) {
    summary.owned = owned;
    summary.ownedColor = owned.kind === 'mix' ? owned.mix.predictedColor : owned.match.item.color;
    summary.quality = classifyDeltaE(ownedDeltaE as number);
  }

  if (mode === 'full_catalog') {
    const candidate = solved.bestSingleMatches.find((match) => !match.ownedByUser);
    if (candidate !== undefined && (ownedDeltaE === null || candidate.deltaE00 <= ownedDeltaE - BUY_MIN_IMPROVEMENT)) {
      summary.toBuy = candidate;
    }
  }
  return summary;
}

export interface DescribeMixOptions {
  /**
   * Put each ingredient's brand before its name. Different brands sell
   * paints with the same name ("Ivory", "Black"), so anything a person will
   * follow as a recipe should set this.
   */
  brands?: boolean;
}

/** "2 parts A : 1 part B", optionally "2 parts Brand A : 1 part Brand B". */
export function describeMix(mix: TwoPartMix, options: DescribeMixOptions = {}): string {
  const part = (count: number) => (count === 1 ? '1 part' : `${count} parts`);
  const name = (item: TwoPartMix['itemA']) => (options.brands ? `${item.brand} ${item.name}` : item.name);
  return `${part(mix.ratio[0])} ${name(mix.itemA)} : ${part(mix.ratio[1])} ${name(mix.itemB)}`;
}

/** ΔE00 to one decimal, for display. */
export function formatDeltaE(deltaE: number): string {
  return deltaE < 0.05 ? '0.0' : deltaE.toFixed(1);
}
