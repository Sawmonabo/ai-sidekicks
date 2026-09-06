// The runs pane's body: the feed, the selection, and the rows it renders.
//
// Split from `RunsPane.tsx`, which is now what its name says — the pane seat,
// resolving a session and mounting this against it. Everything that depends on a
// session actually being there lives below, so the seat has no branch of its own to
// get wrong and the body never has to ask whether it has one.

import { useCallback, useMemo, useState } from "react";
import {
  useDriverCapabilities,
  useDriverCapabilityRepairRead,
  useQueueFeed,
  useQueueRepairRead,
  useRunDriverBindings,
  withRunDriverBindings,
} from "../../bridge/index.js";
import { DerivedFigure, formatCount, InlineRefusal } from "../../primitives/index.js";
import {
  useRefusalBannerEscalation,
  useSessionPartition,
  type SessionStore,
} from "../../store/index.js";
import { requestComposerFocus, type PaneContextOf } from "../../seats/index.js";
import { KnownRunRow } from "./KnownRunRow.js";
import { QueueContents } from "./queue/QueueContents.js";
import {
  RunInterventionComposer,
  type ComposedControl,
} from "./interventions/RunInterventionComposer.js";
import { RunRow } from "./RunRow.js";
import { settledRunPosture } from "./run-posture.js";
import { seatRuns } from "./run-seating.js";
import { useRunControlCommands } from "./controls/run-control-commands.js";
import { useRunControlSurface } from "./controls/run-control-surface.js";
import { useRunFeed } from "./run-state-feed.js";
import { NoRuns } from "./NoRuns.js";
import { AwaitingProjection } from "./AwaitingProjection.js";

/** Which run is being composed against, and with which of the two body controls. */
interface ComposerTarget {
  readonly runId: string;
  readonly control: ComposedControl;
}

/**
 * The pane's reads, held once for the whole pane.
 *
 * Split from the frame above so the hooks are never called conditionally: the
 * session check belongs at a boundary, and a body that runs only inside a session
 * is what keeps every subscription's lifetime the same as this component's.
 */
export function RunsPaneBody(props: {
  readonly context: PaneContextOf<"runs">;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const { context, sessionStore } = props;
  const stateFeed = useRunFeed(context.bridge, sessionStore);
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
  // Two reads, joined here. The declarations are the NODE's and are shared by every
  // session in this window; which driver each run is bound to is this session's own
  // projection, and `driver.listCapabilities` names no run at all — so on a node with
  // two drivers installed, a readout without this join can name no binding for any
  // run and takes Rewind and Steer off every row.
  const declarations = useDriverCapabilities(context.bridge);
  useDriverCapabilityRepairRead(context.bridge, sessionStore);
  useQueueRepairRead(context.bridge, sessionStore);
  const runDriverBindings = useRunDriverBindings(sessionStore);
  const driverCapabilities = useMemo(
    () => withRunDriverBindings(declarations, runDriverBindings),
    [declarations, runDriverBindings],
  );
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

  // A refusal that ends the whole session rather than this pane's read reaches the
  // frame's banner instead of a line inside one pane. The subscription's open
  // refusal is where `session.not_found` lands here, because that is the call that
  // names the session.
  useRefusalBannerEscalation(context.frameStore, stateFeed.openRefusal);

  // The same six acts the rows draw, reachable from the palette while this pane is
  // open. Contributed here rather than at module scope because every one of them
  // closes over this pane's dispatcher, and dispatched through that same surface so
  // a palette press and a button press are one mutation with one idempotency key.
  useRunControlCommands({
    runs: stateFeed.runs,
    driverCapabilities,
    surface,
    onRequestSteer,
    onRequestRewind,
  });

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
          <AwaitingProjection
            runIds={seating.awaitingProjectionRunIds}
            withheldCount={seating.withheldKnownRunCount}
          />
        ) : null}
        {seating.rows.length === 0 ? (
          <NoRuns
            hasRead={stateFeed.hasRead}
            openRefusal={stateFeed.openRefusal}
            // The empty state names an act this pane cannot perform — the composer
            // is the workspace's, mounted beside the deck — so it asks for it
            // rather than reaching into another family for the element.
            onStart={requestComposerFocus}
          />
        ) : (
          <div className="meridian-runs__rows" role="feed" aria-label="Runs in this session">
            {seating.rows.map((seated) =>
              seated.source === "projected" ? (
                <RunRow
                  key={seated.runId}
                  run={seated.projection}
                  // One arrival path for the daemon's stamp: the durable entry the
                  // approvals pane reads, with this row's own stream projection as
                  // the named fallback for a run the partition has not caught up to.
                  posture={settledRunPosture(
                    knownRuns[seated.runId],
                    seated.projection.executionPosture,
                  )}
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
            // Keyed by the identity being composed against, so pressing Steer or
            // Rewind on a second run REMOUNTS the form rather than re-rendering the
            // first one's body, target, refusal, and pending dispatch under a new
            // heading. React's designed reset, and the form defends it a second time
            // from the inside — see its own identity effect — so a later caller
            // that drops this key does not silently reintroduce the leak.
            key={`${composerTarget.runId}:${composerTarget.control}`}
            bridge={context.bridge}
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
