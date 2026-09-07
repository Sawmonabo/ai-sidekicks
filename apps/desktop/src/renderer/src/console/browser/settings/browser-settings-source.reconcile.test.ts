// What an act that ANSWERED NOTHING costs, and what it does not.
//
// The suite beside this one asserts the ORDER two answers install in. This one asserts
// a different rule at the same seam: a refusal the node RETURNED is definite and asks
// nothing further, and a call that REJECTED is ambiguous — the clear may have run, the
// write may have landed — so it reconciles. Split from that file rather than appended to
// it because the two subjects share a stub and nothing else: one is about supersession
// and the other is about what a failure is evidence of.

import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "../../bridge/readings/scheduled-read.test-support.js";
import { settle } from "../../core/settle.test-support.js";
import { policyReadingsFrom } from "./browser-settings-readings.js";
import {
  carrierOver,
  partitionIdsOf,
  servedList,
  servedPolicy,
  SettingsNodeStub,
  CLEARED_PARTITION,
  OPEN_PARTITION,
} from "./browser-settings-node.test-support.js";

describe("the browser settings carrier — an act that answered nothing reconciles", () => {
  it("re-reads the listing when the clear rejected, and re-throws for the control", async () => {
    // THE DEFECT. A rejection says nothing about what the node did: the profile
    // directory may be gone and only the reply lost. Nothing re-read, so the removed
    // partition stayed on screen with its byte figure until a focus or a reconnect —
    // under a control whose own words say a re-read is what settles where it ended up.
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true })],
      lists: [servedList([OPEN_PARTITION, CLEARED_PARTITION]), servedList([OPEN_PARTITION])],
      clearDisposition: "rejects",
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);
    expect(node.listCallCount).toBe(1);

    // Re-thrown VERBATIM, so the control settles its own round naming the step it
    // reached rather than a refusal this carrier invented.
    await expect(view.clearSiteData(CLEARED_PARTITION.sessionId)).rejects.toThrow(
      "the call into the node never answered",
    );

    await settleScheduledRead(bridge);
    expect(node.listCallCount).toBe(2);
    expect(partitionIdsOf(view.snapshot())).toStrictEqual([OPEN_PARTITION.sessionId]);
  });

  // THE NEGATIVE CONTROL for that: a refusal the node RETURNED is definite — it
  // answered, and it answered no — so nothing is re-read. Without this the case above
  // would hold for a carrier that re-read after every failure, which is a read put to
  // confirm a state the node has just said it did not change.
  it("re-reads nothing when the clear was refused rather than rejected", async () => {
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true })],
      lists: [servedList([OPEN_PARTITION, CLEARED_PARTITION])],
      clearDisposition: "refused",
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);

    const outcome = await view.clearSiteData(CLEARED_PARTITION.sessionId);
    expect(outcome.status).toBe("refused");

    await settleScheduledRead(bridge);
    expect(node.listCallCount).toBe(1);
    expect(partitionIdsOf(view.snapshot())).toStrictEqual([
      OPEN_PARTITION.sessionId,
      CLEARED_PARTITION.sessionId,
    ]);
  });

  it("re-reads the policy when the write rejected, so the switch stops guessing", async () => {
    // The same ambiguity on the other act. The refusal is published — the person is
    // owed the seam's words — and the reconciliation that follows is what replaces the
    // position this window can no longer vouch for with the one the node holds.
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true }), servedPolicy({ "file-boundary": false })],
      lists: [servedList([])],
      writeDisposition: "rejects",
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);
    expect(node.policyCallCount).toBe(1);

    view.toggleSwitch("file-boundary", false);
    await settle();
    expect(view.snapshot().policyReading.kind).toBe("refused");

    await settleScheduledRead(bridge);
    expect(node.policyCallCount).toBe(2);
    expect(policyReadingsFrom(view.snapshot().policyReading)["file-boundary"]).toStrictEqual({
      kind: "served",
      enabled: false,
    });
  });

  // And its negative control: a write the node ANSWERED and declined leaves the sentence
  // standing and asks nothing further, because nothing moved.
  it("re-reads nothing when the write was refused, and leaves the refusal standing", async () => {
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true })],
      lists: [servedList([])],
      writeDisposition: "refused",
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);

    view.toggleSwitch("file-boundary", false);
    await settle();

    await settleScheduledRead(bridge);
    expect(node.policyCallCount).toBe(1);
    expect(view.snapshot().policyReading.kind).toBe("refused");
  });
});
