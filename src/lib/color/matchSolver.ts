/**
 * "Shop your stash" solver: ranks single-item substitutes for a target colour
 * and, when nothing owned is close enough, searches the owned items for a
 * two-part mix. Zero dependencies.
 *
 * Decision thresholds (ΔE00)
 * The specification states three numbers that overlap: the mix calculator is
 * "triggered" in the 3.0–5.0 band, it also runs "when no single item achieves
 * ΔE00 < 2.5", and a colour is a shopping-list gap above 4.0. They are
 * reconciled here as:
 *   - a mix is searched for when the best owned single match is >= 2.5
 *     ({@link MIX_TRIGGER_DELTA_E}); the stricter of the two triggers wins;
 *   - a mix is only reported when it beats that single match by a visible
 *     margin ({@link MIX_MIN_IMPROVEMENT}), since mixing costs effort;
 *   - the target is a gap when the best owned option, single or mixed, is
 *     still above 4.0 ({@link GAP_DELTA_E}).
 * All three are overridable per call.
 */

import { colorFromHex } from './colorConversions';
import { deltaE2000Components, type DeltaE2000Weights } from './deltaE2000';
import {
  canSubstituteFinish,
  findBestTwoPartMixes,
  finishClassOf,
  preparePigments,
  type PigmentOverrides,
  type PreparedPigments,
} from './pigmentMixer';
import type {
  CatalogItem,
  ColorCoordinates,
  FinishType,
  MatchResult,
  MediumType,
  SingleMatch,
  TwoPartMix,
} from './types';

/** Search for a mix when the best owned single match is at or above this ΔE00. */
export const MIX_TRIGGER_DELTA_E = 2.5;

/** A mix must beat the best owned single match by at least this much ΔE00 to be reported. */
export const MIX_MIN_IMPROVEMENT = 0.5;

/** Above this ΔE00 the best owned option is not a usable approximation. */
export const GAP_DELTA_E = 4.0;

/**
 * - `full_catalog`: rank every catalogue item, flagging the ones the user owns.
 * - `strict_stash`: rank only items the user owns.
 * Mixes are always built from owned items in both modes.
 */
export type MatchMode = 'full_catalog' | 'strict_stash';

/** Why an item's on-screen swatch cannot be trusted to look like the real thing. */
export type DisplayCaveat = 'metallic' | 'fluorescent' | 'variegated';

/**
 * Finishes whose appearance an sRGB swatch cannot reproduce. The UI should
 * badge these (specification section 6, "Metamerism & Screen Gamut Warnings").
 */
export function displayCaveatOf(item: CatalogItem): DisplayCaveat | null {
  const finishClass = finishClassOf(item.finish);
  return finishClass === 'metallic' || finishClass === 'fluorescent' || finishClass === 'variegated'
    ? finishClass
    : null;
}

export interface SolveOptions {
  /** Default `full_catalog`. */
  mode?: MatchMode;
  /**
   * Finish of the colour being matched. Candidates must be in the same finish
   * class unless `experimentalFinishes` is set. Default `matte`, i.e. an
   * ordinary opaque colour such as one sampled from a photo.
   */
  targetFinish?: FinishType;
  /** Restrict candidates to one medium, e.g. only embroidery floss. Default: any. */
  medium?: MediumType;
  /** Allow substitutes and mixes across finish classes. Default false. */
  experimentalFinishes?: boolean;
  /**
   * Offer discontinued items the user does not own. Owned discontinued items
   * are always eligible. Default false.
   */
  includeDiscontinued?: boolean;
  /** Number of single matches to return. Default 5. */
  maxSingleMatches?: number;
  /** Set false to skip the mix search entirely. Default true. */
  allowMixes?: boolean;
  /** Integer part ratios for mixes, each tried in both directions. */
  mixRatios?: readonly (readonly [number, number])[];
  /** Default {@link MIX_TRIGGER_DELTA_E}. */
  mixTriggerDeltaE?: number;
  /** Default {@link MIX_MIN_IMPROVEMENT}. */
  mixMinImprovement?: number;
  /** Default {@link GAP_DELTA_E}. */
  gapDeltaE?: number;
  /** CIEDE2000 parametric factors. */
  weights?: DeltaE2000Weights;
}

/** How well the user's own inventory covers a target. */
export type StashCoverage =
  /** An owned item is within the "exact" or "close" band on its own. */
  | 'owned_single'
  /** No owned single is good enough, but a mix of two owned items is within the gap limit. */
  | 'owned_mix'
  /** An owned single is the best available and within the gap limit, though noticeably off. */
  | 'owned_approximate'
  /** Nothing owned gets within the gap limit: this belongs on the shopping list. */
  | 'gap';

/** {@link MatchResult} plus the verdicts the UI needs. */
export interface SolvedMatch extends MatchResult {
  /** The closest owned single item, even if it did not make `bestSingleMatches`. */
  bestOwnedSingle?: SingleMatch;
  /** Lowest ΔE00 reachable with owned items, single or mixed. `null` when nothing owned is eligible. */
  bestOwnedDeltaE: number | null;
  coverage: StashCoverage;
}

export interface MatchSolver {
  /** Number of catalogue items the solver was built with. */
  readonly catalogSize: number;
  /** Number of those the user owns. */
  readonly ownedCount: number;
  /**
   * Solve one target.
   * @param target A `ColorCoordinates` record or a hex string.
   * @throws {RangeError} when given an invalid hex string.
   */
  solve(target: ColorCoordinates | string, options?: SolveOptions): SolvedMatch;
}

export interface MatchSolverInput {
  /** Every item that may be suggested. */
  catalog: readonly CatalogItem[];
  /** `CatalogItem.id` values the user owns. Ids missing from `catalog` are ignored. */
  ownedIds: ReadonlySet<string> | readonly string[];
  /** Optional measured spectra and tint strengths, keyed by item id. */
  overrides?: PigmentOverrides;
}

/**
 * Build a solver for one catalogue and stash. Construction converts the owned
 * items to spectra once; each `solve` call then reuses that work, so create
 * the solver when the stash changes rather than per target.
 */
export function createMatchSolver(input: MatchSolverInput): MatchSolver {
  const { catalog } = input;
  const ownedIds = input.ownedIds instanceof Set ? (input.ownedIds as ReadonlySet<string>) : new Set(input.ownedIds as readonly string[]);
  const count = catalog.length;

  // Flat copies of the fields the hot loop reads.
  const lab = new Float64Array(count * 3);
  const owned = new Uint8Array(count);
  const ownedItems: CatalogItem[] = [];
  for (let index = 0; index < count; index++) {
    const item = catalog[index] as CatalogItem;
    lab[index * 3] = item.color.lab[0];
    lab[index * 3 + 1] = item.color.lab[1];
    lab[index * 3 + 2] = item.color.lab[2];
    if (ownedIds.has(item.id)) {
      owned[index] = 1;
      ownedItems.push(item);
    }
  }
  const preparedOwned: PreparedPigments = preparePigments(ownedItems, input.overrides);

  function solve(target: ColorCoordinates | string, options: SolveOptions = {}): SolvedMatch {
    const targetColor = typeof target === 'string' ? colorFromHex(target) : target;
    const mode = options.mode ?? 'full_catalog';
    const targetFinish = options.targetFinish ?? 'matte';
    const experimentalFinishes = options.experimentalFinishes === true;
    const includeDiscontinued = options.includeDiscontinued === true;
    const maxSingles = Math.max(1, Math.floor(options.maxSingleMatches ?? 5));
    const finishRule = { experimentalFinishes };
    const kL = options.weights?.kL ?? 1;
    const kC = options.weights?.kC ?? 1;
    const kH = options.weights?.kH ?? 1;
    const [targetL, targetA, targetB] = targetColor.lab;

    const top: SingleMatch[] = [];
    let cutoff = Number.POSITIVE_INFINITY;
    let bestOwnedSingle: SingleMatch | undefined;

    for (let index = 0; index < count; index++) {
      const isOwned = owned[index] === 1;
      if (!isOwned && mode === 'strict_stash') continue;
      const item = catalog[index] as CatalogItem;
      if (options.medium !== undefined && item.medium !== options.medium) continue;
      if (item.discontinued && !isOwned && !includeDiscontinued) continue;
      if (!canSubstituteFinish(targetFinish, item.finish, finishRule)) continue;

      const deltaE00 = deltaE2000Components(
        targetL,
        targetA,
        targetB,
        lab[index * 3] as number,
        lab[index * 3 + 1] as number,
        lab[index * 3 + 2] as number,
        kL,
        kC,
        kH,
      );
      if (isOwned && (bestOwnedSingle === undefined || deltaE00 < bestOwnedSingle.deltaE00)) {
        bestOwnedSingle = { item, deltaE00, ownedByUser: true };
      }
      if (deltaE00 >= cutoff) continue;
      let position = top.length;
      while (position > 0 && (top[position - 1] as SingleMatch).deltaE00 > deltaE00) position--;
      top.splice(position, 0, { item, deltaE00, ownedByUser: isOwned });
      if (top.length > maxSingles) top.pop();
      if (top.length === maxSingles) cutoff = (top[maxSingles - 1] as SingleMatch).deltaE00;
    }

    // Mix search: only when nothing owned is close enough on its own, and only
    // for targets that paint can reproduce by blending (opaque or transparent
    // colour, not flake, glow or multi-colour effects).
    const mixTrigger = options.mixTriggerDeltaE ?? MIX_TRIGGER_DELTA_E;
    const minImprovement = options.mixMinImprovement ?? MIX_MIN_IMPROVEMENT;
    const ownedSingleDeltaE = bestOwnedSingle?.deltaE00 ?? Number.POSITIVE_INFINITY;
    let bestTwoPartMix: TwoPartMix | undefined;
    if (options.allowMixes !== false && ownedSingleDeltaE >= mixTrigger && preparedOwned.items.length >= 2) {
      const targetClass = finishClassOf(targetFinish);
      const mixes = findBestTwoPartMixes(targetColor.lab, preparedOwned, {
        experimentalFinishes,
        limit: 1,
        maxDeltaE: ownedSingleDeltaE - minImprovement,
        eligible: (item) =>
          (options.medium === undefined || item.medium === options.medium) &&
          (experimentalFinishes || finishClassOf(item.finish) === targetClass),
        ...(options.mixRatios !== undefined ? { ratios: options.mixRatios } : {}),
        ...(options.weights !== undefined ? { weights: options.weights } : {}),
      });
      bestTwoPartMix = mixes[0];
    }

    const gapLimit = options.gapDeltaE ?? GAP_DELTA_E;
    const bestOwned = Math.min(ownedSingleDeltaE, bestTwoPartMix?.deltaE00 ?? Number.POSITIVE_INFINITY);
    let coverage: StashCoverage;
    if (ownedSingleDeltaE < mixTrigger) coverage = 'owned_single';
    else if (bestTwoPartMix !== undefined && bestTwoPartMix.deltaE00 <= gapLimit) coverage = 'owned_mix';
    else if (ownedSingleDeltaE <= gapLimit) coverage = 'owned_approximate';
    else coverage = 'gap';

    return {
      targetColor,
      bestSingleMatches: top,
      ...(bestTwoPartMix !== undefined ? { bestTwoPartMix } : {}),
      ...(bestOwnedSingle !== undefined ? { bestOwnedSingle } : {}),
      bestOwnedDeltaE: Number.isFinite(bestOwned) ? bestOwned : null,
      coverage,
    };
  }

  return { catalogSize: count, ownedCount: ownedItems.length, solve };
}

/**
 * One-shot convenience wrapper around {@link createMatchSolver}.
 * Prefer the solver object when matching more than one target.
 */
export function solveMatch(
  target: ColorCoordinates | string,
  input: MatchSolverInput,
  options: SolveOptions = {},
): SolvedMatch {
  return createMatchSolver(input).solve(target, options);
}
