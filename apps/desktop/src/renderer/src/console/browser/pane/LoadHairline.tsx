// The load hairline, under the address field.
//
// `Spec-023 §Console Design (Meridian)` 12.1 States: "Loading: a determinate progress
// hairline under the address field, driven by the view's own load events."
//
// DETERMINATE WHERE THE VIEW SUPPLIES A FRACTION, and honestly indeterminate where it
// does not. A hairline that invented a fraction — a fixed sweep, a timed ramp, a
// "usually about here" curve — would be a progress figure the renderer made up, and a
// person watching it would read a stalled load as a moving one. The reading's
// `loadProgress` is `null` for exactly that case, and the two arms differ in the one
// way that matters to an assistive technology as well as to an eye: the determinate
// arm carries `aria-valuenow` and the other does not.
//
// IT RENDERS NOTHING WHEN NOTHING IS LOADING. Not a zero-width bar, not an empty
// track — an element that is always there is an element that has to be styled to
// disappear, and a track sitting under the address field on every idle page is a
// permanent hairline the design does not have.

import { LOAD_PROGRESS_MAX, LOAD_PROGRESS_MIN } from "../../core/index.js";

export interface LoadHairlineProps {
  readonly isLoading: boolean;
  /** The view's own fraction between 0 and 1, or `null` where it reports none. */
  readonly progress: number | null;
}

/**
 * A reported fraction, clamped into range, or `undefined` where none was reported.
 *
 * Clamping rather than trusting: the fraction crosses a boundary this window does not
 * own, and a value outside the range would paint a fill wider than its track and
 * hand an assistive technology a percentage above a hundred.
 */
function clampedProgress(progress: number | null): number | undefined {
  if (progress === null || !Number.isFinite(progress)) {
    return undefined;
  }
  return Math.min(LOAD_PROGRESS_MAX, Math.max(LOAD_PROGRESS_MIN, progress));
}

export function LoadHairline(props: LoadHairlineProps): React.JSX.Element | null {
  if (!props.isLoading) {
    return null;
  }
  const fraction = clampedProgress(props.progress);
  return fraction === undefined ? (
    <div
      className="meridian-browser-hairline meridian-browser-hairline--indeterminate"
      role="progressbar"
      aria-label="Loading"
    >
      <span className="meridian-browser-hairline__fill" />
    </div>
  ) : (
    <div
      className="meridian-browser-hairline"
      role="progressbar"
      aria-label="Loading"
      aria-valuemin={LOAD_PROGRESS_MIN}
      aria-valuemax={LOAD_PROGRESS_MAX}
      aria-valuenow={fraction}
    >
      <span
        className="meridian-browser-hairline__fill"
        style={{ inlineSize: `${String(fraction * 100)}%` }}
      />
    </div>
  );
}
