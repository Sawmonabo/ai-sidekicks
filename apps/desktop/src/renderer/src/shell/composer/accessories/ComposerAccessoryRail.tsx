// The composer's trailing rail: the meters, the quota chips, the compaction
// control, the `+` menu, and the seats two other plans fill.
//
// WHERE THE FIGURES COME FROM. The rail selects the session's timeline once and
// folds it three ways under `useMemo` — the newest context reading, the rate
// readings per account and window, and the newest compaction boundary. Three
// components reading the store separately would be three subscriptions to one
// selector, and the fold is pure, so one derivation serves all three.
//
// WHAT THE RAIL DOES NOT DECIDE. It never derives eligibility. The compaction
// control is handed a capability state and a target run and renders what those say;
// the rail does not compute whether compaction is allowed, and where it has not read
// the answer it says so rather than guessing either way.
//
// THE SLOTS ARE `body: undefined` BY CONSTRUCTION, NOT BY OVERSIGHT. Neither seat
// has a registry to be read out of: a body arrives by its owning plan mounting it
// here, and until then the seat renders the reserved state.

import { useMemo } from "react";
import { RealClock } from "../../../console/core/index.js";
import type { ComposerSeatProps } from "../../../console/workspace/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStoreState,
} from "../../../console/store/index.js";
import { CompactionControl } from "./CompactionControl.js";
import { ContextMeter } from "./ContextMeter.js";
import { EditResendSlot, EDIT_RESEND_SLOT_CONTRACT } from "./EditResendSlot.js";
import { PlusMenu } from "./PlusMenu.js";
import { QueueShelf } from "./QueueShelf.js";
import { RateChips } from "./RateChips.js";
import { useQueueFeed } from "./queue-feed.js";
import {
  foldRateLimitReadings,
  newestCompactionBoundarySequence,
  newestContextWindowReading,
} from "./usage-readings.js";

/**
 * The one selector, at module scope so its identity is stable across renders.
 *
 * It returns a STORED reference — the timeline array itself — which is what makes
 * the store's `Object.is` comparison a pointer check. A selector that mapped or
 * filtered here would rebuild an array every notification and re-render the rail on
 * every event in the session.
 */
const selectTimeline = (state: SessionStoreState): readonly ConsoleSessionEvent[] => state.timeline;

/**
 * The clock a countdown is measured against.
 *
 * Module scope and constructed once: a clock built in the render body would be a
 * new object every pass, and `RealClock` holds no state a second instance would
 * fork. Under the fixture the scenario's frozen clock is the one that matters, and
 * the rail prefers it whenever the bridge carries one — which is what keeps a
 * screenshot's relative times byte-stable.
 */
const HOST_CLOCK = new RealClock();

export function ComposerAccessoryRail(props: ComposerSeatProps): React.JSX.Element {
  const timeline = useSessionStore(props.sessionStore, selectTimeline);
  const contextReading = useMemo(() => newestContextWindowReading(timeline), [timeline]);
  const rateReadings = useMemo(() => foldRateLimitReadings(timeline), [timeline]);
  const compactionBoundary = useMemo(() => newestCompactionBoundarySequence(timeline), [timeline]);
  const queueFeed = useQueueFeed(props.bridge, props.sessionStore.sessionId);
  const clock = props.bridge.scenarioEngine?.clock ?? HOST_CLOCK;

  return (
    <div className="meridian-composer__rail">
      <QueueShelf
        items={queueFeed.items}
        cancelRefusalByItemId={queueFeed.cancelRefusalByItemId}
        onCancel={queueFeed.cancelItem}
      />
      <div className="meridian-composer__accessories">
        <div className="meridian-composer__meters">
          <ContextMeter reading={contextReading} />
          <RateChips readings={rateReadings} nowMilliseconds={clock.now()} />
          <CompactionControl
            bridge={props.bridge}
            sessionId={props.sessionStore.sessionId}
            // The capability is a driver declaration the console has no read for:
            // no bridge namespace and no growth-port operation serves the driver's
            // capability flags. `unknown` is therefore the true value, and the
            // control renders "nobody asked" rather than a disabled button.
            capability="unknown"
            targetRunId={undefined}
            completedBoundarySequence={compactionBoundary}
          />
        </div>
        <div className="meridian-composer__actions">
          {/* `body: undefined` is not a lookup this file skipped — the workflow
              picker arrives by its owning plan mounting it, so the seat renders the
              reserved state until it does. */}
          <PlusMenu
            bridge={props.bridge}
            sessionId={props.sessionStore.sessionId}
            workflowStartBody={undefined}
          />
        </div>
      </div>
      <EditResendSlot contract={EDIT_RESEND_SLOT_CONTRACT} body={undefined} />
    </div>
  );
}
