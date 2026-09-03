// The composer's trailing rail: the queue shelf, the `+` menu, and the five seats
// other plans fill — the two meters, the compaction control, the edit-and-resend
// editor, and the workflow picker.
//
// WHERE THE FIGURES COME FROM. The rail selects the session's timeline once and
// folds it two ways under `useMemo` — the newest context reading, and the newest
// compaction boundary of the ADDRESSED RUN. Two components reading the store
// separately would be two subscriptions to one selector, and the fold is pure, so one
// derivation serves both. The compaction fold takes the address as an input rather
// than reading every compaction row in the session: a session with two runs would
// otherwise show one run's boundary under the other's control.
//
// THE QUOTA CHIPS COME OFF THE ACCOUNT PLANE AND NOT OFF THIS TIMELINE. They used to
// be a third fold here, over `usage.rate_limit_update` — a row `Spec-006 §Daemon-Scope
// Event Binding And Node-Scope Anchoring` binds to the reserved node-scope sentinel
// session, so no session store this rail can select from ever holds one. The chips
// were therefore reachable only under a fixture that put the row in a session's log,
// and against a daemon the seat would have rendered nothing forever. They now read
// `console/bridge/provider-account-quota.ts`, which is one `providerAccount.list` and
// one `providerAccount.subscribe` per BRIDGE — node-scoped, like the readings — and a
// read that failed says so beside the meters rather than leaving a quota-shaped
// silence that reads as healthy.
//
// THE SHELF ASKS A NARROWER QUESTION OF THE SESSION'S ONE QUEUE READING. The rows
// still waiting are what the shelf holds; the runs pane shows the whole queue,
// including what has left it. That is a filter over one list rather than a second
// subscription — the composer used to open its own, so a session view holding both
// surfaces tailed one stream twice.
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
// THE SLOTS ARE `body: undefined` BY CONSTRUCTION, NOT BY OVERSIGHT. None of the
// five seats has a registry to be read out of: a body arrives by its owning plan
// mounting it here, and until then the seat renders the reserved state.
//
// FIVE SEATS, AND WHAT EACH RESERVED STATE LOOKS LIKE. The two plan-owned seats at
// the ends of this rail — the edit-and-resend editor and the workflow picker — have
// no shell behind them, so their reserved state is the "not built yet" absence. The
// three the usage plan owns — the context meter, the rate-limit indicator, and the
// compaction control — have a FIXTURE SHELL behind them, so what a person meets
// today is a real meter drawn from real readings and what arrives later replaces the
// shell rather than filling a hole. Either way the composer's half is the same: the
// placement, the framing, and the readings this file folds. It authors no body.

import { useMemo } from "react";
import {
  useDriverCapabilities,
  useProviderQuotas,
  useQueueFeed,
} from "../../../console/bridge/index.js";
import { RealClock } from "../../../console/core/index.js";
import { InlineRefusal } from "../../../console/primitives/index.js";
import type { ComposerSeatProps } from "../../../console/seats/index.js";
import {
  useSessionStore,
  type ConsoleSessionEvent,
  type SessionStoreState,
} from "../../../console/store/index.js";
import { useComposerAddress } from "../composer-address.js";
import { CompactionSlot, COMPACTION_SLOT_CONTRACT } from "./CompactionSlot.js";
import { compactionCapabilityFor } from "./compaction-capability.js";
import { ContextMeterSlot, CONTEXT_METER_SLOT_CONTRACT } from "./ContextMeterSlot.js";
import { EditResendSlot, EDIT_RESEND_SLOT_CONTRACT } from "./EditResendSlot.js";
import { PlusMenu } from "./PlusMenu.js";
import { QueueShelf } from "./QueueShelf.js";
import { RateLimitSlot, RATE_LIMIT_SLOT_CONTRACT } from "./RateLimitSlot.js";
import { waitingQueueRows } from "./waiting-queue.js";
import { newestCompactionBoundarySequence, newestContextWindowReading } from "./usage-readings.js";

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
  // Node-scoped and therefore keyed to the BRIDGE rather than to this session: the
  // registry these readings come from is the machine's, and two sessions open in one
  // window are served by one read and one tail.
  const providerQuotas = useProviderQuotas(props.bridge);
  const queueFeed = useQueueFeed(props.bridge, props.sessionStore.sessionId);
  // The shelf's own question, asked of the session's one reading: the rows still
  // waiting. A row the daemon has stopped calling `queued` has left the shelf, and
  // the runs pane goes on showing it — two questions, one list, one subscription.
  const waitingItems = useMemo(() => waitingQueueRows(queueFeed.items), [queueFeed.items]);
  const clock = props.bridge.scenarioEngine?.clock ?? HOST_CLOCK;
  const address = useComposerAddress(props.sessionStore, props.focusedPane);
  const driverCapabilities = useDriverCapabilities(props.bridge);
  const addressedRun = address.target.path === "provider-bound" ? address.target : undefined;
  // Folded AFTER the address, because the address is one of its inputs: the boundary
  // this composer reports is the addressed run's own, and a composer addressed to a
  // channel asks for none.
  const addressedRunId = addressedRun?.targetRunId;
  const compactionBoundary = useMemo(
    () => newestCompactionBoundarySequence(timeline, addressedRunId),
    [timeline, addressedRunId],
  );

  return (
    <div className="meridian-composer__rail">
      <QueueShelf
        items={waitingItems}
        pendingCancelIds={queueFeed.pendingCancelIds}
        cancelRefusalByItemId={queueFeed.cancelRefusalByItemId}
        onCancel={queueFeed.cancelItem}
        unreadableDeliveryCount={queueFeed.unreadableDeliveryCount}
        unreadableRefusal={queueFeed.unreadableRefusal}
      />
      <div className="meridian-composer__accessories">
        <div className="meridian-composer__meters">
          <ContextMeterSlot
            contract={CONTEXT_METER_SLOT_CONTRACT}
            body={undefined}
            reading={contextReading}
          />
          <RateLimitSlot
            contract={RATE_LIMIT_SLOT_CONTRACT}
            body={undefined}
            readings={providerQuotas.readings}
            nowMilliseconds={clock.now()}
          />
          {/* Rendered rather than swallowed: a chip's absence is not a health
              reading, so a registry nobody could read must not look like a node
              whose quotas are all fine. */}
          {providerQuotas.readRefusal === undefined ? null : (
            <InlineRefusal
              code={providerQuotas.readRefusal.code}
              detail={providerQuotas.readRefusal.detail}
            />
          )}
          {addressedRun === undefined ? null : (
            <CompactionSlot
              contract={COMPACTION_SLOT_CONTRACT}
              body={undefined}
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
