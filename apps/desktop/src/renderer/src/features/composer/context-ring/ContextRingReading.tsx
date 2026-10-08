// The context ring's own reading: how much of the window this run has spent. The source note
// table lives here because where a figure came from is part of what it means.

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { ContextWindowSource } from "@ai-sidekicks/contracts/context-window";
import type { ContextWindowReading } from "./context-window-reading.js";

/**
 * What each provenance grade means for a person reading the bar. Total over the closed set, so a
 * new grade fails to compile. `provider_reported` has no note: it is the expected grade, and a note
 * on every reading would hide the one that matters.
 */
const CONTEXT_SOURCE_NOTES: Readonly<Record<ContextWindowSource, string | undefined>> = {
  provider_reported: undefined,
  model_default:
    "The window size is the model's default rather than a figure the provider reported.",
};

/** The meter with a reading behind it, split out so the absent arm is a straight-line return. */
export function ContextRingReading(props: {
  readonly reading: ContextWindowReading;
}): React.JSX.Element {
  const { usagePercent, windowUsedTokens, windowMaxTokens, windowSource } = props.reading;
  const sourceNote = windowSource === undefined ? undefined : CONTEXT_SOURCE_NOTES[windowSource];
  return (
    <div className="meridian-context-ring">
      <span className="meridian-context-ring__label">conversation</span>
      <span
        className="meridian-context-ring__track"
        role="progressbar"
        aria-label="Conversation context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usagePercent}
        aria-valuetext={`${String(usagePercent)} percent of the context window`}
      >
        <span
          className="meridian-context-ring__fill"
          // The one inline style here: it carries a wire figure into CSS.
          style={{ inlineSize: `${String(usagePercent)}%` }}
        />
      </span>
      <span className="meridian-context-ring__figures">
        <WireFigure value={formatCount(usagePercent)} hoverLabel={String(usagePercent)} />
        <span className="meridian-context-ring__unit">%</span>
        <span className="meridian-context-ring__tokens">
          <WireFigure value={formatCount(windowUsedTokens)} hoverLabel={String(windowUsedTokens)} />
          <span className="meridian-context-ring__separator" aria-hidden="true">
            /
          </span>
          <WireFigure value={formatCount(windowMaxTokens)} hoverLabel={String(windowMaxTokens)} />
          <span className="meridian-context-ring__unit">tokens</span>
        </span>
      </span>
      {sourceNote === undefined ? null : (
        <p className="meridian-context-ring__source-note">{sourceNote}</p>
      )}
    </div>
  );
}
