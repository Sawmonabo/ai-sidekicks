// The reader, driven on frozen time against the real fixture bridge.
//
// The bridge is the shipped `createFixtureBridge` over the shipped approvals
// scenario, not a hand-made stand-in: the properties under test are about what
// happens when a CALL rejects, and a stand-in that resolved everything would let
// every refusal path pass without ever being taken.
//
// The clock is a `ManualClock`, which is also the audit instrument — a reader that
// armed a timer it never cancelled would leave `pendingCount` above zero after
// `dispose`, and that assertion is the idle-CPU budget's precondition checked
// rather than asserted.

import { describe, expect, it, vi } from "vitest";

import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenarios/composer.js";
import { ApprovalsReader } from "./approvals-reader.js";

function readerOver(bridge: ConsoleBridge): {
  readonly reader: ApprovalsReader;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock(0);
  const reader = new ApprovalsReader({ bridge, sessionId: "session-approvals", clock });
  return { reader, clock };
}

/** Fire the scheduler's trailing debounce and let the reads settle. */
async function settle(clock: ManualClock, reader: ApprovalsReader): Promise<void> {
  clock.advance(REFRESH_DEBOUNCE_MS);
  await vi.waitFor(() => {
    expect(reader.snapshot.approvals.status).not.toBe("loading");
  });
}

describe("the two reads", () => {
  it("starts not-checked, moves to loading on request, and answers", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    expect(reader.snapshot.approvals.status).toBe("not-checked");
    reader.requestRead("subscribe");
    expect(reader.snapshot.approvals.status).toBe("loading");
    await settle(clock, reader);
    const phase = reader.snapshot.approvals;
    expect(phase.status).toBe("answered");
    if (phase.status !== "answered") {
      throw new Error("the projection read did not answer");
    }
    // Every member of the five-state union, exactly once — the history rule's
    // fixture, and what makes "drops nothing" checkable rather than asserted.
    expect([...new Set(phase.rows.map((row) => row.state))].sort()).toStrictEqual([
      "approved",
      "canceled",
      "expired",
      "pending",
      "rejected",
    ]);
    expect(reader.snapshot.rules.status).toBe("answered");
  });

  it("does not read until the scheduler fires, so a burst costs one read", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    reader.requestRead("subscribe");
    reader.requestRead("terminal-event");
    reader.requestRead("window-focus");
    // Negative control on the debounce: before the deadline nothing has answered,
    // so the coalescing claim is about the scheduler rather than about luck.
    expect(reader.snapshot.approvals.status).toBe("loading");
    await settle(clock, reader);
    expect(reader.snapshot.approvals.status).toBe("answered");
  });

  it("renders a refusal when the scenario scripts no reply", async () => {
    // The composer scenario scripts neither approval read, so the fixture rejects
    // rather than resolving with nothing — which is what makes this arm reachable.
    const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    reader.requestRead("subscribe");
    await settle(clock, reader);
    const phase = reader.snapshot.approvals;
    expect(phase.status).toBe("refused");
    if (phase.status !== "refused") {
      throw new Error("an unscripted read did not refuse");
    }
    // The fixture's own refusal survives rather than being re-wrapped, so its
    // origin still names the subsystem that actually refused.
    expect(phase.refusal.origin).toBe("fixture-bridge");
    expect(phase.refusal.code).toBe("reply-unscripted");
  });
});

describe("answering a request", () => {
  it("marks exactly the answered record as resolving, and drops a repeat call", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    reader.requestRead("subscribe");
    await settle(clock, reader);

    reader.resolve({ approvalRequestId: "approval-03", decision: "approved" });
    expect([...reader.snapshot.resolvingApprovalIds]).toStrictEqual(["approval-03"]);
    // A second call for a record already in flight is dropped rather than sent —
    // one call per answer, and a double click is the ordinary way to send two.
    reader.resolve({ approvalRequestId: "approval-03", decision: "rejected" });
    expect([...reader.snapshot.resolvingApprovalIds]).toStrictEqual(["approval-03"]);

    await vi.waitFor(() => {
      expect(reader.snapshot.resolvingApprovalIds.size).toBe(0);
    });
    // Nothing settled the record locally: the reply confirms the request, and what
    // the record became is the next read's answer.
    expect(reader.snapshot.resolveRefusalByApprovalId.size).toBe(0);
  });

  it("keeps a rejection beside the record it belongs to", async () => {
    const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    reader.resolve({ approvalRequestId: "approval-99", decision: "approved" });
    await vi.waitFor(() => {
      expect(reader.snapshot.resolveRefusalByApprovalId.get("approval-99")).toBeDefined();
    });
    expect(reader.snapshot.resolvingApprovalIds.size).toBe(0);
    await settle(clock, reader);
  });

  it("revokes one rule and clears its in-flight mark", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    reader.revokeRule("rule-01");
    expect([...reader.snapshot.revokingRuleIds]).toStrictEqual(["rule-01"]);
    await vi.waitFor(() => {
      expect(reader.snapshot.revokingRuleIds.size).toBe(0);
    });
    await settle(clock, reader);
  });
});

describe("teardown", () => {
  it("leaves no timer armed, and a later request arms none", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    const { reader, clock } = readerOver(bridge);
    reader.requestRead("subscribe");
    await settle(clock, reader);
    reader.dispose();
    expect(clock.pendingCount).toBe(0);
    reader.requestRead("terminal-event");
    // Terminal: a late signal from a pane that unmounted cannot re-arm the reader.
    expect(clock.pendingCount).toBe(0);
  });
});
