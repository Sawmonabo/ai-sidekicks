// Where the browser settings page's two answers come from, and what each one is
// before it has one.
//
// The page next door is a PROJECTION — it fetches nothing, holds no store and runs no
// effect, which is what keeps it renderable in a test, a screenshot tier and an
// auxiliary window without a second code path. This module is the other half: the two
// reads that feed it, and the mapping from what the growth port answers into the two
// reading shapes the page's own models declare.
//
// BOTH READS GO THROUGH THE GROWTH PORT AND BOTH REFUSE TODAY. Neither the node's
// browser policy nor its site-data partitions is a wire the corpus registers, so both
// ride the growth port's browser rows and the refusal a person reads is the port's
// own, citing the slate row that owes the wire. Nothing here composes a method string,
// and no scenario answers either read — the fixture serves an operation when a
// scenario states something it can be answered FROM, and a scenario states nothing
// about a node's stored bytes.
//
// THE READS ARE TRIGGERED, NOT POLLED. Both are node-wide rather than session-scoped,
// so they take the window's two triggers — the mount and the window regaining focus —
// through `store/read-triggers.ts`, which is the console's one home for that wiring.
// No interval, and no re-read on an unrelated render.
//
// A REFUSED SWITCH STILL RENDERS ITS ROW. `BrowserPolicySwitchReading` has exactly two
// arms, and the map below is TOTAL over the switch tuple, so a switch the node never
// answered for renders fail-closed with the refusal beside it rather than vanishing —
// which is the row's own stated contract and the reason its reading type has no
// third, absent arm.

import { useCallback, useMemo } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "../../store/index.js";
import {
  BROWSER_POLICY_SWITCHES,
  type BrowserPolicySwitchId,
  type BrowserPolicySwitchReading,
} from "./policy-switches.js";
import type { BrowserPartitionListing } from "./site-partitions.js";
import type { SiteDataActOutcome } from "./site-data-clear.js";

/** The subsystem name a rejection that named no code of its own carries. */
const BROWSER_SETTINGS_ORIGIN = "browser-settings";

/** Everything the page is handed, composed from the two reads. */
export interface BrowserSettingsSource {
  readonly switchReadings: Readonly<Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>>;
  readonly toggleSwitch: (switchId: BrowserPolicySwitchId, nextEnabled: boolean) => void;
  readonly partitions: BrowserPartitionListing;
  readonly clearSiteData: (sessionId: string) => Promise<SiteDataActOutcome>;
}

/**
 * What the policy read has settled into.
 *
 * Its own union rather than the page's row shape, because the read answers for the
 * whole SET and a row answers for one switch: mapping the set onto the rows is what
 * `policyReadingsFrom` does, and holding the rows would mean holding two switches'
 * worth of the same refusal.
 */
type PolicyReading =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly values: Readonly<Record<string, boolean>> }
  | { readonly kind: "refused"; readonly reading: BrowserPolicySwitchReading };

/**
 * Bind the browser settings page's two reads to one bridge.
 *
 * Held against the TRANSPORT through the console's subject-scoped holder, so a
 * scenario swap re-seeds both readings in the render that first sees the new bridge
 * rather than one committed frame later — the frame that would otherwise paint one
 * node's policy under another node's name.
 */
export function useBrowserSettingsSource(bridge: ConsoleBridge): BrowserSettingsSource {
  const { value: policyReading, publish: publishPolicyReading } =
    useSubjectScopedState<PolicyReading>(bridge, undefined, () => ({ kind: "reading" }));
  const { value: partitions, publish: publishPartitions } =
    useSubjectScopedState<BrowserPartitionListing>(bridge, undefined, () => ({ kind: "reading" }));

  const readTarget = useMemo<ReadTriggerTarget>(
    () => ({
      // Empty, and the emptiness is the claim: both answers are the NODE's rather than
      // a session's, so nothing in any session's timeline tells this reading that the
      // node's policy or its stored bytes moved.
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: () => {
        void bridge.growth.browserPolicyRead({}).then(
          (outcome) => {
            publishPolicyReading(
              outcome.status === "served"
                ? { kind: "read", values: outcome.value }
                : { kind: "refused", reading: refusedSwitchReading(outcome) },
            );
          },
          (rejection: unknown) => {
            publishPolicyReading({
              kind: "refused",
              reading: refusedSwitchReading(consoleRefusalFrom(rejection, BROWSER_SETTINGS_ORIGIN)),
            });
          },
        );
        void bridge.growth.browserSiteDataList({}).then(
          (outcome) => {
            publishPartitions(
              outcome.status === "served"
                ? partitionListingFrom(outcome.value)
                : { kind: "refused", scope: "whole-answer", refusal: outcome },
            );
          },
          (rejection: unknown) => {
            publishPartitions({
              kind: "refused",
              scope: "whole-answer",
              refusal: consoleRefusalFrom(rejection, BROWSER_SETTINGS_ORIGIN),
            });
          },
        );
      },
    }),
    [bridge, publishPolicyReading, publishPartitions],
  );
  useWindowReadTriggers(readTarget);

  const toggleSwitch = useCallback(
    (switchId: BrowserPolicySwitchId, nextEnabled: boolean): void => {
      void bridge.growth.browserPolicyWrite({ switchId, enabled: nextEnabled }).then(
        (outcome) => {
          if (outcome.status !== "served") {
            publishPolicyReading({ kind: "refused", reading: refusedSwitchReading(outcome) });
            return;
          }
          // Re-read rather than patched locally: the node owns the record, and a page
          // holding its own edited copy is a second version of it nothing reconciles.
          readTarget.requestRead("terminal-event");
        },
        (rejection: unknown) => {
          publishPolicyReading({
            kind: "refused",
            reading: refusedSwitchReading(consoleRefusalFrom(rejection, BROWSER_SETTINGS_ORIGIN)),
          });
        },
      );
    },
    [bridge, publishPolicyReading, readTarget],
  );

  // The act itself is a module-level function and this only forwards to it: the
  // session a clear names arrives per CALL from the row the person pressed, so nothing
  // about it belongs to this mount. Written inline, the closure would read as a cell
  // holding a session — which is exactly the shape the console has one holder for.
  const clearSiteData = useCallback(
    (clearedPartitionId: string): Promise<SiteDataActOutcome> =>
      clearPartitionThrough(bridge, readTarget, clearedPartitionId),
    [bridge, readTarget],
  );

  return {
    switchReadings: policyReadingsFrom(policyReading),
    toggleSwitch,
    partitions,
    clearSiteData,
  };
}

/**
 * One reading per switch, total over the closed tuple.
 *
 * Exported because it is the whole of the mapping rule and is asserted directly:
 * driving it through a rendered page would test the row instead, and the claim here
 * is that no switch in the tuple can be missing a reading whatever the read said.
 */
export function policyReadingsFrom(
  reading: PolicyReading,
): Readonly<Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>> {
  const readings = {} as Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>;
  for (const switchId of BROWSER_POLICY_SWITCHES) {
    readings[switchId] = switchReadingFor(reading, switchId);
  }
  return readings;
}

function switchReadingFor(
  reading: PolicyReading,
  switchId: BrowserPolicySwitchId,
): BrowserPolicySwitchReading {
  if (reading.kind === "refused") {
    return reading.reading;
  }
  const value = reading.kind === "read" ? reading.values[switchId] : undefined;
  if (value === undefined) {
    // A read that came back without this switch in it, and a read still in flight,
    // are both "nobody has answered for this switch" — so the row draws the safe
    // position and says the answer is missing rather than implying an off.
    return {
      kind: "refused",
      scope: "whole-answer",
      refusal: {
        origin: BROWSER_SETTINGS_ORIGIN,
        code: "switch-unanswered",
        detail: `This node has not reported a position for “${switchId}”. The switch renders the enforced position until it does.`,
      },
    };
  }
  return { kind: "served", enabled: value };
}

/** The refused arm, built once from whatever refused, so both call sites agree. */
function refusedSwitchReading(refusal: {
  readonly origin: string;
  readonly code: string;
  readonly detail: string;
}): BrowserPolicySwitchReading {
  return { kind: "refused", scope: "whole-answer", refusal };
}

/**
 * The served partition list, as the page's own listing.
 *
 * A pure mapping and therefore a module-level function rather than an expression
 * inside the read's memo: nothing here depends on the mount, and a memo body holding
 * a projection is a projection nobody can drive on its own.
 */
function partitionListingFrom(
  served: readonly {
    readonly sessionId: string;
    readonly sessionTitle: string;
    readonly storedByteLength?: number | undefined;
    readonly hasOpenPane: boolean;
  }[],
): BrowserPartitionListing {
  return {
    kind: "served",
    partitions: served.map((partition) => ({
      sessionId: partition.sessionId,
      sessionTitle: partition.sessionTitle,
      size:
        partition.storedByteLength === undefined
          ? {
              kind: "refused",
              scope: "whole-answer",
              refusal: unmeasuredSizeRefusal(partition.sessionId),
            }
          : { kind: "served", byteLength: partition.storedByteLength },
      hasOpenPane: partition.hasOpenPane,
    })),
  };
}

/**
 * Clear one partition, then ask the listing to re-read.
 *
 * The re-read is the point of doing this here rather than at the button: a clear that
 * reported success and left the old byte figure on screen would be telling a person
 * their data is gone while showing them how much of it there is.
 */
async function clearPartitionThrough(
  bridge: ConsoleBridge,
  readTarget: ReadTriggerTarget,
  clearedPartitionId: string,
): Promise<SiteDataActOutcome> {
  const outcome = await bridge.growth.browserSiteDataClear({ sessionId: clearedPartitionId });
  if (outcome.status !== "served") {
    return { status: "refused", refusal: outcome };
  }
  readTarget.requestRead("terminal-event");
  return { status: "done" };
}

/** What an unmeasured partition says, in the words its own model demands. */
function unmeasuredSizeRefusal(sessionId: string): {
  readonly origin: string;
  readonly code: string;
  readonly detail: string;
} {
  return {
    origin: BROWSER_SETTINGS_ORIGIN,
    code: "size-unmeasured",
    detail: `This node did not report how much it has stored for ${sessionId}. Nothing is claimed about the size, and a clear still runs.`,
  };
}
