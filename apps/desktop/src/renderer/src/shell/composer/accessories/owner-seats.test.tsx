// The rail's plan-owned seats: what they reserve, what they hand over, and what
// they never say out loud.
//
// ONE FILE FOR THREE MODULES, deliberately. `ContextMeterSlot`, `RateLimitSlot`, and
// `CompactionSlot` are three instances of ONE arrangement — a contract, a body, and
// a fixture shell behind it — and the claims worth a unit are claims about the
// arrangement rather than about any one seat. Three near-identical files would drift
// apart at the first edit, and the case that matters most below is a sweep across
// all of them.
//
// The three claims: the shell renders while nobody has filled the seat, the mounted
// body replaces it when someone has, and no member of any contract reaches the DOM.
// The last one is the one that rots silently — every member is developer-facing
// prose naming governance work, and the repository keeps that off a participant's
// screen — so it is asserted on rendered TEXT, which is what a future edit that
// rendered one would trip over.
//
// WHAT THIS FILE NO LONGER CLAIMS. Whether a contract answers all three facts, and
// whether any member's runtime string carries a governance identifier, are claims
// about every declaration in the tree. Asserted here they were asserted over a hand
// list of the four contracts this file happens to render, which left the two declared
// elsewhere unswept — and one of those carries a plan id beneath a doc comment saying
// it does not. `test/console/architecture/owner-slot-contracts.test.ts` resolves every
// `OwnerSlotContract` declaration through the parser and owns both. The rendering
// claim stays here, because it is the only place a render can be looked at.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleScenario } from "../../../console/bridge/scenario.js";
import type { OwnerSlotContract } from "../../../console/seats/index.js";
import { CompactionSlot, COMPACTION_SLOT_CONTRACT, type CompactionBody } from "./CompactionSlot.js";
import {
  ContextMeterSlot,
  CONTEXT_METER_SLOT_CONTRACT,
  type ContextMeterBody,
} from "./ContextMeterSlot.js";
import { EditResendSlot, EDIT_RESEND_SLOT_CONTRACT } from "./EditResendSlot.js";
import { RateLimitSlot, RATE_LIMIT_SLOT_CONTRACT, type RateLimitBody } from "./RateLimitSlot.js";
import type { ProviderQuotaReading } from "../../../console/bridge/index.js";
import type { ContextWindowReading } from "./usage-readings.js";

const SESSION_ID = "session-seats";
const RUN_ID = "run-seats";

const SEAT_SCENARIO: ConsoleScenario = {
  id: "seat-unit",
  label: "Seat unit",
  purpose: "A bridge for the compaction seat's mount; no beat and no reply are needed.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T00:00:00.000Z",
  beats: [],
  replies: [],
};

const CONTEXT_READING: ContextWindowReading = {
  usagePercent: 42,
  windowUsedTokens: 84_000,
  windowMaxTokens: 200_000,
  windowSource: "provider_reported",
  exceeded: false,
  sequence: 3,
};

const URGENT_RATE_READING: ProviderQuotaReading = {
  accountId: "account-primary",
  limitId: "weekly",
  accountLabel: "Primary",
  limitLabel: "Weekly",
  usedPercent: 93,
  resetsAt: undefined,
  observedAt: "2026-01-01T00:00:00.000Z",
  isStale: false,
};

/** The seats this file renders, with their contracts, so the sweep names them once. */
const RENDERED_SEAT_CONTRACTS: readonly OwnerSlotContract[] = [
  CONTEXT_METER_SLOT_CONTRACT,
  RATE_LIMIT_SLOT_CONTRACT,
  COMPACTION_SLOT_CONTRACT,
  EDIT_RESEND_SLOT_CONTRACT,
];

/** Every seat this file renders, in one tree, each with the body it was given. */
function seatsWith(
  bridge: ConsoleBridge,
  bodies: {
    readonly contextMeter?: ContextMeterBody;
    readonly rateLimit?: RateLimitBody;
    readonly compaction?: CompactionBody;
  } = {},
): HTMLElement {
  const { container } = render(
    <>
      <ContextMeterSlot
        contract={CONTEXT_METER_SLOT_CONTRACT}
        body={bodies.contextMeter}
        reading={CONTEXT_READING}
      />
      <RateLimitSlot
        contract={RATE_LIMIT_SLOT_CONTRACT}
        body={bodies.rateLimit}
        readings={[URGENT_RATE_READING]}
        nowMilliseconds={0}
      />
      <CompactionSlot
        contract={COMPACTION_SLOT_CONTRACT}
        body={bodies.compaction}
        bridge={bridge}
        sessionId={SESSION_ID}
        capability="declared"
        targetRunId={RUN_ID}
        completedBoundarySequence={undefined}
      />
      <EditResendSlot contract={EDIT_RESEND_SLOT_CONTRACT} body={undefined} />
    </>,
  );
  return container;
}

function bridgeForSeats(): ConsoleBridge {
  return createFixtureBridge({ scenario: SEAT_SCENARIO });
}

describe("the rail's owner seats reserve rather than author", () => {
  it("renders each seat's fixture shell while nobody has filled it", () => {
    const container = seatsWith(bridgeForSeats());
    expect(container.querySelector(".meridian-context-meter")).not.toBeNull();
    expect(container.querySelector(".meridian-rate-chips")).not.toBeNull();
    expect(container.querySelector(".meridian-compaction")).not.toBeNull();
  });

  it("renders the mounted body instead of the shell once one is supplied", () => {
    // The negative control is the code this replaces rather than a second case: the
    // rail used to render `ContextMeter`, `RateChips`, and `CompactionControl`
    // directly, so there was no seat to fill and no composition — this one included
    // — could have put another plan's body on the rail at all.
    const container = seatsWith(bridgeForSeats(), {
      contextMeter: () => <p className="mounted-meter">the owning plan&rsquo;s meter</p>,
      rateLimit: () => <p className="mounted-chips">the owning plan&rsquo;s indicator</p>,
      compaction: () => <p className="mounted-compaction">the owning plan&rsquo;s control</p>,
    });
    expect(container.querySelector(".mounted-meter")).not.toBeNull();
    expect(container.querySelector(".mounted-chips")).not.toBeNull();
    expect(container.querySelector(".mounted-compaction")).not.toBeNull();
    expect(container.querySelector(".meridian-context-meter")).toBeNull();
    expect(container.querySelector(".meridian-rate-chips")).toBeNull();
    expect(container.querySelector(".meridian-compaction")).toBeNull();
  });

  it("puts no contract member on screen, in either arm", () => {
    // Rendered text rather than markup: a future edit that dropped a member into an
    // attribute, a title, or a paragraph would read the same to a person, and this
    // is the assertion that fails when one does.
    const reserved = seatsWith(bridgeForSeats()).textContent ?? "";
    const mounted =
      seatsWith(bridgeForSeats(), {
        contextMeter: () => <p>the owning plan&rsquo;s meter</p>,
      }).textContent ?? "";
    for (const contract of RENDERED_SEAT_CONTRACTS) {
      for (const member of [
        contract.owningTask,
        contract.mountObligation,
        contract.deleteShellIn,
      ]) {
        expect(reserved).not.toContain(member);
        expect(mounted).not.toContain(member);
      }
    }
  });

  it("negative control: the sweep can see text the seats do render", () => {
    // Without this the case above would pass over a tree that rendered nothing at
    // all, which is exactly the failure a shell deleted too early would produce.
    expect(seatsWith(bridgeForSeats()).textContent ?? "").toContain("conversation");
  });
});
