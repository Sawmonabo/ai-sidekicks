// One run the session knows and the live stream has not described.
//
// `run.subscribeState` is a tail of transitions with no replay and no completion
// marker, so a run that stopped before this pane opened produces nothing on it,
// ever. The session's own record still holds that run — the `run` partition is
// folded from every run-lifecycle event the log carried — and this row is what that
// record renders as.
//
// WHAT IT SAYS, AND WHAT IT REFUSES TO SAY. Every figure here is wire-verbatim off
// the durable payload, so a terminal run reads its terminal: the state it ended in,
// the version it ended at, the stop condition that ended it, and the failure the
// daemon named. What it does not carry is a live reading, and it says so rather
// than letting a row read as current — which is the whole distinction the pane's
// seating exists to keep.
//
// AND IT OFFERS NO CONTROLS. A control's guard is `expectedRunVersion`, and the
// dispatcher reconciles that against the version the STATE STREAM currently carries
// — a reading this row is defined by not having. Offering a control here would mean
// guarding a mutation on a version no live reading confirmed, so the row states the
// run and leaves the acting to a row that has one.

import { Chip, WireFigure } from "../../primitives/index.js";
import type { KnownRun } from "./run-seating.js";
import { RUN_CLEAN_CLOSE_SENTENCE, runStopTriggerPhraseFor } from "./run-status.js";

export interface KnownRunRowProps {
  readonly run: KnownRun;
}

export function KnownRunRow(props: KnownRunRowProps): React.JSX.Element {
  const { run } = props;
  return (
    <article
      className="meridian-known-run"
      aria-label={`Run ${run.runId}, from the session record`}
    >
      <div className="meridian-known-run__line">
        <WireFigure value={run.runId} />
        {run.state === undefined ? null : <Chip mono label={run.state} />}
        {run.runVersion === undefined ? null : <Chip mono label={`v${String(run.runVersion)}`} />}
        {run.touchedAtIso === undefined ? null : <WireFigure value={run.touchedAtIso} />}
      </div>
      {run.stopTrigger === undefined ? null : (
        <p className="meridian-known-run__trigger">
          This run stopped because {runStopTriggerPhraseFor(run.stopTrigger)}.
        </p>
      )}
      {run.intendedClose ? (
        <p className="meridian-known-run__clean-close">{RUN_CLEAN_CLOSE_SENTENCE}</p>
      ) : null}
      {run.failureCategory === undefined ? null : (
        <p className="meridian-known-run__failure">
          <WireFigure value={run.failureCategory} />
          {run.providerFailureDetail === undefined ? null : (
            <span className="meridian-known-run__failure-detail">
              <WireFigure value={run.providerFailureDetail} />
            </span>
          )}
        </p>
      )}
      <p className="meridian-known-run__provenance">
        The live run-state stream has not described this run. What is shown is the session&apos;s
        own record of it, so it is current as of the last event the session carried and not as of
        now, and the controls a live reading carries are not offered against it.
      </p>
    </article>
  );
}
