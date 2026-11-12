import type { ColorCoordinates } from '../../lib/color/types';

interface SplitSwatchProps {
  target: ColorCoordinates;
  /** The colour being compared. Omit to show the target alone. */
  match?: ColorCoordinates | undefined;
  targetLabel?: string;
  matchLabel?: string;
  size?: 'small' | 'large';
}

/**
 * Target and match side by side with no gap, border or gradient between
 * them. Two colours can only be judged against each other when they touch:
 * any separator lets the eye adapt to each half on its own and hides small
 * differences. The surround is a fixed mid-grey so neither a light nor a dark
 * page theme shifts how the pair looks.
 */
export function SplitSwatch({ target, match, targetLabel = 'Target', matchLabel = 'Match', size = 'large' }: SplitSwatchProps) {
  const description =
    match === undefined
      ? `${targetLabel} colour ${target.hex}`
      : `${targetLabel} colour ${target.hex} beside ${matchLabel.toLowerCase()} colour ${match.hex}`;
  return (
    <figure className={`split-swatch ${size}`}>
      <div className="split-swatch-colors" role="img" aria-label={description}>
        <div className="split-swatch-half" style={{ backgroundColor: target.hex }} data-testid="swatch-target" />
        {match !== undefined && (
          <div className="split-swatch-half" style={{ backgroundColor: match.hex }} data-testid="swatch-match" />
        )}
      </div>
      {size === 'large' && (
        <figcaption className="split-swatch-caption" aria-hidden="true">
          <span>{targetLabel}</span>
          {match !== undefined && <span>{matchLabel}</span>}
        </figcaption>
      )}
    </figure>
  );
}
