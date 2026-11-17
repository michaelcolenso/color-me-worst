import { useMemo, useRef, useState } from 'react';

import { candidatesOf, createRecipeResolver, isConfident } from '../../lib/catalog/recipeParser';
import type { CatalogItem } from '../../lib/color/types';
import { decodeImage } from '../../lib/image/canvasIo';
import { useStore } from '../store';
import { SplitSwatch } from './SplitSwatch';

/** One thing read from a list or photo, with the catalogue items it could be. */
interface ReviewRow {
  key: string;
  label: string;
  /** Best match first. Empty when nothing matched. */
  candidates: CatalogItem[];
  /**
   * The product to add. Null until the user picks one whenever the reading
   * is not certain: several candidates, or evidence that contradicts the
   * best guess. Nothing uncertain is ever added by default.
   */
  chosenId: string | null;
  selected: boolean;
  /** True when the reading was not certain: the product selector stays offered even after a choice. */
  uncertain: boolean;
  /** Why the best guess needs checking, e.g. a code and a name that disagree. */
  issue?: string;
  /** Why nothing matched, when known. */
  reason?: string;
}

/** What a reader (local or server) found for one entry. */
interface Found {
  label: string;
  candidates: CatalogItem[];
  /** True only when exactly one product fits and nothing contradicts it. */
  confident: boolean;
  issue?: string;
  reason?: string;
}

/** Shape of the server's reply; mirrors `IngestResponse` in worker/ingest.ts. */
interface ServerEntry {
  label: string;
  match: { id: string } | null;
  alternatives: Array<{ id: string }>;
  olderVersions?: Array<{ id: string }>;
  issue?: string;
  reason?: string;
}

/** Give up on a photo request after this long; the server's own model timeout is shorter. */
const PHOTO_TIMEOUT_MS = 100_000;

type Notice = { kind: 'info' | 'error'; text: string };

/** Longest side, in pixels, of the photo sent for label reading: plenty for print, small to upload. */
const UPLOAD_MAX_DIMENSION = 1600;

async function photoToBase64Jpeg(file: File): Promise<string> {
  const image = await decodeImage(file, { maxDimension: UPLOAD_MAX_DIMENSION });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('encode failed'))), 'image/jpeg', 0.85);
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Add many items at once: from a pasted list (matched on this device) or a photo (read by the server). */
export function StashImport() {
  const { store, version } = useStore();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * Increases with every new read or cancel. A photo request that finishes
   * after the user has moved on (pasted a list, cancelled, started another
   * photo) compares against it and is ignored.
   */
  const requestSeq = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const resolver = useMemo(
    () => createRecipeResolver(store.queryCatalog({ limit: Number.MAX_SAFE_INTEGER }).rows.map((row) => row.item)),
    // `version` changes whenever the store's contents do; the store object itself does not.
    [store, version],
  );

  const present = (found: Found[], emptyMessage: string) => {
    // The same item named twice is one thing to own, so repeats are merged.
    // An entry that could be several items is NOT merged by its first guess:
    // "Monument Ivory" then plain "Ivory" may well be two different paints,
    // and the second must stay on screen for the user to choose.
    const seen = new Set<string>();
    const next: ReviewRow[] = [];
    found.forEach(({ label, candidates, confident, issue, reason }, index) => {
      const first = candidates[0];
      // Confident means one product fits; further candidates are only older versions of it.
      const certain = confident && first !== undefined;
      const identity = certain ? `item:${first.id}` : `text:${label.trim().toLowerCase()}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      next.push({
        key: `${index}:${identity}`,
        label,
        candidates,
        chosenId: certain ? first.id : null,
        selected: certain && !store.isOwned(first.id),
        uncertain: !certain,
        ...(issue !== undefined ? { issue } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    });
    setRows(next);
    setNotice(next.length === 0 ? { kind: 'info', text: emptyMessage } : null);
  };

  /** Abandon any photo request in flight; its result will be ignored. */
  const supersede = () => {
    requestSeq.current += 1;
    pending.current?.abort();
    pending.current = null;
    setBusy(null);
  };

  const readList = () => {
    supersede();
    const found = resolver
      .resolve(text)
      .filter((line) => line.kind !== 'color')
      .map(
        (line): Found => ({
          label: line.raw,
          candidates: line.kind === 'item' ? candidatesOf(line) : [],
          confident: isConfident(line),
          ...(line.kind === 'item' && line.issue !== undefined ? { issue: line.issue } : {}),
          ...(line.kind === 'unknown' && line.reason !== undefined ? { reason: line.reason } : {}),
        }),
      );
    present(found, 'Nothing to read. Type or paste one item per line.');
  };

  const readPhoto = async (file: File | undefined) => {
    if (!file) return;
    supersede();
    const seq = requestSeq.current;
    const controller = new AbortController();
    pending.current = controller;
    const timer = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);
    const current = () => seq === requestSeq.current;
    setBusy('Reading labels…');
    setNotice(null);
    try {
      const data = await photoToBase64Jpeg(file);
      if (!current()) return;
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: { mediaType: 'image/jpeg', data } }),
        signal: controller.signal,
      });
      if (!current()) return;
      const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
      if (!isJson) {
        // A static host answers unknown paths with the app page, not with JSON.
        setNotice({ kind: 'error', text: 'Photo import isn’t switched on for this site yet. Paste a list instead.' });
        return;
      }
      const body = (await response.json()) as {
        entries?: ServerEntry[];
        catalogRevision?: number;
        error?: { code: string; message: string };
      };
      if (!current()) return;
      if (!response.ok || !body.entries) {
        setNotice({
          kind: 'error',
          text:
            body.error?.code === 'photo_import_unavailable'
              ? 'Photo import isn’t switched on for this site yet. Paste a list instead.'
              : (body.error?.message ?? 'The photo couldn’t be read. Try again, or paste a list.'),
        });
        return;
      }
      // The server names items by id; only ids this device's catalogue knows are used.
      const found = body.entries.map((entry): Found => {
        const candidates = [entry.match, ...entry.alternatives, ...(entry.olderVersions ?? [])]
          .map((ref) => (ref ? store.getItem(ref.id) : undefined))
          .filter((item): item is CatalogItem => item !== undefined);
        return {
          label: entry.label,
          candidates,
          confident: entry.match !== null && entry.alternatives.length === 0 && entry.issue === undefined,
          ...(entry.issue !== undefined ? { issue: entry.issue } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        };
      });
      present(found, 'No labels could be read in that photo. Try a closer, sharper shot, or paste a list.');
      if (body.catalogRevision !== undefined && body.catalogRevision !== store.catalogRevision) {
        setNotice({
          kind: 'info',
          text: 'The server’s catalogue is a different version from this device’s. Reload the app if some items are missing.',
        });
      }
    } catch {
      if (!current()) return;
      setNotice({
        kind: 'error',
        text: controller.signal.aborted
          ? 'Reading the photo took too long. Try again, or paste a list.'
          : navigator.onLine
            ? 'The photo couldn’t be read. Try again, or paste a list.'
            : 'You’re offline. Photo import needs a connection; pasting a list works offline.',
      });
    } finally {
      clearTimeout(timer);
      if (current()) {
        pending.current = null;
        setBusy(null);
      }
    }
  };

  const update = (key: string, change: Partial<ReviewRow>) =>
    setRows((current) => current?.map((row) => (row.key === key ? { ...row, ...change } : row)) ?? null);

  const chosen = (rows ?? []).filter((row) => row.selected && row.chosenId !== null);
  /** Distinct ids: two rows may end up pointing at the same item once the user has chosen. */
  const chosenIds = [...new Set(chosen.map((row) => row.chosenId as string))];
  const unmatched = (rows ?? []).filter((row) => row.candidates.length === 0);
  const unresolved = (rows ?? []).filter((row) => row.candidates.length > 0 && row.chosenId === null);

  const addChosen = async () => {
    try {
      await store.setOwnedMany(chosenIds, true);
      setNotice({ kind: 'info', text: `Added ${chosenIds.length} to your stash.` });
      setRows(null);
      setText('');
    } catch {
      setNotice({ kind: 'error', text: 'Those couldn’t be saved to this device. Try again.' });
    }
  };

  return (
    <details className="import">
      <summary>Add many at once</summary>
      <div className="import-body">
        <label className="field block">
          <span>Paste a list of what you own</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            placeholder={'One per line, for example:\nMephiston Red\nVallejo 70.950\nDMC 310'}
            spellCheck={false}
          />
        </label>
        <div className="button-row">
          <button type="button" className="button" onClick={readList} disabled={text.trim() === ''}>
            Find these
          </button>
          <button type="button" className="button" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            Read a photo instead
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              void readPhoto(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
        <p className="muted small">
          A pasted list is matched on this device. A photo is different: it is sent to this app’s server and on to
          Google’s Gemini model to read the labels, under Google’s Gemini API terms. This app does not store the photo
          or log what is read from it.
        </p>

        {busy && (
          <p className="notice info" role="status">
            {busy}{' '}
            <button type="button" className="button small" onClick={supersede}>
              Cancel
            </button>
          </p>
        )}
        {notice && (
          <p className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </p>
        )}

        {rows !== null && rows.length > 0 && (
          <div className="import-review">
            <h3>Check what was found</h3>
            <ul className="stash-list single">
              {rows.map((row) => {
                const item = row.candidates.find((candidate) => candidate.id === row.chosenId);
                const alreadyOwned = item !== undefined && store.isOwned(item.id);
                // Offered whenever the reading was uncertain, even with one candidate left
                // (a newer server catalogue can name products this device does not know),
                // and whenever there is more than one product to pick from, such as an
                // older version of a confidently matched paint.
                const needsChoice = row.candidates.length > 0 && (row.uncertain || row.candidates.length > 1);
                return (
                  <li key={row.key} className={item ? undefined : row.candidates.length > 0 ? 'unresolved' : 'unmatched'}>
                    <input
                      type="checkbox"
                      className="import-check"
                      checked={row.selected}
                      disabled={item === undefined || alreadyOwned}
                      onChange={(event) => update(row.key, { selected: event.target.checked })}
                      aria-label={
                        item
                          ? `Add ${item.brand} ${item.name}`
                          : row.candidates.length > 0
                            ? `Choose a product for ${row.label} first`
                            : `No match for ${row.label}`
                      }
                    />
                    {item && <SplitSwatch target={item.color} size="small" />}
                    <div className="stash-item-text">
                      {item ? (
                        <>
                          <strong>
                            {item.brand} {item.name}
                          </strong>
                          <span className="item-meta">
                            {item.line} · read as “{row.label}”{alreadyOwned && <span className="tag">Already owned</span>}
                          </span>
                        </>
                      ) : row.candidates.length > 0 ? (
                        <>
                          <strong>“{row.label}”</strong>
                          <span className="item-meta">Not certain which product this is. Choose one, or leave it out.</span>
                        </>
                      ) : (
                        <>
                          <strong>“{row.label}”</strong>
                          <span className="item-meta">
                            {row.reason ?? 'Not in the catalogue. Check the spelling or add the brand.'}
                          </span>
                        </>
                      )}
                      {row.issue !== undefined && <span className="warning small">{row.issue}</span>}
                      {needsChoice && (
                        <label className="field inline choose">
                          <span>Which product?</span>
                          <select
                            value={row.chosenId ?? ''}
                            onChange={(event) => {
                              const id = event.target.value;
                              update(row.key, id === '' ? { chosenId: null, selected: false } : { chosenId: id, selected: !store.isOwned(id) });
                            }}
                          >
                            {row.uncertain && <option value="">Choose a product…</option>}
                            {row.candidates.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.brand} {candidate.name} · {candidate.line}
                                {/\d/.test(candidate.sku) ? ` · ${candidate.sku}` : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="button-row">
              <button type="button" className="button primary" onClick={() => void addChosen()} disabled={chosenIds.length === 0}>
                Add {chosenIds.length} to my stash
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  supersede();
                  setRows(null);
                }}
              >
                Cancel
              </button>
              {unresolved.length > 0 && <span className="muted small">{unresolved.length} to choose</span>}
              {unmatched.length > 0 && <span className="muted small">{unmatched.length} not recognised</span>}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
