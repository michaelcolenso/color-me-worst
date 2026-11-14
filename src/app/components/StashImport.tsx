import { useMemo, useRef, useState } from 'react';

import { createRecipeResolver } from '../../lib/catalog/recipeParser';
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
  chosenId: string | null;
  selected: boolean;
}

/** Shape of the server's reply; mirrors `IngestResponse` in worker/ingest.ts. */
interface ServerEntry {
  label: string;
  match: { id: string } | null;
  alternatives: Array<{ id: string }>;
}

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

  const resolver = useMemo(
    () => createRecipeResolver(store.queryCatalog({ limit: Number.MAX_SAFE_INTEGER }).rows.map((row) => row.item)),
    // `version` changes whenever the store's contents do; the store object itself does not.
    [store, version],
  );

  const present = (found: Array<{ label: string; candidates: CatalogItem[] }>, emptyMessage: string) => {
    // The same item named twice is one thing to own.
    const seen = new Set<string>();
    const next: ReviewRow[] = [];
    found.forEach(({ label, candidates }, index) => {
      const first = candidates[0];
      const identity = first ? `item:${first.id}` : `text:${label.toLowerCase()}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      next.push({
        key: `${index}:${identity}`,
        label,
        candidates,
        chosenId: first?.id ?? null,
        selected: first !== undefined && !store.isOwned(first.id),
      });
    });
    setRows(next);
    setNotice(next.length === 0 ? { kind: 'info', text: emptyMessage } : null);
  };

  const readList = () => {
    const found = resolver
      .resolve(text)
      .filter((line) => line.kind !== 'color')
      .map((line) => ({
        label: line.raw,
        candidates: line.kind === 'item' ? [line.item, ...line.alternatives] : [],
      }));
    present(found, 'Nothing to read. Type or paste one item per line.');
  };

  const readPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy('Reading labels…');
    setNotice(null);
    try {
      const data = await photoToBase64Jpeg(file);
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: { mediaType: 'image/jpeg', data } }),
      });
      const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
      if (!isJson) {
        // A static host answers unknown paths with the app page, not with JSON.
        setNotice({ kind: 'error', text: 'Photo import isn’t switched on for this site yet. Paste a list instead.' });
        return;
      }
      const body = (await response.json()) as { entries?: ServerEntry[]; error?: { code: string; message: string } };
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
      const found = body.entries.map((entry) => ({
        label: entry.label,
        candidates: [entry.match, ...entry.alternatives]
          .map((ref) => (ref ? store.getItem(ref.id) : undefined))
          .filter((item): item is CatalogItem => item !== undefined),
      }));
      present(found, 'No labels could be read in that photo. Try a closer, sharper shot, or paste a list.');
    } catch {
      setNotice({
        kind: 'error',
        text: navigator.onLine
          ? 'The photo couldn’t be read. Try again, or paste a list.'
          : 'You’re offline. Photo import needs a connection; pasting a list works offline.',
      });
    } finally {
      setBusy(null);
    }
  };

  const update = (key: string, change: Partial<ReviewRow>) =>
    setRows((current) => current?.map((row) => (row.key === key ? { ...row, ...change } : row)) ?? null);

  const chosen = (rows ?? []).filter((row) => row.selected && row.chosenId !== null);
  const unmatched = (rows ?? []).filter((row) => row.candidates.length === 0);

  const addChosen = async () => {
    try {
      await store.setOwnedMany(
        chosen.map((row) => row.chosenId as string),
        true,
      );
      setNotice({ kind: 'info', text: `Added ${chosen.length} to your stash.` });
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
          Anthropic’s Claude model to read the labels. This app does not keep the photo.
        </p>

        {busy && (
          <p className="notice info" role="status">
            {busy}
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
                return (
                  <li key={row.key} className={item ? undefined : 'unmatched'}>
                    <input
                      type="checkbox"
                      className="import-check"
                      checked={row.selected}
                      disabled={item === undefined || alreadyOwned}
                      onChange={(event) => update(row.key, { selected: event.target.checked })}
                      aria-label={item ? `Add ${item.brand} ${item.name}` : `No match for ${row.label}`}
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
                          {row.candidates.length > 1 && (
                            <label className="field inline choose">
                              <span>Could be:</span>
                              <select
                                value={row.chosenId ?? ''}
                                onChange={(event) => {
                                  const id = event.target.value;
                                  update(row.key, { chosenId: id, selected: !store.isOwned(id) });
                                }}
                              >
                                {row.candidates.map((candidate) => (
                                  <option key={candidate.id} value={candidate.id}>
                                    {candidate.brand} {candidate.name} · {candidate.line}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      ) : (
                        <>
                          <strong>“{row.label}”</strong>
                          <span className="item-meta">Not in the catalogue. Check the spelling or add the brand.</span>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="button-row">
              <button type="button" className="button primary" onClick={() => void addChosen()} disabled={chosen.length === 0}>
                Add {chosen.length} to my stash
              </button>
              <button type="button" className="button" onClick={() => setRows(null)}>
                Cancel
              </button>
              {unmatched.length > 0 && <span className="muted small">{unmatched.length} not recognised</span>}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
