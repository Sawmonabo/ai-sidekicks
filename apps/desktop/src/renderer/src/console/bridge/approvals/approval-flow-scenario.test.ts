// The fold against the shipped store: the scenario's own beats, and what the family
// may claim on a board it is handed.
//
// Its own file because these cases run the fold through the SHIPPED store rather
// than over it — the beats are the scenario's, the projection is the store's, and
// what is asserted is the board a family is handed rather than the fold in isolation.

import { describe, expect, it } from "vitest";
import { APPROVAL_FLOW_EVENT_KINDS } from "./approval-flow-projection.js";
import { APPROVALS_SCENARIO } from "../scenarios/approvals.js";
import { RUN_LIFECYCLE_EVENT_KINDS } from "../../frame/run-lifecycle-projector.js";
import { ConsoleEntityProjectorRegistry } from "../../store/index.js";
import { registerComposerFamily } from "../../../shell/index.js";
import { storeDrivenByScenario, storeOver } from "./approval-flow-projection.test-support.js";

describe("the scenario's approval beats, folded through the shipped store", () => {
  it("puts every request the beats name into the approval partition", () => {
    const partition = storeDrivenByScenario().snapshot().partitions.approval;
    const requestIds = APPROVALS_SCENARIO.beats
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
    // The scenario requests one approval and then expires it. History is a read, so
    // the expiry marks the row it already has.
    const expired = Object.values(partition).filter((entity) => entity.state === "expired");
    expect(expired).toHaveLength(1);
    expect(Object.values(partition).some((entity) => entity.state === "approved")).toBe(true);
    expect(Object.values(partition).some((entity) => entity.state === "pending")).toBe(true);
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

describe("the composer family's claim on the board it is handed", () => {
  it("registers exactly the approval kinds, under its own name", () => {
    const projectors = new ConsoleEntityProjectorRegistry();

    registerComposerFamily(projectors);

    expect(Object.keys(projectors.snapshot()).toSorted()).toStrictEqual(
      [...APPROVAL_FLOW_EVENT_KINDS].toSorted(),
    );
    for (const eventKind of APPROVAL_FLOW_EVENT_KINDS) {
      expect(projectors.ownerOf(eventKind)).toBe("composer");
    }
  });

  it("claims none of the run kinds the frame owns", () => {
    // The registry refuses a second owner on one kind, so a family that reached one
    // kind too far would break the whole composition at import time in a running
    // window. Named here, by kind, instead.
    const projectors = new ConsoleEntityProjectorRegistry();

    registerComposerFamily(projectors);

    for (const eventKind of RUN_LIFECYCLE_EVENT_KINDS) {
      expect(projectors.ownerOf(eventKind)).toBeUndefined();
    }
  });

  it("negative control: a board no family composed into claims nothing", () => {
    // Without it the two cases above would pass over a registry that reported
    // ownership nobody registered.
    expect(new ConsoleEntityProjectorRegistry().snapshot()).toStrictEqual({});
  });
});
