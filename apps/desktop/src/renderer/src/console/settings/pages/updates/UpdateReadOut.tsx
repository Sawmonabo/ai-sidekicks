import { useId } from "react";
import {
  DerivedFigure,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatPercent,
} from "../../../primitives/index.js";
import { type UpdateReading } from "./updater-reading.js";

/** The five arms, plus the conversation's own absence. One render per arm. */
export function UpdateReadOut(props: { readonly reading: UpdateReading }): React.JSX.Element {
  const { reading } = props;
  // Generated rather than written: two windows can render this block at once, and a
  // hardcoded id would associate one window's label with the other's bar.
  const progressId = useId();
  if (reading.kind === "not-read") {
    return <Nothing kind="not-loaded" placement="inline" title="Reading the updater’s state." />;
  }
  if (reading.kind === "unreachable") {
    // Quiet, and informational. Nothing failed: the update feed was not reached, and
    // saying otherwise would put words in an updater's mouth — so the sentence stays
    // an aside and the refusal takes the console's INLINE shape, whose grammar is
    // "nothing changed, the control stays" and whose role is `status` rather than
    // `alert`. What that buys is the part the aside could not say: the refuser's own
    // code, which rule 9 requires verbatim and which this arm used to discard.
    return (
      <p className="meridian-settings-page__aside">
        The update feed was not reached from this window. <InlineRefusal {...reading.refusal} />
      </p>
    );
  }
  const { state } = reading;
  switch (state.status) {
    case "idle":
      return <p className="meridian-settings-page__state">No update is waiting.</p>;
    case "checking":
      return (
        <p className="meridian-settings-page__state" aria-busy="true">
          Checking for an update…
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
    case "ready":
      return (
        <p className="meridian-settings-page__state">
          An update has finished downloading and installs on the next restart.
        </p>
      );
    case "error":
      // The updater's own message, verbatim. The retry is the Check now control
      // beside this read-out, which is the one path back.
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
