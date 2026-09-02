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
// WHERE THE COMPACTION CONTROL'S TWO INPUTS COME FROM. The addressed run is the
// composer's own address — the same resolution the chip rail renders and the send
// bar acts on, so a person reading "steer Ada's turn" and pressing Compact reach the
// same run — and the capability is the BOUND driver's declaration, resolved per
// driver from the capability read. A composer addressed to a channel has no run to
// compact and offers nothing, which is the absent-not-disabled discipline rather
// than a `not-checked` block on every session composer in the console.
//
// THE SLOTS ARE `body: undefined` BY CONSTRUCTION, NOT BY OVERSIGHT. Neither seat
// has a registry to be read out of: a body arrives by its owning plan mounting it
// here, and until then the seat renders the reserved state.

import { useMemo } from "react";
import { useDriverCapabilities } from "../../../console/bridge/index.js";
import { RealClock } from "../../../console/core/index.js";
import type { ComposerSeatProps } from "../../../console/workspace/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStoreState,
} from "../../../console/store/index.js";
import { useComposerAddress } from "../composer-address.js";
import { CompactionControl } from "./CompactionControl.js";
import { compactionCapabilityFor } from "./compaction-capability.js";
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
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  const driverCapabilities = useDriverCapabilities(props.bridge);
  const addressedRun = address.target.path === "provider-bound" ? address.target : undefined;

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
          {addressedRun === undefined ? null : (
            <CompactionControl
              bridge={props.bridge}
              sessionId={props.sessionStore.sessionId}
              capability={compactionCapabilityFor(driverCapabilities, addressedRun.driverName)}
              targetRunId={addressedRun.targetRunId}
              completedBoundarySequence={compactionBoundary}
            />
          )}
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
