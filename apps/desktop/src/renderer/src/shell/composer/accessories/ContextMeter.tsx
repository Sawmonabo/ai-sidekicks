// The context-window meter: how full the conversation is.
//
// Always visible at every level, and labelled "conversation" rather than "budget"
// or "usage" — the word is load-bearing. A per-run spend budget is a different
// figure with a different owner, and a meter that said "usage" beside a composer
// would be read as money by half the people who saw it.
//
// THREE THINGS IT WILL NOT DO.
//
//   • It never redraws from a prediction. The bar is the last reading the daemon
//     sent, so a long message being typed moves nothing until a reading arrives.
//   • It never acts on the threshold. Above 80% it adds a sentence and nothing
//     else: automatic compaction is prohibited, and a meter that compacted on a
//     threshold would be the console deciding for the room.
//   • It never renders a partial reading. `usage.context_window_update` has no
//     registered payload variant, so a payload missing a member yields no reading
//     at all and this renders the "not checked" absence — which is a different
//     fact from an empty conversation and is rendered differently (rule 8).
//
// AND IT SAYS WHERE ITS NUMBERS CAME FROM. The registered row carries its own
// provenance and its own exhaustion flag, and both change what the bar MEANS: a
// window size the provider reported is a measurement, one taken from a model default
// or estimated is the console's best available guess, and a provider saying the
// window is full is a fact no ratio has to be derived to believe. So the meter draws
// the same bar and states the grade beside it rather than presenting three different
// kinds of reading as one, and the exceeded arm replaces the near-full hint, because
// advising someone to compact soon is the wrong sentence beside a window that is
// already past its end.
//
// A FIXTURE SHELL, AND THE SEAT BESIDE IT SAYS SO. The meter the usage plan owns
// mounts into `ContextMeterSlot`; this body is what that seat renders while nobody
// has filled it, so the rail is never a blank strip while the owning work is in
// flight. It is DELETED by the PR that mounts the owning body — a shell is not
// superseded quietly, because a shell left in place is a second meter that will
// eventually disagree with the first.

import { Nothing, WireFigure, formatCount } from "../../../console/primitives/index.js";
import { CONTEXT_HINT_PERCENT } from "./accessory-bounds.js";
import type { ContextWindowReading, ContextWindowSource } from "./usage-readings.js";

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

export interface ContextMeterProps {
  /** The newest reading, or `undefined` while the daemon has sent none. */
  readonly reading: ContextWindowReading | undefined;
}

export function ContextMeter(props: ContextMeterProps): React.JSX.Element {
  if (props.reading === undefined) {
    return (
      <Nothing
        kind="not-checked"
        title="Conversation fullness has not been reported."
        detail="The meter draws the daemon's own reading and never estimates one from the messages on screen."
      />
    );
  }
  return <ContextMeterReading reading={props.reading} />;
}

/**
 * The meter with a reading behind it.
 *
 * Split out so the absent arm above is a straight-line return: a component that
 * branched inside its own body would put the bar's geometry and the absence in one
 * scope, and the two share nothing but the word "meter".
 */
function ContextMeterReading(props: { readonly reading: ContextWindowReading }): React.JSX.Element {
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
