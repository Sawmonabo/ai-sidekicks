// What the browser settings page's two answers look like once they have arrived.
//
// PURE MAPPINGS AND NOTHING ELSE. Every function here is a total function from what
// the growth port answered to the reading shape the page's own models declare: no
// clock, no bridge, no latch, no publish. The carrier next door owns WHEN a read
// happens and which of two answers is allowed to install; this module owns WHAT an
// answer means, and the split is what lets the mapping rules be driven directly
// rather than through a mounted page and a settled scheduler.
//
// A REFUSED SWITCH STILL RENDERS ITS ROW. `BrowserPolicySwitchReading` has exactly two
// arms, and {@link policyReadingsFrom} is TOTAL over the switch tuple, so a switch the
// node never answered for renders fail-closed with the refusal beside it rather than
// vanishing — which is the row's own stated contract and the reason its reading type
// has no third, absent arm.

import type { ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import {
  BROWSER_POLICY_SWITCHES,
  type BrowserPolicySwitchId,
  type BrowserPolicySwitchReading,
} from "./policy-switches.js";
import type { BrowserPartitionListing } from "./site-partitions.js";

/** The subsystem name a rejection that named no code of its own carries. */
export const BROWSER_SETTINGS_ORIGIN = "browser-settings";

/**
 * What the policy read has settled into.
 *
 * Its own union rather than the page's row shape, because the read answers for the
 * whole SET and a row answers for one switch: mapping the set onto the rows is what
 * {@link policyReadingsFrom} does, and holding the rows would mean holding two
 * switches' worth of the same refusal.
 */
export type BrowserPolicyReading =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly values: Readonly<Record<string, boolean>> }
  | { readonly kind: "refused"; readonly reading: BrowserPolicySwitchReading };

/**
 * One reading per switch, total over the closed tuple.
 *
 * Asserted directly rather than through a rendered page: driving it through the page
 * would test the row instead, and the claim here is that no switch in the tuple can
 * be missing a reading whatever the read said.
 */
export function policyReadingsFrom(
  reading: BrowserPolicyReading,
): Readonly<Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>> {
  const readings = {} as Record<BrowserPolicySwitchId, BrowserPolicySwitchReading>;
  for (const switchId of BROWSER_POLICY_SWITCHES) {
    readings[switchId] = switchReadingFor(reading, switchId);
  }
  return readings;
}

function switchReadingFor(
  reading: BrowserPolicyReading,
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

/** The refused arm, built once from whatever refused, so every call site agrees. */
export function refusedSwitchReading(refusal: ConsoleRefusal): BrowserPolicySwitchReading {
  return { kind: "refused", scope: "whole-answer", refusal };
}

/** The policy reading a call that REJECTED rather than answering settles into. */
export function policyReadingFromRejection(rejection: unknown): BrowserPolicyReading {
  return {
    kind: "refused",
    reading: refusedSwitchReading(consoleRefusalFrom(rejection, BROWSER_SETTINGS_ORIGIN)),
  };
}

/**
 * How one policy write settled, and whether the node's record may have moved anyway.
 *
 * THE THIRD ARM IS THE WHOLE REASON THIS IS A UNION. A write the node RETURNED a
 * refusal for is settled: it answered, and it answered no, so the position on screen
 * is still the position the record holds. A write whose call REJECTED answered
 * nothing — the request may have been applied and lost its reply, or never arrived at
 * all — and the two are indistinguishable from this side of the wire. Folding them
 * together left the refused sentence on screen beside a switch drawn at whichever
 * position the last read had, with nothing asking the node which one it is now.
 *
 * The reading each failing arm carries is the SAME shape, because what a person reads
 * is the refuser's own words either way. What differs is what the carrier does next,
 * which is why the disposition rides the arm rather than being re-derived from the
 * reading.
 */
export type PolicyWriteSettlement =
  | { readonly kind: "served" }
  | { readonly kind: "declined"; readonly reading: BrowserPolicyReading }
  | { readonly kind: "ambiguous"; readonly reading: BrowserPolicyReading };

/** A write the node took. */
export const SERVED_POLICY_WRITE: PolicyWriteSettlement = { kind: "served" };

/** A write the node ANSWERED and declined. Definite: nothing moved. */
export function declinedPolicyWrite(refusal: ConsoleRefusal): PolicyWriteSettlement {
  return { kind: "declined", reading: { kind: "refused", reading: refusedSwitchReading(refusal) } };
}

/**
 * A write whose call rejected. Ambiguous: the record may have moved regardless.
 *
 * Through {@link policyReadingFromRejection} — and so through the console's one
 * rejection normalizer — rather than a classification written here: what the thrown
 * value carries is the substrate's question, and a second reader of it in this family
 * would be a second vocabulary for one seam.
 */
export function ambiguousPolicyWrite(rejection: unknown): PolicyWriteSettlement {
  return { kind: "ambiguous", reading: policyReadingFromRejection(rejection) };
}

/**
 * The served partition list, as the page's own listing.
 *
 * A pure mapping and therefore a function of its own rather than an expression inside
 * the read: nothing here depends on the mount, and a projection written inline is a
 * projection nobody can drive on its own.
 */
export function partitionListingFrom(
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

/** The listing a refusal — whether returned or thrown — settles into. */
export function refusedPartitionListing(refusal: ConsoleRefusal): BrowserPartitionListing {
  return { kind: "refused", scope: "whole-answer", refusal };
}

/** The listing a call that REJECTED rather than answering settles into. */
export function partitionListingFromRejection(rejection: unknown): BrowserPartitionListing {
  return refusedPartitionListing(consoleRefusalFrom(rejection, BROWSER_SETTINGS_ORIGIN));
}

/** What an unmeasured partition says, in the words its own model demands. */
function unmeasuredSizeRefusal(sessionId: string): ConsoleRefusal {
  return {
    origin: BROWSER_SETTINGS_ORIGIN,
    code: "size-unmeasured",
    detail: `This node did not report how much it has stored for ${sessionId}. Nothing is claimed about the size, and a clear still runs.`,
  };
}
