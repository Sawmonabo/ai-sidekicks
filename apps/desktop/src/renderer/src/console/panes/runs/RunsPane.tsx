// Every run in the session with its live status, its queue, and its intervention
// history, in one place that never invents a state.
//
// `Spec-023 §Signature Feature Composition Sketches`' Runs View names the pane's
// data sources — "daemon run-state subscription per Spec-004; daemon queue
// subscription per Spec-004" — and this pane reads them as a live spine of two
// session-scoped subscriptions and one snapshot: `run.subscribeState` streaming
// `RunStateChangeEvent | RunRolledBackEvent`, `run.subscribeQueue` streaming
// `QueueItemSummary`, and the `run.queueList` snapshot. Both subscriptions are
// session-scoped and the fan-out per run is client-side, on the event's own
// `runId` — which is what `run-state-feed.ts` does.
//
// WHAT EACH ABSENCE MEANS, AND WHY THEY ARE DIFFERENT SENTENCES.
//
//   • **No session.** The pane is addressed within a session; opened on a bare
//     route there is nothing to read and no read to wait for.
//   • **Nothing delivered yet.** `not-loaded` — a read IS in flight, the session's
//     snapshot has not landed, and a skeleton is the honest shape.
//   • **Delivered, and there are no runs.** `empty`, with the start affordance
//     beside it. This is the one arm that may say "there are none", and it is
//     reachable only once the snapshot has landed naming none.
//
// And two things that are none of the three. A stream that is open and answering
// while some of what it answered parsed as neither registered arm: not an absence
// and not a refusal — the feed is live and partial at once — so it renders as a
// sentence BESIDE the rows rather than in place of them, and settles nothing, which
// is why it announces nothing. And a run the session's own record knows that the
// live tail has not described, which is neither missing nor current: it draws its
// row from `run-seating.ts` and the pane names how many such rows it is drawing and
// which runs they are, because a list that quietly omitted them would read as a
// session with fewer runs than it has.
//
// The three are `Spec-023`'s five kinds of nothing applied as they are meant to be:
// "we have not asked", "we are asking", and "there is none" are three facts and the
// pane never lets one stand in for another.
//
// WHAT THE PANE DOES NOT DO. It never sums the run rows into a session total —
// summing the runs visible in a run list is expressly not a permitted derivation,
// and the receipt has its own single accountant elsewhere. It holds no queue in
// client memory as the record: the queue's rows come from the daemon's snapshot and
// its tail, and cancel changes a row only when the daemon says it changed.

import { useCallback, useMemo, useState } from "react";

import { useDriverCapabilities, useQueueFeed } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import {
  DerivedFigure,
  formatCount,
  InlineRefusal,
  Nothing,
  WireFigure,
} from "../../primitives/index.js";
import { useSessionPartition, type SessionStore } from "../../store/index.js";
import { ConsolePaneChrome, paneScopeCrumbs, type PaneContextOf } from "../pane-chrome.js";
import { KnownRunRow } from "./KnownRunRow.js";
import { QueueContents } from "./QueueContents.js";
import { RunInterventionComposer, type ComposedControl } from "./RunInterventionComposer.js";
import { RunRow } from "./RunRow.js";
import { seatRuns } from "./run-seating.js";
import { useRunControlSurface } from "./run-control-surface.js";
import { useRunStateFeed } from "./run-state-feed.js";

/** Which run is being composed against, and with which of the two body controls. */
interface ComposerTarget {
  readonly runId: string;
  readonly control: ComposedControl;
}

export function RunsPane(context: PaneContextOf<"runs">): React.JSX.Element {
  return (
    <ConsolePaneChrome kind="runs" leadingCrumbs={paneScopeCrumbs()} focusHue={context.focusHue}>
      {context.sessionStore === undefined ? (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This pane was opened outside a session."
          detail="Runs belong to a session, so there is nothing to read here. Open a session and the pane reads its runs, its queue, and the interventions raised against them."
        />
      ) : (
        <RunsPaneBody context={context} sessionStore={context.sessionStore} />
      )}
    </ConsolePaneChrome>
  );
}

/**
 * The pane's reads, held once for the whole pane.
 *
 * Split from the frame above so the hooks are never called conditionally: the
 * session check belongs at a boundary, and a body that runs only inside a session
 * is what keeps every subscription's lifetime the same as this component's.
 */
function RunsPaneBody(props: {
  readonly context: PaneContextOf<"runs">;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const { context, sessionStore } = props;
  const stateFeed = useRunStateFeed(context.bridge, sessionStore);
  const queueFeed = useQueueFeed(context.bridge, sessionStore.sessionId);
  // Which runs the session HAS, as its snapshot established them and its log has
  // gone on folding. The stream describes what has happened to a run and says
  // nothing about a run nothing has happened to since the pane opened, so this is
  // the read that answers which runs exist and the stream is the tail over it.
  const knownRuns = useSessionPartition(sessionStore, "run");
  // Seated once per change of either reading rather than at each render: the seat
  // walks the partition and the projections, and a render body that rebuilt it
  // would do that on every keystroke in the composer below.
  const seating = useMemo(() => seatRuns(knownRuns, stateFeed.runs), [knownRuns, stateFeed.runs]);
  const driverCapabilities = useDriverCapabilities(context.bridge);
  const surface = useRunControlSurface(context.bridge);
  const [composerTarget, setComposerTarget] = useState<ComposerTarget | undefined>(undefined);

  const onRequestRewind = useCallback((runId: string) => {
    setComposerTarget({ runId, control: "rollback" });
  }, []);

  const onRequestSteer = useCallback((runId: string) => {
    setComposerTarget({ runId, control: "steer" });
  }, []);

  const onDismissComposer = useCallback(() => {
    setComposerTarget(undefined);
  }, []);

  // The composer is offered only against a run the STREAM has described: its guard
  // is `expectedRunVersion` reconciled against the live reading, which a row seated
  // from the session's record does not have — and that row offers no control to
  // reach this from either.
  const composedRun =
    composerTarget === undefined
      ? undefined
      : stateFeed.runs.find((run) => run.runId === composerTarget.runId);

  return (
    <div className="meridian-runs">
      <section className="meridian-runs__section" aria-label="Runs in this session">
        {driverCapabilities?.readRefusal === undefined ? null : (
          // Rewind and Steer are gated on the declarations, so a read that failed
          // takes both controls off every row. Saying so here is the difference
          // between "no driver here declares them" and "nobody could ask".
          <InlineRefusal
            code={driverCapabilities.readRefusal.code}
            detail={driverCapabilities.readRefusal.detail}
          />
        )}
        {stateFeed.unreadableDeliveryCount > 0 ? (
          // Live and partial at once, which is neither an absence nor a refusal:
          // the stream is open and answering, and some of what it answered this
          // build could not read. Said beside the list rather than in place of it,
          // so a reading that is behind is never presented as a current one.
          <p className="meridian-runs__incomplete-stream">
            The run-state stream has carried{" "}
            <DerivedFigure text={formatCount(stateFeed.unreadableDeliveryCount)} />{" "}
            {stateFeed.unreadableDeliveryCount === 1 ? "delivery" : "deliveries"} this build could
            not read, so what is shown here may be behind what the daemon has sent.
          </p>
        ) : null}
        {seating.awaitingProjectionRunIds.length > 0 ? (
          // Neither missing nor current, so neither an absence nor a refusal: the
          // session's record knows these runs and the live tail has not described
          // them. Said with the count AND the ids, because "some rows are not live"
          // is unactionable and "these two are not live" is what a person checks.
          <AwaitingProjection runIds={seating.awaitingProjectionRunIds} />
        ) : null}
        {seating.rows.length === 0 ? (
          <NoRuns hasRead={stateFeed.hasRead} openRefusal={stateFeed.openRefusal} />
        ) : (
          <div className="meridian-runs__rows" role="feed" aria-label="Runs in this session">
            {seating.rows.map((seated) =>
              seated.source === "projected" ? (
                <RunRow
                  key={seated.runId}
                  run={seated.projection}
                  surface={surface}
                  bridge={context.bridge}
                  driverCapabilities={driverCapabilities}
                  onRequestRewind={onRequestRewind}
                  onRequestSteer={onRequestSteer}
                />
              ) : (
                <KnownRunRow key={seated.runId} run={seated.known} />
              ),
            )}
          </div>
        )}
      </section>
      {composerTarget !== undefined && composedRun !== undefined ? (
        <section className="meridian-runs__section" aria-label="Compose an intervention">
          <RunInterventionComposer
            run={composedRun}
            control={composerTarget.control}
            surface={surface}
            onDismiss={onDismissComposer}
          />
        </section>
      ) : null}
      <section className="meridian-runs__section" aria-label="Queue">
        <h3 className="meridian-runs__section-title">Queue</h3>
        <QueueContents feed={queueFeed} />
      </section>
    </div>
  );
}

/**
 * The runs the session knows and the live tail has not described.
 *
 * Beside the rows and never in place of them: each of these runs already HAS a row,
 * seated from the session's own record, so this sentence qualifies the list rather
 * than standing in for it. It names the ids as well as the count because the count
 * alone leaves a person unable to tell which of the rows in front of them is the
 * one that is not live.
 */
function AwaitingProjection(props: { readonly runIds: readonly string[] }): React.JSX.Element {
  return (
    <p className="meridian-runs__awaiting-projection">
      The live run-state stream has not described{" "}
      <DerivedFigure text={formatCount(props.runIds.length)} />{" "}
      {props.runIds.length === 1 ? "run" : "runs"} this session knows, so{" "}
      {props.runIds.length === 1 ? "its row reads" : "their rows read"} from the session&apos;s own
      record rather than from a live reading:{" "}
      {props.runIds.map((runId, position) => (
        <span key={runId}>
          {position === 0 ? null : ", "}
          <WireFigure value={runId} />
        </span>
      ))}
      .
    </p>
  );
}

/**
 * Two different absences, told apart by whether the read that says WHICH RUNS EXIST
 * has completed — and, ahead of both, the refusal that says the stream was never
 * opened.
 *
 * Reached only when the seating produced no row at all, which is now the exact
 * condition under which the session knows of no run and the stream has projected
 * none. `empty` is the arm once the snapshot has landed, and `not-loaded` the arm
 * before it: a session whose snapshot names runs seats rows for them and never
 * arrives here, which is what retires the skeleton that used to outlive every
 * terminal pre-existing run.
 */
function NoRuns(props: {
  readonly hasRead: boolean;
  readonly openRefusal: ConsoleRefusal | undefined;
}): React.JSX.Element {
  if (props.openRefusal !== undefined) {
    return <InlineRefusal code={props.openRefusal.code} detail={props.openRefusal.detail} />;
  }
  if (!props.hasRead) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the runs in this session." />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="No run has started in this session yet."
      detail="Send a message to an agent and its run appears here with its status, its queue, and every intervention raised against it."
    />
  );
}
