import { useEffect, useMemo, useState } from 'react';

import { createRecipeResolver, isConfident, type ResolvedRecipeLine } from '../../lib/catalog/recipeParser';
import type { CatalogItem, ColorCoordinates } from '../../lib/color/types';
import {
  VERDICT_LABELS,
  describeMix,
  formatDeltaE,
  summarizeMatch,
  type MatchSummary,
} from '../../lib/match/matchSummary';
import { ItemMeta, itemTitle } from '../components/MatchCard';
import { SplitSwatch } from '../components/SplitSwatch';
import { MIX_WARNING_LABELS } from '../labels';
import { useStore } from '../store';

const EXAMPLE = `Mephiston Red
Evil Sunz Scarlet
Wild Rider Red
Nuln Oil
Retributor Armour
Vallejo 70.950 Black
Rhinox Hide
Screaming Skull
Cloak shadow: #3a1418`;

interface Row {
  key: string;
  line: ResolvedRecipeLine;
  /** What the recipe calls for, when the line was understood. */
  needed?: { title: string; color: ColorCoordinates; item?: CatalogItem };
  /** True when the user owns the exact item named (and has some left). */
  ownsExact: boolean;
  /**
   * True while the line could be several products, or contradicts its best
   * guess, and the user has not chosen. Such a line is neither covered nor
   * on the shopping list: either answer would rest on a guess.
   */
  unresolved: boolean;
  summary?: MatchSummary;
}

/** Wait this long after typing stops before matching the whole list again. */
const EVALUATE_DELAY_MS = 250;

/** Brand, name, range and code: enough to find the right product in a shop. */
function shoppingLine(row: Row): string {
  const item = row.needed?.item;
  if (item === undefined) return row.needed?.title ?? row.line.raw;
  const code = /\d/.test(item.sku) ? ` ${item.sku}` : '';
  return `${item.brand} ${item.name} (${item.line}${code})`;
}

function statusOf(row: Row): { label: string; className: string } {
  if (row.line.kind === 'unknown') return { label: 'Not recognised', className: 'verdict-empty' };
  if (row.unresolved) return { label: 'Choose a product', className: 'verdict-empty' };
  if (row.ownsExact) return { label: 'You own this product', className: 'verdict-exact' };
  const verdict = row.summary?.verdict ?? 'empty';
  return { label: verdict === 'empty' ? 'Not in your stash' : VERDICT_LABELS[verdict], className: `verdict-${verdict}` };
}

/** A line needs buying when nothing owned gets within the gap limit. */
function needsBuying(row: Row): boolean {
  if (row.line.kind === 'unknown' || row.unresolved || row.ownsExact) return false;
  const verdict = row.summary?.verdict;
  return verdict === 'gap' || verdict === 'empty';
}

export function RecipeView() {
  const { store, version } = useStore();
  const [text, setText] = useState('');
  /** `text` as last evaluated: matching every line on every keystroke would make typing lag on long lists. */
  const [evaluated, setEvaluated] = useState('');
  useEffect(() => {
    if (text === '' || text === evaluated) {
      setEvaluated(text);
      return;
    }
    const timer = setTimeout(() => setEvaluated(text), EVALUATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, evaluated]);
  /** User's pick where a line matched several items equally: raw line -> item id. */
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const resolver = useMemo(
    () => createRecipeResolver(store.queryCatalog({ limit: Number.MAX_SAFE_INTEGER }).rows.map((row) => row.item)),
    // `version` changes whenever the store's contents do; the store object itself does not.
    [store, version],
  );

  const rows = useMemo<Row[]>(() => {
    const solver = store.getSolver();
    return resolver.resolve(evaluated).map((line, index): Row => {
      const key = `${index}:${line.raw}`;
      if (line.kind === 'unknown') return { key, line, ownsExact: false, unresolved: false };
      if (line.kind === 'color') {
        return {
          key,
          line,
          ownsExact: false,
          unresolved: false,
          needed: { title: line.label, color: line.color },
          summary: summarizeFor(line.color),
        };
      }
      const chosenId = choices[line.raw];
      const chosen = [line.item, ...line.alternatives].find((candidate) => candidate.id === chosenId);
      // An uncertain line has no item until the user picks one: no default guess.
      const item = chosen ?? (isConfident(line) ? line.item : undefined);
      if (item === undefined) return { key, line, ownsExact: false, unresolved: true };
      const ownsExact = store.isAvailable(item.id);
      return {
        key,
        line,
        ownsExact,
        unresolved: false,
        needed: { title: itemTitle(item), color: item.color, item },
        ...(ownsExact ? {} : { summary: summarizeFor(item.color, item) }),
      };
    });

    function summarizeFor(color: ColorCoordinates, item?: CatalogItem): MatchSummary {
      // Recipes are always answered from the stash: the question is "what can I use instead?".
      // A named item is matched within its own medium and finish.
      const solved = solver.solve(color, {
        mode: 'strict_stash',
        ...(item ? { targetFinish: item.finish, medium: item.medium } : {}),
      });
      return summarizeMatch(solved, 'strict_stash');
    }
    // `version` changes whenever the store's contents do; the store object itself does not.
  }, [resolver, evaluated, choices, store, version]);

  const shopping = rows.filter(needsBuying);
  const unknown = rows.filter((row) => row.line.kind === 'unknown');
  const unresolved = rows.filter((row) => row.unresolved);
  const understood = rows.length - unknown.length - unresolved.length;
  const covered = understood - shopping.length;

  const copyShoppingList = async () => {
    const list = shopping.map((row) => `- ${shoppingLine(row)}`).join('\n');
    try {
      await navigator.clipboard.writeText(list);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="view" aria-labelledby="recipe-heading">
      <h2 id="recipe-heading">Translate a recipe</h2>
      <p className="muted">
        Paste the paint or thread list from a tutorial. Each line is checked against your stash: what you already own,
        the closest substitutes and mixes to try, and what you may need to buy. Substitutes are judged on catalogue
        colour data that hasn’t been checked against real paint, so test before you commit.
      </p>

      <label className="field block">
        <span>Supply list</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={7}
          placeholder={'One item per line, for example:\nMephiston Red\nVallejo 70.950 Black\nCloak shadow: #3a1418'}
          spellCheck={false}
        />
      </label>
      <div className="button-row">
        <button type="button" className="button" onClick={() => setText(EXAMPLE)}>
          Use an example
        </button>
        <button type="button" className="button" onClick={() => setText('')} disabled={text === ''}>
          Clear
        </button>
      </div>

      {rows.length > 0 && (
        <>
          <p className="recipe-summary" role="status">
            <strong>{covered}</strong> of {understood} covered by your stash
            {shopping.length > 0 && (
              <>
                {' '}
                · <strong>{shopping.length}</strong> to buy
              </>
            )}
            {unresolved.length > 0 && <> · {unresolved.length} to choose</>}
            {unknown.length > 0 && <> · {unknown.length} not recognised</>}
          </p>

          <div className="table-scroll">
            <table className="recipe-table">
              <thead>
                <tr>
                  <th scope="col">Recipe calls for</th>
                  <th scope="col">Use from your stash</th>
                  <th scope="col" className="numeric">
                    ΔE
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = statusOf(row);
                  const owned = row.summary?.owned;
                  const line = row.line;
                  return (
                    <tr key={row.key} data-status={status.label}>
                      <th scope="row">
                        {row.unresolved && line.kind === 'item' ? (
                          <div>
                            <span className="muted">“{line.raw}”</span>
                            {line.issue !== undefined && (
                              <>
                                <br />
                                <span className="item-meta warning-text">{line.issue}</span>
                              </>
                            )}
                            <label className="field inline choose">
                              <span>Which product?</span>
                              <select
                                value=""
                                onChange={(event) => setChoices((current) => ({ ...current, [line.raw]: event.target.value }))}
                              >
                                <option value="">Choose a product…</option>
                                {[line.item, ...line.alternatives].map((candidate) => (
                                  <option key={candidate.id} value={candidate.id}>
                                    {candidate.brand} {candidate.name} · {candidate.line}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        ) : row.needed ? (
                          <div className="cell-with-swatch">
                            <SplitSwatch target={row.needed.color} size="small" />
                            <div>
                              <strong>{row.needed.title}</strong>
                              {row.needed.item && (
                                <>
                                  <br />
                                  <ItemMeta item={row.needed.item} />
                                </>
                              )}
                              {line.kind === 'item' && !isConfident(line) && (
                                <label className="field inline choose">
                                  <span>Product:</span>
                                  <select
                                    value={row.needed.item?.id}
                                    onChange={(event) => setChoices((current) => ({ ...current, [line.raw]: event.target.value }))}
                                  >
                                    {[line.item, ...line.alternatives].map((candidate) => (
                                      <option key={candidate.id} value={candidate.id}>
                                        {candidate.brand} {candidate.name} · {candidate.line}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="muted">“{line.raw}”</span>
                        )}
                      </th>
                      <td>
                        {row.ownsExact && row.needed?.item && <span>Use your own {row.needed.item.name}.</span>}
                        {!row.ownsExact && row.needed && owned === undefined && <span className="muted">Nothing suitable yet.</span>}
                        {!row.ownsExact && row.needed && owned !== undefined && (
                          <div className="cell-with-swatch">
                            <SplitSwatch target={row.needed.color} match={row.summary?.ownedColor} size="small" />
                            <div>
                              {row.summary?.verdict === 'gap' && (
                                <>
                                  <span className="item-meta">Nothing close. Nearest, for reference:</span>
                                  <br />
                                </>
                              )}
                              {owned.kind === 'single' ? (
                                <>
                                  <strong>{itemTitle(owned.match.item)}</strong>
                                  <br />
                                  <ItemMeta item={owned.match.item} />
                                </>
                              ) : (
                                <>
                                  <strong>{describeMix(owned.mix, { brands: true })}</strong>
                                  <br />
                                  <span className="item-meta">Predicted mix; test before committing.</span>
                                  {owned.mix.warnings.map((warning) => (
                                    <span key={warning} className="item-meta warning-text">
                                      {' '}
                                      {MIX_WARNING_LABELS[warning]}
                                    </span>
                                  ))}
                                </>
                              )}
                            </div>
                          </div>
                        )}
                        {line.kind === 'unknown' && (
                          <span className="muted">{line.reason ?? 'Check the spelling, or add the brand.'}</span>
                        )}
                        {row.unresolved && <span className="muted">Choose which product the recipe means.</span>}
                      </td>
                      <td className="numeric">
                        {row.ownsExact ? '0.0' : row.summary?.ownedDeltaE != null ? formatDeltaE(row.summary.ownedDeltaE) : '–'}
                      </td>
                      <td>
                        <span className={`verdict ${status.className}`}>{status.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section className="shopping" aria-labelledby="shopping-heading">
            <div className="results-heading">
              <h3 id="shopping-heading">Shopping list</h3>
              {shopping.length > 0 && (
                <button type="button" className="button small" onClick={() => void copyShoppingList()}>
                  {copied ? 'Copied' : 'Copy list'}
                </button>
              )}
            </div>
            {shopping.length === 0 ? (
              <p className="muted">
                {understood === 0
                  ? 'Nothing recognised yet.'
                  : unresolved.length > 0
                    ? `Choose a product for ${unresolved.length === 1 ? 'the line' : `the ${unresolved.length} lines`} marked above to finish the list.`
                    : unknown.length > 0
                      ? 'Nothing to buy among the recognised lines. Check the ones that weren’t recognised.'
                      : 'Nothing to buy: your stash covers every line, by the catalogue’s colour data.'}
              </p>
            ) : (
              <>
                <p className="muted">
                  Colours your stash can’t get close to, even by mixing (estimated ΔE above 4).
                  {unresolved.length > 0 && ` ${unresolved.length} more line${unresolved.length === 1 ? '' : 's'} still to choose.`}
                </p>
                <ul className="shopping-list">
                  {shopping.map((row) => (
                    <li key={row.key}>
                      {row.needed && <SplitSwatch target={row.needed.color} size="small" />}
                      <span>{shoppingLine(row)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
