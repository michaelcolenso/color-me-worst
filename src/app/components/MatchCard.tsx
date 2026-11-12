import type { ReactNode } from 'react';

import { displayCaveatOf } from '../../lib/color/matchSolver';
import type { CatalogItem, ColorCoordinates } from '../../lib/color/types';
import { VERDICT_LABELS, describeMix, formatDeltaE, type MatchSummary } from '../../lib/match/matchSummary';
import { CAVEAT_LABELS, FINISH_LABELS, MIX_WARNING_LABELS } from '../labels';
import { SplitSwatch } from './SplitSwatch';

export function itemTitle(item: CatalogItem): string {
  return `${item.brand} ${item.name}`;
}

export function ItemMeta({ item }: { item: CatalogItem }) {
  const caveat = displayCaveatOf(item);
  return (
    <span className="item-meta">
      {item.line}
      {/* Show a product code only when it is a real one; some seed SKUs are just the name again. */}
      {/\d/.test(item.sku) && ` · ${item.sku}`}
      {item.finish !== 'matte' && <span className="tag">{FINISH_LABELS[item.finish]}</span>}
      {item.discontinued && <span className="tag">Discontinued</span>}
      {caveat !== null && (
        <span className="tag caution" title={CAVEAT_LABELS[caveat]}>
          Screen colour is approximate
        </span>
      )}
    </span>
  );
}

interface MatchCardProps {
  /** Heading, e.g. "Pin 2" or a recipe line. */
  title: ReactNode;
  target: ColorCoordinates;
  summary: MatchSummary;
  /** Extra line under the heading, e.g. a sampling warning. */
  note?: ReactNode;
  /** Controls shown at the top right, e.g. a remove button. */
  actions?: ReactNode;
}

/** One target colour and the best thing the user can do about it. */
export function MatchCard({ title, target, summary, note, actions }: MatchCardProps) {
  const { owned, verdict, toBuy } = summary;
  return (
    <article className="match-card" data-verdict={verdict}>
      <header className="match-card-header">
        <h3>{title}</h3>
        <span className={`verdict verdict-${verdict}`}>{VERDICT_LABELS[verdict]}</span>
        {actions}
      </header>
      {note}
      <SplitSwatch target={target} match={summary.ownedColor} matchLabel={owned?.kind === 'mix' ? 'Mix' : 'Yours'} />
      <div className="match-card-body">
        {owned === undefined && <p className="muted">Add what you own in the Stash tab to see matches from it.</p>}
        {owned !== undefined && verdict === 'gap' && (
          <p className="muted">Nothing you own gets close. The nearest you could manage, for reference:</p>
        )}
        {owned?.kind === 'single' && (
          <p>
            <strong>{itemTitle(owned.match.item)}</strong>
            <span className="delta" title="CIEDE2000 colour difference; under 1.5 is not visible">
              ΔE {formatDeltaE(owned.match.deltaE00)}
            </span>
            <br />
            <ItemMeta item={owned.match.item} />
          </p>
        )}
        {owned?.kind === 'mix' && (
          <>
            <p>
              <strong>{describeMix(owned.mix)}</strong>
              <span className="delta" title="Predicted CIEDE2000 colour difference of the mix">
                ΔE {formatDeltaE(owned.mix.deltaE00)}
              </span>
              <br />
              <span className="item-meta">
                {owned.mix.itemA.brand}
                {owned.mix.itemA.brand !== owned.mix.itemB.brand && ` + ${owned.mix.itemB.brand}`} · predicted, so
                test on a spare surface first
              </span>
            </p>
            {owned.mix.warnings.map((warning) => (
              <p key={warning} className="warning">
                {MIX_WARNING_LABELS[warning]}
              </p>
            ))}
          </>
        )}
        {toBuy !== undefined && (
          <p className="to-buy">
            <SplitSwatch target={target} match={toBuy.item.color} size="small" />
            <span>
              Closer if you buy <strong>{itemTitle(toBuy.item)}</strong>
              <span className="delta">ΔE {formatDeltaE(toBuy.deltaE00)}</span>
            </span>
          </p>
        )}
      </div>
    </article>
  );
}
