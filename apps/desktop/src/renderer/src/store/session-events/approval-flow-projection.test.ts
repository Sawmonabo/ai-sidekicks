// The fold itself: the kinds it claims, and what one event does to the board.
//
// Every payload here is one the contract's schema for its kind accepts, except where a
// case's subject is a payload that schema refuses.

import { describe, expect, it } from "vitest";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import type { EntityMutation } from "../session/entities/entities.js";
import { APPROVAL_FLOW_EVENT_KINDS, APPROVAL_FLOW_PROJECTORS } from "./approval-flow-projection.js";
import { SESSION_ID, approvalEvent } from "./approval-flow-projection.test-support.js";

const RUN_ID = "019b7a33-3300-740e-8110-d1a4c1150511";
const APPROVAL_ID = "019b7a33-3300-7f01-8110-d1a4c1150591";
const AGENT_ID = "019b7a33-3300-7a6e-8110-d1a4c1150501";
const USER_ID = "019b7a33-3300-7b01-8110-d1a4c1150561";
const NODE_ID = "019b7a33-3300-7d01-8110-d1a4c1150571";
const RULE_ID = "019b7a33-3300-7e01-8110-d1a4c1150581";
const CLIENT_RESOLUTION_ID = "019b7a33-3300-7c01-8110-d1a4c1150531";

/** The members every ask payload of these cases shares. */
const ASK = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  approvalRequestId: APPROVAL_ID,
  category: "tool_execution",
  scope: "session",
};

const REQUESTED_PAYLOAD = {
  ...ASK,
  requestedBy: AGENT_ID,
  resourceDescriptor: { command: "git push --force" },
  askId: "ask-1",
};

/** Fold one event through the projector the table registers for its kind. */
function fold(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  actorId?: string,
): readonly EntityMutation[] {
  const projector = APPROVAL_FLOW_PROJECTORS[kind];
  if (projector === undefined) {
    throw new Error(`no projector is registered for ${kind}`);
  }
  return projector(
    approvalEvent({ kind, sequence: 1, payload, ...(actorId === undefined ? {} : { actorId }) }),
  );
}

describe("the kinds the composer feature claims", () => {
  it("is the approval_flow category minus the events that are not an ask's", () => {
    const categoryKinds = [...SESSION_EVENT_CATEGORY_BY_TYPE]
      .filter(([, category]) => category === "approval_flow")
      .map(([eventType]) => eventType);

    // Another kind landing in the category fails here rather than going unclaimed.
    expect(categoryKinds.filter((kind) => !APPROVAL_FLOW_EVENT_KINDS.includes(kind))).toStrictEqual(
      [
        "approval.reviewer_denied",
        "approval.denial_overridden",
        "moderation.review_flagged",
        "plan.proposed",
        "plan.accepted",
        "plan.handed_off",
      ],
    );
    expect(APPROVAL_FLOW_EVENT_KINDS).toContain("approval.requested");
  });
});

describe("one event, folded", () => {
  it("keys the ask on its id and carries the rest of the payload, the ask id included", () => {
    expect(fold("approval.requested", REQUESTED_PAYLOAD, AGENT_ID)).toStrictEqual([
      {
        operation: "upsert",
        entity: {
          kind: "approval",
          id: APPROVAL_ID,
          state: "pending",
          touchedAt: "2026-01-01T13:30:00.000Z",
          attributedTo: AGENT_ID,
          body: {
            runId: RUN_ID,
            category: "tool_execution",
            scope: "session",
            requestedBy: AGENT_ID,
            resourceDescriptor: { command: "git push --force" },
            askId: "ask-1",
          },
        },
      },
    ]);
  });

  it("marks an answer with its state and the answering client's id", () => {
    const [mutation] = fold("approval.approved", {
      ...ASK,
      approver: USER_ID,
      effectiveScope: "session",
      clientResolutionId: CLIENT_RESOLUTION_ID,
    });

    expect(mutation?.operation === "upsert" ? mutation.entity.state : undefined).toBe("approved");
    expect(mutation?.operation === "upsert" ? mutation.entity.body : undefined).toMatchObject({
      clientResolutionId: CLIENT_RESOLUTION_ID,
    });
  });

  it("writes no state for a remembered rule, and carries the rule whole", () => {
    // A remembered rule records what a resolution minted; it is not a second transition
    // of the ask, and a state written here would erase the approval in the store's merge.
    const [mutation] = fold("approval.remembered", {
      ...ASK,
      approver: USER_ID,
      nodeId: NODE_ID,
      ruleId: RULE_ID,
      rememberedScope: { kind: "project", pattern: "git push", sense: "allow" },
      madeAtLevel: "ask",
    });

    expect(mutation?.operation === "upsert" ? "state" in mutation.entity : true).toBe(false);
    expect(mutation?.operation === "upsert" ? mutation.entity.body : undefined).toMatchObject({
      rememberedScope: { kind: "project", pattern: "git push", sense: "allow" },
      madeAtLevel: "ask",
    });
  });

  it("folds nothing for a payload its kind's schema refuses", () => {
    // `approver` belongs to an answer, and a request carrying it is not a request the
    // contract registers: a half-read ask would draw a card for an action nobody can see.
    expect(fold("approval.requested", { ...REQUESTED_PAYLOAD, approver: USER_ID })).toStrictEqual(
      [],
    );
    expect(fold("approval.requested", { ...REQUESTED_PAYLOAD, askId: 7 })).toStrictEqual([]);
  });

  it("folds nothing for a payload naming another session", () => {
    expect(
      fold("approval.requested", {
        ...REQUESTED_PAYLOAD,
        sessionId: "019b7a33-3300-7001-8110-d1a4c11505ff",
      }),
    ).toStrictEqual([]);
  });

  it("folds nothing for a revocation that names no ask", () => {
    // A project detached or a server's trust withdrawn ends a rule with no ask in flight,
    // so there is no approval entity to key on.
    const {
      runId: _runId,
      approvalRequestId: _approvalRequestId,
      ...revocation
    } = {
      ...ASK,
      ruleId: RULE_ID,
      invalidationTrigger: "project_detached",
    };
    expect(fold("approval.rule_revoked", revocation)).toStrictEqual([]);
  });

  it("negative control: the same revocation naming its ask does fold", () => {
    expect(
      fold("approval.rule_revoked", { ...ASK, ruleId: RULE_ID, invalidationTrigger: "explicit" }),
    ).toHaveLength(1);
  });
});
