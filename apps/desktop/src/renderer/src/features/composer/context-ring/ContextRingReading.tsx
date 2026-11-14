// The context ring's own reading: how much of the window this run has spent.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { ContextWindowReading } from "#renderer/store/session/events/context-window-reading.js";

/** The meter with a reading behind it, split out so the absent arm is a straight-line return. */
export function ContextRingReading(props: {
  readonly reading: ContextWindowReading;
}): React.JSX.Element {
  const { usagePercent, windowUsedTokens, windowMaxTokens } = props.reading;
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
          // The one inline style here: it carries the app's percent into CSS.
          style={{ inlineSize: `${String(usagePercent)}%` }}
        />
      </span>
      <span className="meridian-context-ring__figures">
        <DerivedFigure text={formatCount(usagePercent)} />
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
    </div>
  );
}
