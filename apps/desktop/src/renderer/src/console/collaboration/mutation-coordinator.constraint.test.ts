// Which methods a collaboration mutation may name, and where that answer comes from.
//
// A SUITE OF ITS OWN BESIDE `mutation-coordinator.test.ts` because it is a different
// subject: that file holds the single-flight rule and the keyed refusal, and this one
// holds the CONSTRAINT — that the family derives its method set from the store's
// authoritative mutating tuple intersected with the call door's registry, and declares
// no set of its own.
//
// THE DEFECT THIS EXISTS FOR IS A SECOND DECLARATION. The constraint was a literal
// union written at the coordinator, which made two closed declarations of which
// methods are writes: the store's tuple, held to the daemon's own `mutating: true`
// registrations by a gate, and a union in this family that nothing held to anything.
// They could disagree about whether a verb is a write, and adding a collaboration
// mutation meant editing the classification twice.
//
// THE TYPE CANNOT BE ENUMERATED AT RUN TIME, so the two halves are asserted in the two
// places they live: the members are written out once here and BOUND to the type by
// `satisfies`, so a member the constraint stops admitting fails to compile; and the
// partition case asks the authoritative tuple what that list is missing, so a member
// the constraint starts admitting fails at run time. Neither half holds alone.
//
// THE PARTITION IS AN IDENTITY TODAY, WHICH IT DID NOT USED TO BE. It named two writes
// the registry bound no schema for, and neither survives: `driver.applyIntervention` was
// on the roster naming a method this console binds nowhere and cannot call, and it was
// struck; `driver.respondToRequest` is bound. The registry's own suite now holds the
// roster and its record set equal in BOTH directions, so the intersection's registry
// half subtracts nothing — and the half of the constraint that still has teeth is the
// type-level refusal below, which refuses a READ the registry does bind.

import { describe, expect, it } from "vitest";

import { DAEMON_REPLY_REFUSAL_ORIGIN, heldIdAsWireId, type DaemonReply } from "../bridge/index.js";
import { refuse } from "../core/index.js";
import { MUTATING_DAEMON_METHODS } from "../store/index.js";
import type { CollaborationMutation, CollaborationMutationMethod } from "./mutation-coordinator.js";

/**
 * Every method the constraint admits, each one held to it by `satisfies`.
 *
 * Written out rather than derived, because a type has no run-time enumeration — and
 * bound to the type rather than left as a comment, so this list cannot drift from the
 * constraint in the direction a test can be blind to. The other direction is the
 * partition case below.
 */
const ADMITTED_METHODS = [
  "run.queueCreate",
  "run.queueCancel",
  "run.pause",
  "run.resume",
  "run.intervene",
  "driver.interruptRun",
  "driver.compactContext",
  "driver.respondToRequest",
  "repo.attach",
  "repo.workspaceBind",
  "repo.executionModeSelect",
  "repo.executionRootPrepare",
  "repo.ephemeralClonePrepare",
  "repo.ephemeralCloneDispose",
  "repo.worktreeRetire",
  "session.create",
  "session.join",
  "membership.update",
  "invite.create",
  "invite.revoke",
  "providerAccount.probe",
] as const satisfies readonly CollaborationMutationMethod[];

/** A session id and an invite id the wire's branded scalars accept. */
const SESSION_ID = "019b7920-0000-7000-8000-000000000001";
const INVITE_ID = "019b7920-0001-7000-8000-000000000001";

describe("the collaboration mutation constraint", () => {
  it("admits exactly the mutating methods the call door binds", () => {
    // The partition: what the constraint admits, plus the writes the registry does not
    // bind, is the authoritative tuple exactly. A verb added to that tuple fails here
    // until it is classified, which is the whole point of deriving rather than
    // declaring.
    expect([...ADMITTED_METHODS].toSorted()).toStrictEqual([...MUTATING_DAEMON_METHODS].toSorted());
  });

  it("admits no read, which is what the identity above rests on — the control", () => {
    // Without this the partition would hold just as well for a roster that had let a
    // read in: the two lists would still be equal, and every read on it would become a
    // collaboration mutation. The roster's own suite next door holds that line from the
    // registry's side; this is the collaboration family asserting it depends on it.
    expect(MUTATING_DAEMON_METHODS.length).toBeGreaterThan(0);
    expect([...MUTATING_DAEMON_METHODS] as readonly string[]).not.toContain("session.read");
  });

  it("names the three verbs this family dispatches", () => {
    // The floor under both cases above: a constraint that admitted none of the
    // family's own methods would still satisfy a partition over the empty set.
    expect([...ADMITTED_METHODS] as readonly string[]).toContain("invite.create");
    expect([...ADMITTED_METHODS] as readonly string[]).toContain("invite.revoke");
    expect([...ADMITTED_METHODS] as readonly string[]).toContain("membership.update");
  });

  it("reads the request and the response off the door's registry", async () => {
    // The positive half of the intersection's registry side, proved by USE rather than
    // asserted: `request` is typed by the door's binding for this method, so reading
    // `inviteId` off it and answering the bound response shape compiles only while the
    // registry binds one. A method the registry did not bind would be an error at the
    // type argument, which is the case below.
    const revokeInvite: CollaborationMutation<"invite.revoke"> = async (request) =>
      await Promise.resolve({
        status: "served",
        value: { inviteId: request.inviteId, state: "revoked" },
      });

    const reply = await revokeInvite({
      sessionId: heldIdAsWireId(SESSION_ID),
      inviteId: heldIdAsWireId(INVITE_ID),
    });

    expect(reply).toStrictEqual({
      status: "served",
      value: { inviteId: INVITE_ID, state: "revoked" },
    });
  });

  it("answers the door's own refused arm, never a throw", () => {
    // The other arm of the same derivation: a refusal is a value on the way back, so
    // the performer's return type has to admit it without a `catch` anywhere.
    const refusal: DaemonReply<{ readonly inviteId: string; readonly state: string }> = {
      status: "refused",
      refusal: refuse(DAEMON_REPLY_REFUSAL_ORIGIN, "invite.not_found", "No such invitation."),
    };

    expect(refusal.status).toBe("refused");
  });
});

describe("the constraint's type-level refusals", () => {
  it("refuses a read the registry binds", () => {
    // @ts-expect-error TS1360: Type '"session.read"' does not satisfy the expected
    // type 'CollaborationMutationMethod'. Deleting the directive yields exactly that
    // error rather than TS2578, which is what makes this a control and not a comment:
    // a read bound here would hand the door no cancellation signal and look identical
    // to a write that deliberately carries none.
    const read = "session.read" satisfies CollaborationMutationMethod;

    expect(read).toBe("session.read");
  });

  it("refuses a verb neither half of the intersection holds", () => {
    // @ts-expect-error TS1360: Type '"driver.applyIntervention"' does not satisfy the
    // expected type 'CollaborationMutationMethod'. The door binds no schema for it and
    // the store no longer calls it a write — it was on the roster naming a method this
    // console cannot call, which is why a control disabled for it disabled nothing.
    const unbound = "driver.applyIntervention" satisfies CollaborationMutationMethod;

    expect(unbound).toBe("driver.applyIntervention");
  });

  it("negative control: the two verbs this family dispatches are admitted", () => {
    // Without this, a constraint that had collapsed to `never` would satisfy both
    // refusals above and refuse the family's own methods just as quietly.
    const revoke = "invite.revoke" satisfies CollaborationMutationMethod;
    const membership = "membership.update" satisfies CollaborationMutationMethod;

    expect([revoke, membership]).toStrictEqual(["invite.revoke", "membership.update"]);
  });
});
