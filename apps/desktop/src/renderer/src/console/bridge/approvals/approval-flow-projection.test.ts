// The fold itself: the kinds it claims, the member tables it reads a payload
// through, and what one event does to the board.
//
// The claim is that nothing here sniffs. A kind this family does not claim is left
// alone, and a payload is read through the table its kind names rather than by
// looking for members that happen to be present.

import { describe, expect, it } from "vitest";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import {
  APPROVAL_BODY_MEMBER_TABLES,
  APPROVAL_FLOW_EVENT_KINDS,
  APPROVAL_FLOW_PROJECTORS,
  projectApprovalFlowEvent,
} from "./approval-flow-projection.js";
import { RUN_LIFECYCLE_EVENT_KINDS } from "../../frame/run-lifecycle-projector.js";
import { SESSION_ID, approvalEvent } from "./approval-flow-projection.test-support.js";

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
