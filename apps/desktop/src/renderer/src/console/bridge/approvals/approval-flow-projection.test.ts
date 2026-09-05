// The `approval` partition, driven by the real scenario through the real store.
//
// Four claims, and every one of them failed before this projector existed:
//
//   • The kinds it claims ARE the taxonomy's `approval_flow` category minus the one
//     event in it that is not an approval request's — not a list written beside the
//     census that an eighth approval event would silently leave out, and not the
//     whole category either, which would take `moderation.review_flagged` off the
//     board for the family that renders moderation.
//   • The scenario's approval beats reach the `approval` partition through the
//     shipped apply chokepoint. A real scenario and a real `SessionStore`: a local
//     stand-in for either would be checking this file's own copy of the thing under
//     test.
//   • The body carries the members the corpus registers PER TYPE, so `askId` — which
//     is on the event and on no read — survives the request that carried it and is
//     still there when the pane asks.
//   • The fold KEEPS what an earlier event named. `approval.requested` is the only
//     kind that carries `askId`, so a fold that replaced the body wholesale would
//     lose the ask origin on the very next transition — visible to nobody, because a
//     resolved provider ask renders exactly like a resolved direct request.

import { describe, expect, it } from "vitest";

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";

import {
  APPROVAL_BODY_MEMBER_TABLES,
  APPROVAL_FLOW_EVENT_KINDS,
  APPROVAL_FLOW_PROJECTORS,
  projectApprovalFlowEvent,
} from "./approval-flow-projection.js";
import { APPROVALS_SCENARIO } from "../scenarios/approvals.js";
import { RUN_LIFECYCLE_EVENT_KINDS } from "../../frame/run-lifecycle-projector.js";
import {
  ConsoleEntityProjectorRegistry,
  SessionStore,
  type ConsoleSessionEvent,
  type EntityProjectorRegistry,
} from "../../store/index.js";
import { registerComposerFamily } from "../../../shell/index.js";

const SESSION_ID = APPROVALS_SCENARIO.sessionId;

/** One store, opened with exactly what the composer family registers. */
function storeDrivenByScenario(): SessionStore {
  return storeOver(APPROVAL_FLOW_PROJECTORS);
}

/** One store fed the scenario's whole log, folding with whatever it was opened with. */
function storeOver(projectors: EntityProjectorRegistry | undefined): SessionStore {
  const sequences = APPROVALS_SCENARIO.beats.map((beat) => beat.event.sequence);
  const store = new SessionStore({
    sessionId: SESSION_ID,
    ...(projectors === undefined ? {} : { projectors }),
  });
  // A base state current as of the beat just before the scenario's first: a store
  // treats the distance from its cursor to an event as a gap, so a cursor of `-1`
  // would degrade a store for a hole the scenario never had.
  store.initialise({
    cursor: Math.min(...sequences) - 1,
    entities: [],
    participantJoinLog: [...APPROVALS_SCENARIO.participantIdsInJoinOrder],
  });
  store.applyBatch(APPROVALS_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent));
  return store;
}

/** One hand-built beat, for the payload shapes no scenario has a reason to play. */
function approvalEvent(options: {
  readonly kind: string;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>> | undefined;
  readonly actorId?: string;
}): ConsoleSessionEvent {
  return {
    id: `event-${String(options.sequence)}`,
    sessionId: SESSION_ID,
    sequence: options.sequence,
    kind: options.kind,
    occurredAt: "2026-01-01T13:30:00.000Z",
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  };
}

describe("the kinds the composer family claims", () => {
  it("is the approval_flow category minus the one event that is not a request's", () => {
    const categoryKinds = [...SESSION_EVENT_CATEGORY_BY_TYPE]
      .filter(([, category]) => category === "approval_flow")
      .map(([eventType]) => eventType);

    // The subtraction is held to exactly one member. A ninth kind landing in the
    // category under some other namespace fails here rather than being dropped by a
    // prefix filter nobody re-read.
    expect(categoryKinds.filter((kind) => !APPROVAL_FLOW_EVENT_KINDS.includes(kind))).toStrictEqual(
      ["moderation.review_flagged"],
    );
    expect(APPROVAL_FLOW_EVENT_KINDS).toHaveLength(7);
    expect(Object.keys(APPROVAL_FLOW_PROJECTORS).toSorted()).toStrictEqual(
      [...APPROVAL_FLOW_EVENT_KINDS].toSorted(),
    );
  });

  it("claims nothing the run projector claims", () => {
    // Two owners on one kind is refused by the registry, so this is not about
    // whether the console would notice — it is about noticing here, named by kind,
    // rather than as an import-time throw in a running window.
    for (const eventKind of APPROVAL_FLOW_EVENT_KINDS) {
      expect(RUN_LIFECYCLE_EVENT_KINDS).not.toContain(eventKind);
    }
  });

  it("negative control: the census carries approval kinds this list could have missed", () => {
    // Without it, both cases above would pass over a census filter that answered
    // nothing at all — an empty claimed set is trivially disjoint from every other.
    expect(APPROVAL_FLOW_EVENT_KINDS).toContain("approval.requested");
    expect(APPROVAL_FLOW_EVENT_KINDS).toContain("approval.rule_revoked");
  });
});

describe("the member tables the fold reads a payload through", () => {
  it("spells no member twice", () => {
    // One member in both tables would be read twice and registered once — and the
    // per-type table's whole claim is that a member belongs to the kind that
    // registers it and to no other.
    const shared = Object.keys(APPROVAL_BODY_MEMBER_TABLES.shared);
    for (const [eventKind, members] of Object.entries(APPROVAL_BODY_MEMBER_TABLES.byEventKind)) {
      for (const member of Object.keys(members)) {
        expect({ eventKind, member, alsoShared: shared.includes(member) }).toStrictEqual({
          eventKind,
          member,
          alsoShared: false,
        });
      }
    }
  });

  it("names neither the envelope's session nor the entity's own id", () => {
    // Both are registered members of the payload and neither may reach the body:
    // the session is checked against the envelope rather than carried, and the
    // request id IS the entity's key. Either on the body would be a second spelling
    // of something the entity already holds.
    const everyMember = [
      ...Object.keys(APPROVAL_BODY_MEMBER_TABLES.shared),
      ...Object.values(APPROVAL_BODY_MEMBER_TABLES.byEventKind).flatMap((members) =>
        Object.keys(members),
      ),
    ];
    expect(everyMember).not.toContain("sessionId");
    expect(everyMember).not.toContain("approvalRequestId");
  });

  it("covers every claimed kind", () => {
    for (const eventKind of APPROVAL_FLOW_EVENT_KINDS) {
      expect(Object.hasOwn(APPROVAL_BODY_MEMBER_TABLES.byEventKind, eventKind)).toBe(true);
    }
  });
});

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

describe("one event, folded", () => {
  it("carries the request quad and the ask pair off a requested beat", () => {
    const [mutation] = projectApprovalFlowEvent(
      approvalEvent({
        kind: "approval.requested",
        sequence: 1,
        actorId: "agent-implementer",
        payload: {
          sessionId: SESSION_ID,
          runId: "run-1",
          approvalRequestId: "approval-1",
          askId: "ask-1",
          category: "tool_execution",
          scope: "run",
          requestedBy: "agent-implementer",
          resourceDescriptor: { command: "git push --force" },
          expiryAt: "2026-01-01T17:30:00.000Z",
        },
      }),
    );

    expect(mutation).toStrictEqual({
      operation: "upsert",
      entity: {
        kind: "approval",
        id: "approval-1",
        state: "pending",
        touchedAt: "2026-01-01T13:30:00.000Z",
        attributedTo: "agent-implementer",
        body: {
          category: "tool_execution",
          scope: "run",
          runId: "run-1",
          requestedBy: "agent-implementer",
          resourceDescriptor: { command: "git push --force" },
          askId: "ask-1",
          expiryAt: "2026-01-01T17:30:00.000Z",
        },
      },
    });
  });

  it("reads a member off the kind that registers it and off no other", () => {
    // `approver` is a resolution's member. A requested beat spelling it is a beat
    // this build does not read that member off, because nothing registers it there.
    const [mutation] = projectApprovalFlowEvent(
      approvalEvent({
        kind: "approval.requested",
        sequence: 2,
        payload: {
          sessionId: SESSION_ID,
          approvalRequestId: "approval-2",
          category: "file_write",
          scope: "session",
          approver: "participant-you",
        },
      }),
    );

    expect(mutation?.operation).toBe("upsert");
    const body = mutation?.operation === "upsert" ? mutation.entity.body : undefined;
    expect(body).toStrictEqual({ category: "file_write", scope: "session" });
  });

  it("reads a wrong-typed member as absent rather than as itself", () => {
    const [mutation] = projectApprovalFlowEvent(
      approvalEvent({
        kind: "approval.requested",
        sequence: 3,
        payload: {
          sessionId: SESSION_ID,
          approvalRequestId: "approval-3",
          category: "file_write",
          scope: "session",
          // A number where a string belongs, and an empty string, both of which look
          // exactly as confident as the real thing once rendered.
          askId: 7,
          expiryAt: "",
        },
      }),
    );

    const body = mutation?.operation === "upsert" ? mutation.entity.body : undefined;
    expect(body).toStrictEqual({ category: "file_write", scope: "session" });
  });

  it("writes no state for a kind that announces none", () => {
    // A remembered rule records that a resolution minted a standing grant; it is not
    // a second transition of the request, and a state written here would restate one
    // transition as two.
    const [mutation] = projectApprovalFlowEvent(
      approvalEvent({
        kind: "approval.remembered",
        sequence: 4,
        payload: {
          sessionId: SESSION_ID,
          approvalRequestId: "approval-4",
          category: "tool_execution",
          scope: "run",
          approver: "participant-you",
          nodeId: "workstation-local",
          rememberedScope: { kind: "run" },
          ruleId: "rule-1",
        },
      }),
    );

    expect(mutation?.operation === "upsert" ? "state" in mutation.entity : true).toBe(false);
  });

  it("answers with nothing for a payload naming another session", () => {
    expect(
      projectApprovalFlowEvent({
        id: "event-cross",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "approval.requested",
        occurredAt: "2026-01-01T13:30:00.000Z",
        payload: {
          sessionId: "session-somewhere-else",
          approvalRequestId: "approval-5",
          category: "file_write",
          scope: "session",
        },
      }),
    ).toStrictEqual([]);
  });

  it("answers with nothing for a revocation that names no request", () => {
    // A trust-triggered revocation carries no in-flight request, so it names no
    // approval entity to key on. The event is still admitted; the timeline is the
    // ledger that records it arrived.
    expect(
      projectApprovalFlowEvent(
        approvalEvent({
          kind: "approval.rule_revoked",
          sequence: 6,
          payload: {
            sessionId: SESSION_ID,
            category: "network_access",
            scope: "session",
            ruleId: "rule-2",
            invalidationTrigger: "membership_change",
          },
        }),
      ),
    ).toStrictEqual([]);
  });

  it("negative control: the same beat with a request id does fold", () => {
    // Without it, the two cases above would pass over a projector that answered
    // nothing for everything.
    expect(
      projectApprovalFlowEvent(
        approvalEvent({
          kind: "approval.rule_revoked",
          sequence: 7,
          payload: {
            sessionId: SESSION_ID,
            approvalRequestId: "approval-7",
            category: "network_access",
            scope: "session",
            ruleId: "rule-2",
            invalidationTrigger: "explicit",
          },
        }),
      ),
    ).toHaveLength(1);
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
