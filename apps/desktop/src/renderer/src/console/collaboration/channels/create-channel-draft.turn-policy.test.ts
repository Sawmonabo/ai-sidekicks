// What the turn policy decides about the request, and what it must not touch.
//
// A SUITE BESIDE `create-channel-draft.test.ts` rather than inside it, on this package's
// size gate and on the split it enforces — the same seam `create-channel-draft.reset.test.ts`
// sits on. That file decides which members a general or direct channel sends at all;
// this one decides which of them the POLICY scopes, which is one subject with two
// directions: a `round-robin` channel cannot be created without its agent order, and no
// other channel may be created carrying one.
//
// THE DEFECT THESE CASES EXIST FOR. The draft deliberately keeps the typed order when
// the policy moves off `round-robin` — a person who tries `free-form` and comes back
// should not have to type it again — and the request went on composing it from that
// text. Every `GrowthChannelConfig` member is fixed at creation and V1 registers no
// channel-configuration mutation, so the channel would have carried an agent order
// forever that its own policy never reads and nobody could remove.

import { describe, expect, it } from "vitest";

import { PARTICIPANT_YOU } from "./channels.test-support.js";
import { missingFrom, namedDraft, requestOf } from "./create-channel-draft.test-support.js";

describe("create channel draft — the order a round-robin channel must carry", () => {
  it("sends the round-robin order as a list, dropping what a person typed around it", () => {
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder(" reviewer , , builder ");
    expect(requestOf(draft).config?.roundRobinOrder).toStrictEqual(["reviewer", "builder"]);
  });
  it("composes nothing while the order is empty", () => {
    // `Spec-016 §Turn Policies` requires a non-empty agent order for every
    // round-robin channel and refuses a create without one, so a form declaring
    // itself ready here would be promising a request the daemon must refuse.
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    expect(missingFrom(draft, PARTICIPANT_YOU).join(" ")).toContain("round-robin order");
  });

  it("counts a field of separators as empty, exactly as the request does", () => {
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder(" , , ");
    expect(missingFrom(draft, PARTICIPANT_YOU).join(" ")).toContain("round-robin order");
  });

  it("negative control: the same draft composes once an order is typed", () => {
    // Without this the two cases above would pass over a draft that refused every
    // round-robin channel whatever its order said.
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder("reviewer, builder");
    expect(requestOf(draft).config?.roundRobinOrder).toStrictEqual(["reviewer", "builder"]);
  });

  it("asks for no order under any other policy the form can choose", () => {
    const draft = namedDraft();
    draft.setTurnPolicy("free-form");
    expect(missingFrom(draft, PARTICIPANT_YOU)).toStrictEqual([]);
    expect(requestOf(draft).config?.roundRobinOrder).toBeUndefined();
  });

  it("asks for no order under the session's own policy, which this form cannot read", () => {
    // An unset policy MEANS the session's default, and the console does not know
    // which one that is — demanding an order there would be a rule invented against
    // a policy nobody on this surface can see.
    expect(missingFrom(namedDraft(), PARTICIPANT_YOU)).toStrictEqual([]);
  });

  it("sends no order once the policy moves off round-robin, and keeps the text typed", () => {
    // THE DEFECT. The text is deliberately kept when the policy changes — a person
    // who tries `free-form` and comes back should not have to type the order again —
    // and the request went on composing it from that text. `Spec-016 §Turn Policies`
    // makes the order the sequence a ROUND-ROBIN channel takes its turns in, and every
    // config member is fixed at creation, so the channel would have carried an agent
    // order forever that its own policy never reads and no mutation can remove.
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder("reviewer, builder");
    draft.setTurnPolicy("free-form");

    expect(requestOf(draft).config?.roundRobinOrder).toBeUndefined();
    expect(draft.roundRobinOrder).toBe("reviewer, builder");
  });

  it("sends no order back under the session's own policy either", () => {
    // The same rule at the third setting, which is the one the form opens on: an
    // unset policy is the session's, and an order composed against a policy this
    // console cannot read is a value nobody chose for it.
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder("reviewer, builder");
    draft.setTurnPolicy(undefined);

    expect(requestOf(draft).config).toStrictEqual({ audience: "participants" });
  });

  it("negative control: switching back sends the same order, with nothing re-typed", () => {
    // Without it the two cases above would pass over a draft that CLEARED the text
    // when the policy moved. That is the other way to stop sending it, and it takes a
    // person's work away for a select they may be passing through.
    const draft = namedDraft();
    draft.setTurnPolicy("round-robin");
    draft.setRoundRobinOrder("reviewer, builder");
    draft.setTurnPolicy("free-form");
    draft.setTurnPolicy("round-robin");

    expect(requestOf(draft).config?.roundRobinOrder).toStrictEqual(["reviewer", "builder"]);
  });

  it("negative control: the per-agent cap is scoped to no policy and still travels", () => {
    // Without it the rule above would read as one about policy fields in general.
    // `turnsPerAgent` overrides the session's per-agent consecutive-turn limit under
    // EVERY policy — the contract scopes it to none — so a form that narrowed it the
    // same way would drop a cap a person set for a free-form channel.
    const draft = namedDraft();
    draft.setTurnsPerAgent("3");
    draft.setTurnPolicy("free-form");

    expect(requestOf(draft).config?.turnsPerAgent).toBe(3);
  });
});
