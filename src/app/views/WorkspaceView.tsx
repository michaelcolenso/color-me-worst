import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { MatchMode } from '../../lib/color/matchSolver';
import type { MediumType } from '../../lib/color/types';
import { clientToImagePoint, decodeImage, toImageData } from '../../lib/image/canvasIo';
import {
  createImageWorkerClient,
  createInlineImageClient,
  type ImageWorkerClient,
  type WorkerLike,
} from '../../lib/image/imageWorkerClient';
import { extractLoupePatch, sampleLoupe } from '../../lib/image/loupeSampler';
import type { PaletteSwatch } from '../../lib/image/paletteExtractor';
import { whiteBalanceFromPoint, type WhiteBalance } from '../../lib/image/whiteBalance';
import { summarizeMatch } from '../../lib/match/matchSummary';
import { MatchCard } from '../components/MatchCard';
import { MEDIUM_LABELS } from '../labels';
import { createSampleImage } from '../sampleImage';
import { useStore } from '../store';

interface Pin {
  id: number;
  /** Position in image pixels. */
  x: number;
  y: number;
}

type Tool = 'pin' | 'neutral';
type Notice = { kind: 'info' | 'error'; text: string };

const MAX_PINS = 24;
/** Pixels shown in the magnifier, per side. Wider than the kernel, for context. */
const LOUPE_VIEW = 17;
const LOUPE_SCALE = 7;

function createClient(): ImageWorkerClient {
  try {
    const worker = new Worker(new URL('../../lib/image/imageWorker.ts', import.meta.url), { type: 'module' });
    return createImageWorkerClient(worker as unknown as WorkerLike);
  } catch {
    return createInlineImageClient();
  }
}

/** Magnified view of the pixels under a pin, with the sampled square outlined. */
function Loupe({ source, x, y, kernel }: { source: ImageData; x: number; y: number; kernel: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const patch = toImageData(extractLoupePatch(source, x, y, LOUPE_VIEW));
    const scratch = document.createElement('canvas');
    scratch.width = LOUPE_VIEW;
    scratch.height = LOUPE_VIEW;
    scratch.getContext('2d')?.putImageData(patch, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    const inset = ((LOUPE_VIEW - kernel) / 2) * LOUPE_SCALE;
    const side = kernel * LOUPE_SCALE;
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    context.strokeRect(inset, inset, side, side);
    context.lineWidth = 1;
    context.strokeStyle = '#ffffff';
    context.strokeRect(inset, inset, side, side);
  }, [source, x, y, kernel]);
  return (
    <canvas ref={ref} className="loupe" width={LOUPE_VIEW * LOUPE_SCALE} height={LOUPE_VIEW * LOUPE_SCALE} aria-hidden="true" />
  );
}

interface WorkspaceViewProps {
  mode: MatchMode;
  onModeChange(mode: MatchMode): void;
}

export function WorkspaceView({ mode, onModeChange }: WorkspaceViewProps) {
  const { store, version } = useStore();
  const [image, setImage] = useState<ImageData | null>(null);
  const [corrected, setCorrected] = useState<ImageData | null>(null);
  const [balance, setBalance] = useState<WhiteBalance | null>(null);
  const [tool, setTool] = useState<Tool>('pin');
  const [pins, setPins] = useState<Pin[]>([]);
  const [kernel, setKernel] = useState<5 | 11>(11);
  const [medium, setMedium] = useState<MediumType | 'all'>('all');
  const [palette, setPalette] = useState<PaletteSwatch[] | null>(null);
  const [paletteCount, setPaletteCount] = useState(6);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [activePin, setActivePin] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<ImageWorkerClient | null>(null);
  const nextPinId = useRef(1);

  const client = useCallback(() => {
    clientRef.current ??= createClient();
    return clientRef.current;
  }, []);
  useEffect(
    () => () => {
      clientRef.current?.terminate();
      clientRef.current = null;
    },
    [],
  );

  const shown = corrected ?? image;

  // Draw whichever version of the photo is current.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shown) return;
    canvas.width = shown.width;
    canvas.height = shown.height;
    canvas.getContext('2d')?.putImageData(shown, 0, 0);
  }, [shown]);

  // Re-render the corrected photo off the main thread when the balance changes.
  useEffect(() => {
    if (!image || !balance) {
      setCorrected(null);
      return;
    }
    let stale = false;
    client()
      .applyWhiteBalance(image, balance.matrix)
      .then(
        (result) => {
          if (!stale) setCorrected(toImageData(result));
        },
        () => {
          if (!stale) setNotice({ kind: 'error', text: 'Couldn’t redraw the corrected photo. Matches still use the correction.' });
        },
      );
    return () => {
      stale = true;
    };
  }, [image, balance, client]);

  const adopt = useCallback((next: ImageData) => {
    setImage(next);
    setCorrected(null);
    setBalance(null);
    setPins([]);
    setPalette(null);
    setTool('pin');
    setActivePin(null);
  }, []);

  const loadFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setNotice({ kind: 'error', text: 'That file isn’t an image. Choose a JPEG, PNG or WebP photo.' });
        return;
      }
      setBusy('Reading photo…');
      setNotice(null);
      try {
        adopt(await decodeImage(file));
      } catch {
        setNotice({ kind: 'error', text: 'This browser couldn’t read that photo. Try saving it as a JPEG or PNG.' });
      } finally {
        setBusy(null);
      }
    },
    [adopt],
  );

  const loadSample = useCallback(() => {
    setNotice({
      kind: 'info',
      text: 'Sample photo loaded. It has a warm cast: choose “Pick neutral” and tap the grey card to remove it.',
    });
    adopt(createSampleImage());
  }, [adopt]);

  const mediaInCatalog = useMemo(() => {
    const seen = new Set<MediumType>();
    for (const row of store.queryCatalog({ limit: Number.MAX_SAFE_INTEGER }).rows) seen.add(row.item.medium);
    return [...seen];
    // `version` changes whenever the store's contents do; the store object itself does not.
  }, [store, version]);

  const solveOptions = useMemo(() => ({ mode, ...(medium !== 'all' ? { medium } : {}) }), [mode, medium]);

  const pinResults = useMemo(() => {
    if (!image) return [];
    const solver = store.getSolver();
    return pins.map((pin, index) => {
      const sample = sampleLoupe(image, pin.x, pin.y, {
        kernel,
        ...(balance ? { whiteBalance: balance.matrix } : {}),
      });
      return { pin, number: index + 1, sample, summary: summarizeMatch(solver.solve(sample.color, solveOptions), mode) };
    });
    // `version` changes whenever the store's contents do; the store object itself does not.
  }, [image, pins, kernel, balance, solveOptions, mode, store, version]);

  const paletteResults = useMemo(() => {
    if (!palette) return [];
    const solver = store.getSolver();
    return palette.map((swatch) => ({ swatch, summary: summarizeMatch(solver.solve(swatch.color, solveOptions), mode) }));
    // `version` changes whenever the store's contents do; the store object itself does not.
  }, [palette, solveOptions, mode, store, version]);

  const pointFromEvent = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    return clientToImagePoint(canvas, image, event.clientX, event.clientY);
  };

  const handleCanvasClick = (event: { clientX: number; clientY: number }) => {
    const point = pointFromEvent(event);
    if (!point || !image) return;
    if (tool === 'neutral') {
      try {
        const next = whiteBalanceFromPoint(image, point.x, point.y);
        setBalance(next);
        setTool('pin');
        setNotice(
          next.castChroma > 40
            ? {
                kind: 'error',
                text: 'That point is strongly coloured, so it probably isn’t neutral. Colours may now look wrong: pick a grey or white area, or reset.',
              }
            : next.castChroma < 2
              ? { kind: 'info', text: 'That point was already neutral, so nothing needed correcting.' }
              : { kind: 'info', text: 'Lighting cast removed. Pins now read the corrected colours.' },
        );
      } catch (error) {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Couldn’t use that point.' });
      }
      return;
    }
    if (pins.length >= MAX_PINS) {
      setNotice({ kind: 'error', text: `You can place up to ${MAX_PINS} pins. Remove one to add another.` });
      return;
    }
    const id = nextPinId.current++;
    setPins((current) => [...current, { id, ...point }]);
  };

  const movePin = (id: number, x: number, y: number) => {
    if (!image) return;
    const clampedX = Math.min(image.width - 1, Math.max(0, Math.round(x)));
    const clampedY = Math.min(image.height - 1, Math.max(0, Math.round(y)));
    setPins((current) => current.map((pin) => (pin.id === id ? { ...pin, x: clampedX, y: clampedY } : pin)));
  };
  const removePin = (id: number) => {
    setPins((current) => current.filter((pin) => pin.id !== id));
    setActivePin((current) => (current === id ? null : current));
  };

  const handlePinPointerDown = (event: PointerEvent<HTMLButtonElement>, id: number) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setActivePin(id);
  };
  const handlePinPointerMove = (event: PointerEvent<HTMLButtonElement>, id: number) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromEvent(event);
    if (point) movePin(id, point.x, point.y);
  };
  const handlePinPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setActivePin(null);
  };
  const handlePinKey = (event: KeyboardEvent<HTMLButtonElement>, pin: Pin) => {
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      movePin(pin.id, pin.x + move[0], pin.y + move[1]);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removePin(pin.id);
    }
  };

  const autoBalance = async () => {
    if (!image) return;
    setBusy('Estimating the light…');
    try {
      setBalance(await client().autoWhiteBalance(image));
      setNotice({
        kind: 'info',
        text: 'Automatic correction applied. It is an estimate: for accuracy, pick a neutral point instead.',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Automatic correction failed.' });
    } finally {
      setBusy(null);
    }
  };

  const extract = async () => {
    if (!image) return;
    setBusy('Finding the main colours…');
    try {
      const result = await client().extractPalette(image, {
        count: paletteCount,
        ...(balance ? { whiteBalance: balance.matrix } : {}),
      });
      setPalette(result.swatches);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Couldn’t extract a palette.' });
    } finally {
      setBusy(null);
    }
  };

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      hidden
      onChange={(event) => {
        void loadFile(event.target.files?.[0]);
        event.target.value = '';
      }}
    />
  );

  if (!image) {
    return (
      <section className="view" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">Match colours from a photo</h2>
        <div
          className={`dropzone${dropping ? ' dropping' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDropping(false);
            void loadFile(event.dataTransfer.files[0]);
          }}
        >
          <p>
            Open a reference photo, drop pins on the colours you want, and see which of your paints or threads match
            each one.
          </p>
          <div className="button-row">
            <button type="button" className="button primary" onClick={() => fileRef.current?.click()}>
              Choose a photo
            </button>
            <button type="button" className="button" onClick={loadSample}>
              Try the sample photo
            </button>
          </div>
          <p className="muted">Photos stay on this device. Nothing is uploaded.</p>
          {busy && <p role="status">{busy}</p>}
        </div>
        {notice && (
          <p className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </p>
        )}
        {fileInput}
      </section>
    );
  }

  const activeResult = pinResults.find((result) => result.pin.id === activePin);

  return (
    <section className="view workspace" aria-labelledby="workspace-heading">
      <h2 id="workspace-heading" className="visually-hidden">
        Photo workspace
      </h2>
      {fileInput}

      <div className="toolbar primary-bar">
        <div className="segmented" role="group" aria-label="Which items to match against">
          <button type="button" aria-pressed={mode === 'full_catalog'} onClick={() => onModeChange('full_catalog')}>
            Full catalogue
          </button>
          <button type="button" aria-pressed={mode === 'strict_stash'} onClick={() => onModeChange('strict_stash')}>
            My stash only
          </button>
        </div>
        <button type="button" className="button" onClick={() => fileRef.current?.click()}>
          New photo
        </button>
      </div>

      {tool === 'neutral' && (
        <p className="notice info" role="status">
          Tap something in the photo that should be grey or white, such as a grey card, primer or paper.
        </p>
      )}
      {notice && tool !== 'neutral' && (
        <p className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
      {busy && (
        <p className="notice info" role="status">
          {busy}
        </p>
      )}

      <div className="workspace-columns">
        <div className="stage">
          <div className={`stage-frame tool-${tool}`}>
            <canvas
              ref={canvasRef}
              className="stage-canvas"
              onClick={handleCanvasClick}
              aria-label={
                tool === 'neutral'
                  ? 'Reference photo. Tap a neutral area to correct the lighting.'
                  : 'Reference photo. Tap to place a colour pin.'
              }
            />
            {pinResults.map(({ pin, number, sample }) => (
              <button
                key={pin.id}
                type="button"
                className={`pin${activePin === pin.id ? ' active' : ''}`}
                style={{
                  left: `${((pin.x + 0.5) / image.width) * 100}%`,
                  top: `${((pin.y + 0.5) / image.height) * 100}%`,
                  backgroundColor: sample.color.hex,
                }}
                aria-label={`Pin ${number}, colour ${sample.color.hex}. Drag or use arrow keys to move, Delete to remove.`}
                onPointerDown={(event) => handlePinPointerDown(event, pin.id)}
                onPointerMove={(event) => handlePinPointerMove(event, pin.id)}
                onPointerUp={handlePinPointerUp}
                onPointerCancel={handlePinPointerUp}
                onKeyDown={(event) => handlePinKey(event, pin)}
                onFocus={() => setActivePin(pin.id)}
                onBlur={() => setActivePin((current) => (current === pin.id ? null : current))}
              >
                {number}
              </button>
            ))}
            {activeResult && shown && (
              <div
                className={`loupe-holder${activeResult.pin.y / image.height < 0.3 ? ' below' : ''}`}
                style={{
                  left: `${((activeResult.pin.x + 0.5) / image.width) * 100}%`,
                  top: `${((activeResult.pin.y + 0.5) / image.height) * 100}%`,
                }}
              >
                <Loupe source={shown} x={activeResult.pin.x} y={activeResult.pin.y} kernel={kernel} />
              </div>
            )}
          </div>
          <p className="muted stage-hint">
            {pins.length === 0
              ? 'Tap the photo to drop a pin on a colour.'
              : 'Drag a pin to fine-tune it. The outlined square in the magnifier is what gets measured.'}
            {balance && ' Lighting correction is on.'}
          </p>
          <div className="toolbar tools" role="toolbar" aria-label="Photo tools">
          <label className="field">
            <span>Match in</span>
            <select value={medium} onChange={(event) => setMedium(event.target.value as MediumType | 'all')}>
              <option value="all">Everything</option>
              {mediaInCatalog.map((value) => (
                <option key={value} value={value}>
                  {MEDIUM_LABELS[value]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Sample size</span>
            <select value={kernel} onChange={(event) => setKernel(Number(event.target.value) as 5 | 11)}>
              <option value={5}>5 × 5 (fine detail)</option>
              <option value={11}>11 × 11 (flat areas)</option>
            </select>
          </label>

          <div className="button-row">
            <button
              type="button"
              className="button"
              aria-pressed={tool === 'neutral'}
              onClick={() => setTool(tool === 'neutral' ? 'pin' : 'neutral')}
            >
              Pick neutral
            </button>
            <button type="button" className="button" onClick={() => void autoBalance()} disabled={busy !== null}>
              Auto balance
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setBalance(null);
                setNotice(null);
              }}
              disabled={!balance}
            >
              Reset light
            </button>
          </div>

          <div className="button-row">
            <label className="field inline">
              <span className="visually-hidden">Number of palette colours</span>
              <select value={paletteCount} onChange={(event) => setPaletteCount(Number(event.target.value))}>
                {[5, 6, 7, 8, 9, 10, 11, 12].map((count) => (
                  <option key={count} value={count}>
                    {count} colours
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" onClick={() => void extract()} disabled={busy !== null}>
              Extract palette
            </button>
          </div>
          </div>
        </div>

        <div className="results" aria-live="polite">
          {pinResults.length === 0 && paletteResults.length === 0 && (
            <p className="muted">Matches for each pin will appear here.</p>
          )}
          {pinResults.map(({ pin, number, sample, summary }) => (
            <MatchCard
              key={pin.id}
              title={`Pin ${number}`}
              target={sample.color}
              summary={summary}
              note={
                sample.spread > 3 ? (
                  <p className="warning">This pin sits on an edge or texture. Move it onto a flat area for a reliable reading.</p>
                ) : undefined
              }
              actions={
                <button type="button" className="icon-button" onClick={() => removePin(pin.id)} aria-label={`Remove pin ${number}`}>
                  ×
                </button>
              }
            />
          ))}
          {paletteResults.length > 0 && (
            <>
              <div className="results-heading">
                <h3>Main colours in this photo</h3>
                <button type="button" className="button small" onClick={() => setPalette(null)}>
                  Clear
                </button>
              </div>
              {paletteResults.map(({ swatch, summary }, index) => (
                <MatchCard
                  key={`${swatch.color.hex}-${index}`}
                  title={`${Math.round(swatch.population * 100)}% of the photo`}
                  target={swatch.color}
                  summary={summary}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
