/**
 * Recipe translator, step one: turn a pasted supply list into catalogue items.
 *
 * Tutorials name paints loosely: "Mephiston Red", "citadel - mephiston red
 * (base)", "VMC 70.950 Black", "2x Nuln Oil". This resolver is deterministic
 * string matching, not a language model: every word of a paint's name must
 * appear in the line (allowing one typo in longer words), or the line must
 * carry the paint's product code. A line can also give a colour directly as a
 * hex code. Nothing is guessed; a line that matches nothing is reported as
 * unknown, and a line that matches several paints equally well is flagged so
 * the user can choose.
 *
 * Identity evidence is checked for consistency, not just scored:
 *   - a brand named in the line restricts the candidates to that brand, so
 *     "Monument 70.950" can never resolve to Vallejo's 70.950;
 *   - when the best candidate leaves part of the line unexplained, and that
 *     part is itself identity evidence (a product code, or a colour word from
 *     some other product's name), the line is returned with an `issue` rather
 *     than as a confident match: "Vallejo 70.950 White" names one paint by
 *     code and another by name. Callers must ask the user before acting on a
 *     line that has an issue or alternatives.
 */

import { colorFromHex } from '../color/colorConversions';
import type { CatalogItem, ColorCoordinates } from '../color/types';

export type ResolvedRecipeLine =
  | {
      kind: 'item';
      /** The text as the user wrote it. */
      raw: string;
      item: CatalogItem;
      /**
       * Other candidates, best guess excluded: items that matched equally
       * well, or, when there is an `issue`, the other items the line could
       * refer to.
       */
      alternatives: CatalogItem[];
      /**
       * Discontinued versions of the same product (same brand and name, an
       * older range). Not a reason for doubt; offered in case the user owns
       * the old pot.
       */
      olderVersions?: CatalogItem[];
      /**
       * Present when the line contains evidence that contradicts `item`, e.g.
       * a second product code or another paint's colour name. `item` is then
       * only a suggestion and must be confirmed by the user.
       */
      issue?: string;
    }
  | { kind: 'color'; raw: string; label: string; color: ColorCoordinates }
  | {
      kind: 'unknown';
      raw: string;
      /** Why nothing matched, when there is something more useful to say than "not found". */
      reason?: string;
    };

/**
 * Every product a resolved item line could mean, best guess first: the
 * equally good alternatives, then older versions of the same paint.
 */
export function candidatesOf(line: Extract<ResolvedRecipeLine, { kind: 'item' }>): CatalogItem[] {
  return [line.item, ...line.alternatives, ...(line.olderVersions ?? [])];
}

/** True when a resolved line can be acted on without asking the user. */
export function isConfident(line: ResolvedRecipeLine): boolean {
  return line.kind === 'color' || (line.kind === 'item' && line.alternatives.length === 0 && line.issue === undefined);
}

/** Extra words that identify a brand or range in the wild. Keys are catalogue brand names. */
const BRAND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Citadel: ['gw', 'games workshop', 'citadel colour', 'citadel color'],
  Vallejo: ['vmc', 'vgc', 'av', 'acrylicos vallejo'],
  'Monument Hobbies': ['pro acryl', 'proacryl', 'monument', 'mph'],
  DMC: ['dmc floss', 'dmc thread'],
};

function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(^|\s)\.+|\.+(\s|$)/g, ' ')
    .trim();
}

function tokenise(text: string): string[] {
  const normalised = normalise(text);
  return normalised === '' ? [] : normalised.split(/\s+/);
}

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

interface IndexedItem {
  item: CatalogItem;
  nameTokens: string[];
  /** Phrases, any of which signals this item's brand or line. */
  contextPhrases: string[];
  /** Every word that can legitimately appear in a line describing this item alone. */
  ownWords: Set<string>;
  sku: string;
  /** A code distinctive enough to match on its own: has a letter or separator, or is long. */
  skuIsDistinctive: boolean;
}

export interface RecipeResolver {
  /** Resolve one line. */
  resolveLine(line: string): ResolvedRecipeLine;
  /** Split pasted text into entries and resolve each. Blank lines are skipped. */
  resolve(text: string): ResolvedRecipeLine[];
}

const HEX_IN_TEXT = /#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/i;

/** Remove list markers and quantities that are not part of a paint's name. */
function stripDecorations(line: string): string {
  return line
    .replace(/^\s*(?:[-*•–—]+\s*|\d+[.)]\s+)/, '')
    .replace(/\b\d+\s*x\b|\bx\s*\d+\b/gi, ' ')
    .replace(/\(\s*\d+\s*(?:pots?|bottles?|skeins?|ml)?\s*\)/gi, ' ')
    .replace(/\b\d+\s*ml\b/gi, ' ');
}

/**
 * Words that commonly sit next to a paint name in a tutorial without saying
 * anything about which product it is.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set(
  (
    'a an and as at by for from in into of on or the then to with ' +
    'paint paints colour color pot pots bottle dropper thinned thin layer base shade wash ' +
    'highlight highlights edge glaze basecoat coat coats mix mixed parts part'
  ).split(' '),
);

/** Up to this many other candidates are offered when a line has an issue. */
const ISSUE_ALTERNATIVES = 4;

/**
 * Build a resolver for a catalogue. Indexing is done once; resolving a line
 * is then a linear scan, which is instant for catalogues of this size.
 */
export function createRecipeResolver(catalog: readonly CatalogItem[]): RecipeResolver {
  const indexed: IndexedItem[] = catalog.map((item) => {
    const sku = normalise(item.sku);
    const nameTokens = tokenise(item.name);
    const contextPhrases = [item.brand, item.line, ...(BRAND_ALIASES[item.brand] ?? [])].map(normalise).filter(Boolean);
    return {
      item,
      nameTokens,
      contextPhrases,
      ownWords: new Set([...nameTokens, ...contextPhrases.flatMap((phrase) => phrase.split(' ')), sku]),
      sku,
      skuIsDistinctive: /[a-z.]/.test(sku) || sku.replace(/\D/g, '').length >= 5,
    };
  });

  // Phrases that name a brand (not a range: "Base" or "Layer" say nothing about who made it).
  const brandPhrases = new Map<string, string[]>();
  for (const item of catalog) {
    if (brandPhrases.has(item.brand)) continue;
    brandPhrases.set(item.brand, [item.brand, ...(BRAND_ALIASES[item.brand] ?? [])].map(normalise).filter(Boolean));
  }
  /** Products by each word of their name, to find a second product named in the same line. */
  const byNameWord = new Map<string, IndexedItem[]>();
  for (const entry of indexed) {
    for (const word of new Set(entry.nameTokens)) {
      const list = byNameWord.get(word);
      if (list === undefined) byNameWord.set(word, [entry]);
      else list.push(entry);
    }
  }

  function explains(entry: IndexedItem, token: string): boolean {
    if (entry.ownWords.has(token) || FILLER_WORDS.has(token)) return true;
    if (token.length < 4) return false;
    for (const word of entry.ownWords) if (word.length >= 5 && withinOneEdit(token, word)) return true;
    return false;
  }

  /**
   * Words in the line that identify some product other than `entry`: a code
   * it does not carry, or words completing another product's whole name
   * ("Mephiston Red and Nuln Oil", "Vallejo 70.950 White"). A stray word that
   * merely occurs in some other name ("for the cloak", with "Necromancer
   * Cloak" in the catalogue) is not evidence of another product.
   */
  function conflictingWords(entry: IndexedItem, tokens: readonly string[], brandWords: ReadonlySet<string>): string[] {
    const unexplained = tokens.filter((token) => !brandWords.has(token) && !explains(entry, token));
    const conflicts = new Set(unexplained.filter((token) => /\d/.test(token)));
    const words = unexplained.filter((token) => !/\d/.test(token));
    if (words.length === 0) return tokens.filter((token) => conflicts.has(token));
    // The same tolerance as candidate scoring: exact, or one edit in a word of 5+ letters.
    const matches = (token: string, nameWord: string) =>
      token === nameWord || (nameWord.length >= 5 && token.length >= 4 && withinOneEdit(token, nameWord));
    const present = (nameWord: string) => tokens.some((token) => matches(token, nameWord));
    const seen = new Set<IndexedItem>();
    for (const word of words) {
      // Exact hits come from the index; near misses need a scan, which only
      // runs for lines that already have an unexplained word.
      const exact = byNameWord.get(word) ?? [];
      const others = exact.length > 0 ? exact : indexed.filter((other) => other.nameTokens.some((t) => matches(word, t)));
      for (const other of others) {
        if (seen.has(other)) continue;
        seen.add(other);
        if (other === entry || other.item.name === entry.item.name) continue;
        if (!other.nameTokens.every(present)) continue;
        for (const token of words) if (other.nameTokens.some((nameWord) => matches(token, nameWord))) conflicts.add(token);
      }
    }
    return tokens.filter((token) => conflicts.has(token));
  }


  function resolveLine(line: string): ResolvedRecipeLine {
    return resolveEntry(line).resolved;
  }

  function resolveEntry(line: string): { resolved: ResolvedRecipeLine; winner?: IndexedItem } {
    const raw = line.trim();
    const hex = HEX_IN_TEXT.exec(raw);
    if (hex) {
      const label = raw.replace(hex[0], '').replace(/^[\s:,\-–—]+|[\s:,\-–—]+$/g, '').trim();
      return {
        resolved: { kind: 'color', raw, label: label === '' ? hex[0].toLowerCase() : label, color: colorFromHex(hex[0]) },
      };
    }

    const text = normalise(stripDecorations(raw));
    if (text === '') return { resolved: { kind: 'unknown', raw } };
    const tokens = text.split(/\s+/);
    const tokenSet = new Set(tokens);
    const padded = ` ${text} `;

    const mentionedBrands = new Set<string>();
    const brandWords = new Set<string>();
    for (const [brand, phrases] of brandPhrases) {
      for (const phrase of phrases) {
        if (!padded.includes(` ${phrase} `)) continue;
        mentionedBrands.add(brand);
        for (const word of phrase.split(' ')) brandWords.add(word);
      }
    }

    let bestScore = 0;
    let best: IndexedItem[] = [];
    const scored: { entry: IndexedItem; score: number }[] = [];
    for (const entry of indexed) {
      // A named brand is a constraint, not a hint.
      if (mentionedBrands.size > 0 && !mentionedBrands.has(entry.item.brand)) continue;
      const hasContext = entry.contextPhrases.some((phrase) => padded.includes(` ${phrase} `));
      let score = 0;

      // Product code: decisive when distinctive, otherwise only alongside the brand
      // (a bare "310" could be a quantity; "DMC 310" could not).
      if (entry.sku !== '' && tokenSet.has(entry.sku) && (entry.skuIsDistinctive || hasContext)) score += 100;

      // Name: every word must be present.
      let matched = 0;
      let fuzzy = 0;
      for (const word of entry.nameTokens) {
        if (tokenSet.has(word)) matched += 1;
        else if (word.length >= 5 && tokens.some((token) => token.length >= 4 && withinOneEdit(token, word))) {
          matched += 1;
          fuzzy += 1;
        }
      }
      if (entry.nameTokens.length > 0 && matched === entry.nameTokens.length) {
        // Longer names win ("Coal Black" over "Black"); exact beats fuzzy.
        score += 10 * entry.nameTokens.length - fuzzy;
      }

      if (score === 0) continue;
      if (hasContext) score += 5;
      scored.push({ entry, score });
      if (score > bestScore) {
        bestScore = score;
        best = [entry];
      } else if (score === bestScore) {
        best.push(entry);
      }
    }

    const winner = best[0];
    if (winner === undefined) {
      if (mentionedBrands.size === 0) return { resolved: { kind: 'unknown', raw } };
      const named = [...mentionedBrands].sort().join(' or ');
      return {
        resolved: { kind: 'unknown', raw, reason: `Nothing by ${named} in the catalogue matches this.` },
      };
    }
    // Prefer an item still on sale when otherwise tied.
    best.sort((a, b) => Number(a.item.discontinued) - Number(b.item.discontinued));
    const chosen = best[0] as IndexedItem;
    // A discontinued product with the same brand and name as the chosen one
    // is an older version of the same paint, not a different product: offer
    // it, but do not make the line uncertain because of it.
    const olderVersions = best
      .slice(1)
      .filter(
        (entry) =>
          !chosen.item.discontinued &&
          entry.item.discontinued &&
          entry.item.brand === chosen.item.brand &&
          entry.item.name === chosen.item.name,
      );
    const tied = best.slice(1).filter((entry) => !olderVersions.includes(entry));
    const conflicts = conflictingWords(chosen, tokens, brandWords);
    if (conflicts.length === 0) {
      return {
        resolved: {
          kind: 'item',
          raw,
          item: chosen.item,
          alternatives: tied.map((entry) => entry.item),
          ...(olderVersions.length > 0 ? { olderVersions: olderVersions.map((entry) => entry.item) } : {}),
        },
        winner: chosen,
      };
    }
    const others = scored
      .filter(({ entry }) => entry !== chosen)
      .sort((a, b) => b.score - a.score)
      .slice(0, ISSUE_ALTERNATIVES)
      .map(({ entry }) => entry.item);
    return {
      resolved: {
        kind: 'item',
        raw,
        item: chosen.item,
        alternatives: others,
        issue: `“${conflicts.join(' ')}” doesn’t fit ${chosen.item.brand} ${chosen.item.name}. Check which product is meant.`,
      },
      winner: chosen,
    };
  }

  /**
   * A line containing commas is either one item written with a comma
   * ("Mephiston Red, Citadel") or several entries ("Mephiston Red, Nuln Oil").
   * It is one item only when the whole line resolves to a single item and
   * every comma-separated piece consists solely of that item's own words:
   * its name, brand, range or code. Anything else is separate entries, so no
   * entry is ever swallowed by a neighbour that happens to match better.
   */
  function splitOnCommas(line: string): string[] {
    if (!line.includes(',')) return [line];
    const pieces = line.split(',').filter((piece) => piece.trim() !== '');
    const whole = resolveEntry(line);
    const owner = whole.winner;
    if (owner !== undefined && isConfident(whole.resolved)) {
      const describesOwnerOnly = pieces.every((piece) =>
        tokenise(stripDecorations(piece)).every((word) => owner.ownWords.has(word)),
      );
      if (describesOwnerOnly) return [line];
    }
    return pieces;
  }

  function resolve(text: string): ResolvedRecipeLine[] {
    return text
      .split(/[\n;]+/)
      .flatMap(splitOnCommas)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map(resolveLine);
  }

  return { resolveLine, resolve };
}
