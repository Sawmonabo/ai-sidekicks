// The context meter's own reading: how much of the window this run has spent.
//
// Split from `ContextMeter.tsx`, which owns the seat — whether a meter is shown at
// all, and for which run — while this owns what one reading looks like.
//
// THE SOURCE NOTE TRAVELS WITH THE READING. Where a figure came from is part of
// what the figure means (a provider-reported window and a daemon-derived one are
// not the same claim), so the note table lives here beside the render that uses it
// rather than in the seat, which never reads it.

import { WireFigure, formatCount } from "../../../../console/primitives/index.js";
import { CONTEXT_HINT_PERCENT } from "../accessory-bounds.js";
import type { ContextWindowReading, ContextWindowSource } from "../usage-readings.js";

/**
 * What each provenance grade means for a person reading the bar.
 *
 * Total over the closed set, so a fourth grade fails to compile rather than
 * rendering with whatever a fallback said. `provider_reported` carries no sentence
 * at all: it is the grade the meter is designed around, and a note on every
 * ordinary reading is noise that makes the two that matter invisible.
 */
const CONTEXT_SOURCE_NOTES: Readonly<Record<ContextWindowSource, string | undefined>> = {
  provider_reported: undefined,
  model_default:
    "The window size is the model's default rather than a figure the provider reported.",
  estimated: "The counts are estimated rather than reported, so treat the bar as approximate.",
};

/**
 * The meter with a reading behind it.
 *
 * Split out so the absent arm above is a straight-line return: a component that
 * branched inside its own body would put the bar's geometry and the absence in one
 * scope, and the two share nothing but the word "meter".
 */
export function ContextMeterReading(props: {
  readonly reading: ContextWindowReading;
}): React.JSX.Element {
  const { usagePercent, windowUsedTokens, windowMaxTokens, windowSource, exceeded } = props.reading;
  const isExceeded = exceeded === true;
  const isAboveHint = !isExceeded && usagePercent >= CONTEXT_HINT_PERCENT;
  const sourceNote = windowSource === undefined ? undefined : CONTEXT_SOURCE_NOTES[windowSource];
  return (
    <div className="meridian-context-meter">
      <span className="meridian-context-meter__label">conversation</span>
      <span
        className="meridian-context-meter__track"
        role="progressbar"
        aria-label="Conversation context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usagePercent}
        aria-valuetext={`${String(usagePercent)} percent of the context window`}
      >
        <span
          className="meridian-context-meter__fill"
          // The one inline style in this file, and it carries a wire figure into
          // CSS. A class per band would quantise the bar to the bands, and the bar
          // is the figure — the bands are only where the copy changes.
          style={{ inlineSize: `${String(usagePercent)}%` }}
          data-above-hint={isAboveHint ? "true" : undefined}
          data-exceeded={isExceeded ? "true" : undefined}
        />
      </span>
      <span className="meridian-context-meter__figures">
        <WireFigure value={formatCount(usagePercent)} title={String(usagePercent)} />
        <span className="meridian-context-meter__unit">%</span>
        <span className="meridian-context-meter__tokens">
          <WireFigure value={formatCount(windowUsedTokens)} title={String(windowUsedTokens)} />
          <span className="meridian-context-meter__separator" aria-hidden="true">
            /
          </span>
          <WireFigure value={formatCount(windowMaxTokens)} title={String(windowMaxTokens)} />
          <span className="meridian-context-meter__unit">tokens</span>
        </span>
        {windowSource === undefined ? null : (
          <span className="meridian-context-meter__source">
            <WireFigure value={windowSource} />
          </span>
        )}
      </span>
      {isExceeded ? (
        <p className="meridian-context-meter__hint" role="status">
          The provider reports this conversation&rsquo;s context window is full.
        </p>
      ) : null}
      {isAboveHint ? (
        <p className="meridian-context-meter__hint" role="status">
          The conversation is close to full. Compacting it keeps the thread going.
        </p>
      ) : null}
      {sourceNote === undefined ? null : (
        <p className="meridian-context-meter__source-note">{sourceNote}</p>
      )}
    </div>
  );
}
