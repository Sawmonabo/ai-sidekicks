import { useId } from "react";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { formatDate, formatPercent } from "#renderer/lib/wire/figures.js";
import { LastCheckedLine } from "./LastCheckedLine.js";
import { type UpdateReading } from "./updater-reading.js";

/** Renders each arm of the updater's state, plus the read not having landed or being refused. */
export function UpdateReadOut(props: { readonly reading: UpdateReading }): React.JSX.Element {
  const { reading } = props;
  // Generated, since two windows can render this block and a fixed id would tie one window's
  // label to the other's bar.
  const progressId = useId();
  const clock = useClock();
  if (reading.kind === "not-read") {
    return <LoadingNotice clock={clock} placement="inline" title="Reading the updater’s state." />;
  }
  if (reading.kind === "failed") {
    return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  const { state } = reading;
  switch (state.status) {
    case "idle":
      return (
        <p className="meridian-settings-page__state">
          No update is waiting. <LastCheckedLine lastCheckedAt={state.lastCheckedAt} />
        </p>
      );
    case "checking":
      return (
        <p className="meridian-settings-page__state" aria-busy="true">
          Checking for an update…
        </p>
      );
    case "available":
      return (
        <p className="meridian-settings-page__state">
          Update available — <WireFigure value={state.version} />, released{" "}
          <DerivedFigure text={formatDate(state.releasedAt)} />.
        </p>
      );
    case "downloading":
      return (
        <div className="meridian-settings-page__state">
          <label className="meridian-settings-page__progress-label" htmlFor={progressId}>
            Downloading
          </label>
          <progress
            className="meridian-settings-page__progress"
            id={progressId}
            max={100}
            value={state.percent}
          />
          <DerivedFigure text={formatPercent(state.percent / 100)} />
        </div>
      );
    case "verifying":
      return (
        <p className="meridian-settings-page__state" aria-busy="true">
          Checking the signature…
        </p>
      );
    case "ready":
      return (
        <p className="meridian-settings-page__state">
          An update has finished downloading and installs on the next restart.
        </p>
      );
    case "error":
      // The updater's own message, verbatim; the retry is the Check now control beside this.
      return (
        <p
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          role="alert"
        >
          The updater reported a failure. <WireFigure value={state.message} />
        </p>
      );
  }
}
