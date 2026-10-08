import { useId } from "react";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { WirePercentFigure } from "#renderer/components/WireFigure/WirePercentFigure.js";
import type { Clock } from "#renderer/lib/clock.js";
import { formatDate, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import type { UpdateReading } from "#renderer/store/update/reading.js";
import { LastCheckedLine } from "./LastCheckedLine.js";
import { UPDATE_FAILED_DETAIL, UPDATE_STATE_WORDS } from "./state-words.js";

/** The code the updater's reported failure rides on, for diagnostics. */
const UPDATE_FAILED_CODE = "update-failed";

/** Renders each arm of the updater's state, plus the read not having landed or being refused. */
export function UpdateReadOut(props: {
  readonly reading: UpdateReading;
  /** The window's clock, which the reading line's delay runs on. */
  readonly clock: Clock;
  /** Starts the path again from a check, offered on the failure line. */
  readonly onTryAgain: () => void;
}): React.JSX.Element {
  const { reading, clock } = props;
  const clockLocale = useClockLocale();
  // Generated, since two windows can render this block and a fixed id would tie one window's
  // label to the other's bar.
  const progressId = useId();
  if (reading.kind === "not-read") {
    return <LoadingNotice clock={clock} placement="inline" title="Reading the updater’s state…" />;
  }
  if (reading.kind === "failed") {
    return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  const { state } = reading;
  switch (state.status) {
    case "idle":
      return (
        <p className="meridian-settings-page__state">
          {UPDATE_STATE_WORDS.idle} <LastCheckedLine lastCheckedAt={state.lastCheckedAt} />
        </p>
      );
    case "checking":
      return (
        <p className="meridian-settings-page__state" aria-busy="true">
          {UPDATE_STATE_WORDS.checking}
        </p>
      );
    case "available":
      return (
        <p className="meridian-settings-page__state">
          Update available — <WireFigure value={state.version} />, released{" "}
          <WireFigure
            value={formatDate(state.releasedAt, clockLocale)}
            hoverLabel={formatZonedDateTime(state.releasedAt, clockLocale)}
          />
          .
        </p>
      );
    case "downloading":
      return (
        <div className="meridian-settings-page__state">
          <label className="meridian-settings-page__progress-label" htmlFor={progressId}>
            {UPDATE_STATE_WORDS.downloading}
          </label>
          <progress
            className="meridian-settings-page__progress"
            id={progressId}
            max={100}
            value={state.percent}
          />
          <WirePercentFigure percent={state.percent} />
        </div>
      );
    case "verifying":
      return (
        <p className="meridian-settings-page__state" aria-busy="true">
          {UPDATE_STATE_WORDS.verifying}
        </p>
      );
    case "ready":
      return <p className="meridian-settings-page__state">{UPDATE_STATE_WORDS.ready}</p>;
    case "error":
      // The fixed sentence and `Try again`; the updater's own message goes to the diagnostic log.
      return (
        <InlineRefusal
          code={UPDATE_FAILED_CODE}
          detail={UPDATE_FAILED_DETAIL}
          onTryAgain={props.onTryAgain}
        />
      );
  }
}
