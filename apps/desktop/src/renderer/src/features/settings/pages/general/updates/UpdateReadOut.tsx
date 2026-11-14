import { useId } from "react";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WirePercentFigure } from "#renderer/components/WireFigure/WirePercentFigure.js";
import { useRelativeTimesNow } from "#renderer/hooks/useRelativeTimesNow.js";
import type { Clock } from "#renderer/lib/clock.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import type { UpdateReading } from "#renderer/store/update/reading.js";
import {
  lastCheckedLine,
  UPDATE_FAILED_DETAIL,
  UPDATE_PATH_STEPS,
  updatePathStepOf,
  updateStateLine,
} from "./state-words.js";

/** The code the updater's reported failure rides on, for diagnostics. */
const UPDATE_FAILED_CODE = "update-failed";

/**
 * Renders each arm of the updater's state, with the update path under an arm that found one,
 * plus the read not having landed or being refused.
 */
export function UpdateReadOut(props: {
  readonly reading: UpdateReading;
  /** The version this install runs, which the idle line names as the newest seen. */
  readonly runningVersion: string;
  /** The window's clock, which the reading line's delay runs on. */
  readonly clock: Clock;
  /** Does the failed step again, offered on the failure line. */
  readonly onTryAgain: () => void;
  /** Reads the updater's state again, offered on a failed read. */
  readonly onReadAgain: () => void;
}): React.JSX.Element {
  const { reading, clock } = props;
  const clockLocale = useClockLocale();
  // Generated, since two windows can render this block and a fixed id would tie one window's
  // label to the other's bar.
  const progressId = useId();
  const lastCheckedAt =
    reading.kind === "state" && reading.state.status === "idle"
      ? reading.state.lastCheckedAt
      : undefined;
  // Drawn again only when the age would read differently, on the window's clock.
  const nowMilliseconds = useRelativeTimesNow(
    clock,
    lastCheckedAt === undefined ? [] : [lastCheckedAt],
  );
  if (reading.kind === "not-read") {
    return <LoadingNotice clock={clock} placement="inline" title="Loading update status…" />;
  }
  if (reading.kind === "failed") {
    return (
      <InlineRefusal
        code={reading.refusal.code}
        detail={reading.refusal.detail}
        onTryAgain={props.onReadAgain}
      />
    );
  }
  const { state } = reading;
  const pathStep = updatePathStepOf(state);
  const path = pathStep === undefined ? null : <UpdatePath currentStep={pathStep} />;
  if (state.status === "error") {
    // The fixed sentence and `Try again`; the updater's own message goes to the diagnostic log.
    return (
      <>
        <InlineRefusal
          code={UPDATE_FAILED_CODE}
          detail={UPDATE_FAILED_DETAIL[state.step]}
          onTryAgain={props.onTryAgain}
        />
        {path}
      </>
    );
  }
  const line = <FigureSentence parts={updateStateLine(state, props.runningVersion, clockLocale)} />;
  if (state.status === "downloading") {
    return (
      <div className="meridian-settings-page__state">
        <label className="meridian-settings-page__progress-label" htmlFor={progressId}>
          {line} <WirePercentFigure percent={state.percent} />
        </label>
        <progress
          className="meridian-settings-page__progress"
          id={progressId}
          max={100}
          value={state.percent}
        />
        {path}
      </div>
    );
  }
  const isBusy = state.status === "checking" || state.status === "verifying";
  return (
    <>
      <p className="meridian-settings-page__state" aria-busy={isBusy ? true : undefined}>
        {line}
      </p>
      {lastCheckedAt === undefined ? null : (
        <p className="meridian-settings-page__aside">
          <FigureSentence parts={lastCheckedLine(lastCheckedAt, nowMilliseconds, clockLocale)} />
        </p>
      )}
      {path}
    </>
  );
}

/** The update path as numbered steps: those behind the current one ticked, the current marked. */
function UpdatePath(props: {
  readonly currentStep: (typeof UPDATE_PATH_STEPS)[number];
}): React.JSX.Element {
  const currentIndex = UPDATE_PATH_STEPS.indexOf(props.currentStep);
  return (
    <ol className="meridian-settings-page__update-path">
      {UPDATE_PATH_STEPS.map((step, index) => {
        const progress = index < currentIndex ? "done" : index === currentIndex ? "now" : "todo";
        return (
          <li
            key={step}
            className="meridian-settings-page__update-step"
            data-progress={progress}
            aria-current={progress === "now" ? "step" : undefined}
          >
            {progress === "done" ? <Glyph name="check" /> : null}
            {step}
          </li>
        );
      })}
    </ol>
  );
}
