// The fold against the shipped store: the scenario's own beats.
//
// Its own file because these cases run the fold through the SHIPPED store rather
// than over it — the beats are the scenario's and the projection is the store's.

import { describe, expect, it } from "vitest";
import { APPROVAL_FLOW_EVENT_KINDS } from "@renderer/store/session-events/approval-flow-projection.js";
import { APPROVAL_REQUEST_SCENARIO } from "../../fixtures/scenarios/approval-request.js";
import {
  storeDrivenByScenario,
  storeOver,
} from "@renderer/store/session-events/approval-flow-projection.test-support.js";

describe("the scenario's approval beats, folded through the shipped store", () => {
  it("puts every request the beats name into the approval partition", () => {
    const partition = storeDrivenByScenario().snapshot().partitions.approval;
    const requestIds = APPROVAL_REQUEST_SCENARIO.beats
      .filter((beat) => APPROVAL_FLOW_EVENT_KINDS.includes(beat.event.kind))
      .map((beat) => beat.event.payload?.["approvalRequestId"])
      .filter((value): value is string => typeof value === "string");

    expect(requestIds.length).toBeGreaterThan(0);
    for (const requestId of requestIds) {
      expect(Object.hasOwn(partition, requestId)).toBe(true);
    }
    expect(storeDrivenByScenario().snapshot().degradedCause).toBeUndefined();
  });

  it("marks a settled request rather than dropping it", () => {
    const partition = storeDrivenByScenario().snapshot().partitions.approval;
    // The scenario approves one request and leaves three waiting. History is a read,
    // so the approval marks the row it already has.
    const states = Object.values(partition).map((entity) => entity.state);
    expect(states.filter((state) => state === "approved")).toHaveLength(1);
    expect(states.filter((state) => state === "pending")).toHaveLength(3);
  });

  it("keeps the ask origin the request carried", () => {
    const partition = storeDrivenByScenario().snapshot().partitions.approval;
    const withAsk = Object.values(partition).filter(
      (entity) => typeof entity.body?.["askId"] === "string",
    );
    // Exactly one of the scenario's requests arrived as a provider permission ask,
    // and the member reaches the console on that event and on no read.
    expect(withAsk).toHaveLength(1);
    expect(withAsk[0]?.body?.["expiryAt"]).toBe("2026-01-01T17:30:01.100Z");
  });

  it("negative control: a store opened without this family's projectors folds none of it", () => {
    // The state every approvals surface was built against: the beats reach the
    // timeline and the partition stays empty, so a pane joining a row to an entity
    // finds nothing however many approval events landed.
    const store = storeOver(undefined);
    expect(store.snapshot().timeline.length).toBeGreaterThan(0);
    expect(store.snapshot().partitions.approval).toStrictEqual({});
  });
});
