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
 */

import { colorFromHex } from '../color/colorConversions';
import type { CatalogItem, ColorCoordinates } from '../color/types';

export type ResolvedRecipeLine =
  | {
      kind: 'item';
      /** The text as the user wrote it. */
      raw: string;
      item: CatalogItem;
      /** Other catalogue items that matched equally well, best guess excluded. */
      alternatives: CatalogItem[];
    }
  | { kind: 'color'; raw: string; label: string; color: ColorCoordinates }
  | { kind: 'unknown'; raw: string };

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
    .replace(/\(\s*\d+\s*(?:pots?|bottles?|skeins?|ml)?\s*\)/gi, ' ');
}

/**
 * Build a resolver for a catalogue. Indexing is done once; resolving a line
 * is then a linear scan, which is instant for catalogues of this size.
 */
export function createRecipeResolver(catalog: readonly CatalogItem[]): RecipeResolver {
  const indexed: IndexedItem[] = catalog.map((item) => {
    const sku = normalise(item.sku);
    return {
      item,
      nameTokens: tokenise(item.name),
      contextPhrases: [item.brand, item.line, ...(BRAND_ALIASES[item.brand] ?? [])].map(normalise).filter(Boolean),
      sku,
      skuIsDistinctive: /[a-z.]/.test(sku) || sku.replace(/\D/g, '').length >= 5,
    };
  });

  function resolveLine(line: string): ResolvedRecipeLine {
    const raw = line.trim();
    const hex = HEX_IN_TEXT.exec(raw);
    if (hex) {
      const label = raw.replace(hex[0], '').replace(/^[\s:,\-–—]+|[\s:,\-–—]+$/g, '').trim();
      return { kind: 'color', raw, label: label === '' ? hex[0].toLowerCase() : label, color: colorFromHex(hex[0]) };
    }

    const text = normalise(stripDecorations(raw));
    if (text === '') return { kind: 'unknown', raw };
    const tokens = text.split(/\s+/);
    const tokenSet = new Set(tokens);
    const padded = ` ${text} `;

    let bestScore = 0;
    let best: IndexedItem[] = [];
    for (const entry of indexed) {
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
      if (score > bestScore) {
        bestScore = score;
        best = [entry];
      } else if (score === bestScore) {
        best.push(entry);
      }
    }

    const winner = best[0];
    if (winner === undefined) return { kind: 'unknown', raw };
    // Prefer an item still on sale when otherwise tied.
    best.sort((a, b) => Number(a.item.discontinued) - Number(b.item.discontinued));
    const chosen = best[0] as IndexedItem;
    return { kind: 'item', raw, item: chosen.item, alternatives: best.slice(1).map((entry) => entry.item) };
  }

  function resolve(text: string): ResolvedRecipeLine[] {
    return text
      .split(/[\n;]+/)
      // Commas separate entries too, except inside a line that already resolves as one item.
      .flatMap((line) => {
        if (!line.includes(',')) return [line];
        const whole = resolveLine(line);
        return whole.kind === 'item' && whole.alternatives.length === 0 ? [line] : line.split(',');
      })
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map(resolveLine);
  }

  return { resolveLine, resolve };
}
