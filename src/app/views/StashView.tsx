import { useMemo, useState } from 'react';

import { ItemMeta } from '../components/MatchCard';
import { SplitSwatch } from '../components/SplitSwatch';
import { useStore } from '../store';

const PAGE = 60;

export function StashView() {
  const { store, version } = useStore();
  const [text, setText] = useState('');
  const [brand, setBrand] = useState('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  const brands = useMemo(
    () => store.brands(),
    // `version` changes whenever the store's contents do; the store object itself does not.
    [store, version],
  );
  const result = useMemo(
    () =>
      store.queryCatalog({
        text,
        ...(brand !== 'all' ? { brand } : {}),
        ...(ownedOnly ? { owned: true } : {}),
        limit,
      }),
    // `version` changes whenever the store's contents do; the store object itself does not.
    [store, version, text, brand, ownedOnly, limit],
  );

  const toggle = async (id: string, owned: boolean) => {
    try {
      setError(null);
      await store.setOwned(id, owned);
    } catch {
      setError('That change couldn’t be saved to this device. It will be retried with your next change.');
    }
  };

  return (
    <section className="view" aria-labelledby="stash-heading">
      <h2 id="stash-heading">My stash</h2>
      <p className="muted">
        Tick everything you own. Matches and mixes are built only from these.{' '}
        <strong>
          {store.ownedCount} of {store.catalogSize}
        </strong>{' '}
        owned.
      </p>

      <div className="toolbar">
        <label className="field grow">
          <span>Search</span>
          <input
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setLimit(PAGE);
            }}
            placeholder="Name, brand or code"
          />
        </label>
        <label className="field">
          <span>Brand</span>
          <select
            value={brand}
            onChange={(event) => {
              setBrand(event.target.value);
              setLimit(PAGE);
            }}
          >
            <option value="all">All brands</option>
            {brands.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={ownedOnly} onChange={(event) => setOwnedOnly(event.target.checked)} />
          <span>Only what I own</span>
        </label>
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {result.total === 0 ? (
        <p className="muted">
          {ownedOnly && store.ownedCount === 0 ? 'You haven’t added anything yet. Untick “Only what I own” to browse.' : 'Nothing matches that search.'}
        </p>
      ) : (
        <ul className="stash-list">
          {result.rows.map(({ item, owned }) => (
            <li key={item.id} className={owned ? 'owned' : undefined}>
              <SplitSwatch target={item.color} size="small" />
              <div className="stash-item-text">
                <strong>{item.name}</strong>
                <span className="item-meta">{item.brand}</span>
                <ItemMeta item={item} />
              </div>
              <button
                type="button"
                className={`button small${owned ? ' primary' : ''}`}
                aria-pressed={owned}
                aria-label={`${owned ? 'Remove' : 'Add'} ${item.brand} ${item.name} ${owned ? 'from' : 'to'} my stash`}
                onClick={() => void toggle(item.id, !owned)}
              >
                {owned ? 'Owned' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.total > result.rows.length && (
        <div className="button-row centered">
          <button type="button" className="button" onClick={() => setLimit((current) => current + PAGE)}>
            Show more ({result.total - result.rows.length} left)
          </button>
        </div>
      )}
    </section>
  );
}
