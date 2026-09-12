// The browser settings carrier, driven without a DOM.
//
// The page's own suites assert what a person sees. This one asserts the ORDER two
// answers are allowed to install in, which a rendered surface can only show the last
// frame of: the defect it pins is a partition list read before a clear arriving after
// the read that followed it, and on screen that is a row that came back — with a byte
// figure, under a control that had just reported the data gone.
//
// THE READS ARE HELD RATHER THAN COUNTED. A stub that answered immediately has no
// moment at which a read is outstanding and an act settles, so a carrier that ordered
// nothing at all would look identical to this one. `holdsReads` is what makes the race
// reachable; releasing is what makes the verdict readable.

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

describe("the browser settings carrier — an act supersedes the reads before it", () => {
  it("discards a listing read before a clear, so the cleared row does not come back", async () => {
    // The defect. Both reads published on arrival, so the pre-clear listing — which
    // still holds the partition — could settle after the clear reported success, and
    // the row returned to the screen with its byte figure intact.
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true })],
      lists: [servedList([OPEN_PARTITION, CLEARED_PARTITION]), servedList([OPEN_PARTITION])],
      holdsReads: true,
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);
    expect(node.listCallCount).toBe(1);

    const cleared = await view.clearSiteData(CLEARED_PARTITION.sessionId);
    expect(cleared).toStrictEqual({ status: "done" });

    // The pre-clear listing arrives NOW, after the clear settled.
    await node.releaseReads();
    expect(partitionIdsOf(view.snapshot())).toBeUndefined();

    // And the re-read the clear asked for is the one that installs.
    await settleScheduledRead(bridge);
    await node.releaseReads();
    expect(node.listCallCount).toBe(2);
    expect(partitionIdsOf(view.snapshot())).toStrictEqual([OPEN_PARTITION.sessionId]);
  });

  it("discards a policy snapshot read before a write, so the old position does not return", async () => {
    const node = new SettingsNodeStub({
      policies: [
        servedPolicy({ "file-boundary": true, "page-tools": true }),
        servedPolicy({ "file-boundary": false, "page-tools": true }),
      ],
      lists: [servedList([])],
      holdsReads: true,
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);

    view.toggleSwitch("file-boundary", false);
    await settle();
    expect(node.writes).toStrictEqual([{ switchId: "file-boundary", enabled: false }]);

    // The stale snapshot — taken before the write — arrives after it.
    await node.releaseReads();
    expect(view.snapshot().policyReading.kind).toBe("reading");

    await settleScheduledRead(bridge);
    await node.releaseReads();
    expect(policyReadingsFrom(view.snapshot().policyReading)["file-boundary"]).toStrictEqual({
      kind: "served",
      enabled: false,
    });
  });

  it("negative control: with no act in between, a read installs exactly what it answered", async () => {
    // Without this the two cases above would pass over a carrier that discarded every
    // reply — which is a page that never renders anything the node said.
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true, "page-tools": false })],
      lists: [servedList([OPEN_PARTITION, CLEARED_PARTITION])],
      holdsReads: true,
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);
    await node.releaseReads();

    expect(partitionIdsOf(view.snapshot())).toStrictEqual([
      OPEN_PARTITION.sessionId,
      CLEARED_PARTITION.sessionId,
    ]);
    expect(policyReadingsFrom(view.snapshot().policyReading)["page-tools"]).toStrictEqual({
      kind: "served",
      enabled: false,
    });
  });

  it("installs both answers together or neither, so no frame mixes two rounds", async () => {
    // One key for two calls: the round that publishes is the round both answers came
    // from. A per-read key would let this snapshot carry the policy from before the
    // write beside the partitions from after it.
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true })],
      lists: [servedList([OPEN_PARTITION])],
      holdsReads: true,
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);
    expect(node.policyCallCount).toBe(1);
    expect(node.listCallCount).toBe(1);
    // Both calls are out and neither has answered, so nothing has moved.
    expect(view.snapshot().revision).toBe(0);

    await node.releaseReads();
    // One publish for the pair, not two.
    expect(view.snapshot().revision).toBe(1);
  });

  it("coalesces a burst of triggers into one read, through the console's one scheduler", async () => {
    // The other half of "no polling": four reasons can arrive in one window, and what
    // the scheduler owes is one read rather than four. Asserted here because a carrier
    // that reached past it would satisfy every ordering case above and still put a
    // call on the wire per focus event.
    const node = new SettingsNodeStub({
      policies: [servedPolicy({})],
      lists: [servedList([])],
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    view.requestRead("window-focus");
    view.requestRead("reconnect");
    view.requestRead("user-request");
    await settleScheduledRead(bridge);

    expect(node.listCallCount).toBe(1);
    expect(node.policyCallCount).toBe(1);
  });

  it("stops reading once disposed, and a reply landing after it installs nothing", async () => {
    const node = new SettingsNodeStub({
      policies: [servedPolicy({ "file-boundary": true })],
      lists: [servedList([OPEN_PARTITION])],
      holdsReads: true,
    });
    const { view, bridge } = carrierOver(node);

    view.start();
    await settleScheduledRead(bridge);
    view.dispose();
    await node.releaseReads();

    expect(view.snapshot().revision).toBe(0);
    view.requestRead("window-focus");
    await settleScheduledRead(bridge);
    expect(node.listCallCount).toBe(1);
  });
});
