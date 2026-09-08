// The channel plane's three closed vocabularies, held to the sets the corpus registers.
//
// WHY A CASE AND NOT THE COMPILER. These tuples are the console's single declaration
// of shapes no code package carries — `packages/contracts` ships `ChannelState` and
// `MAIN_CHANNEL_NAME` and stops there, and `ChannelListResponseChannel` is exactly
// `{id, name?, state, participantCount}` — so nothing in the type system holds them
// to the wire. Both directions of drift reach a PERSON rather than a build: a member
// invented here is offered in the create-channel form and can only be refused by the
// daemon, and a member missing is a configuration nobody can choose. The create form
// derives its options from these tuples, so this is the only place either defect can
// be caught.
//
// The sets are transcribed once, here, against their governing sections — the barrel
// census beside this file is the same shape for the same reason.

import { describe, expect, it } from "vitest";

import {
  GROWTH_CHANNEL_AUDIENCES,
  GROWTH_CHANNEL_KINDS,
  GROWTH_CHANNEL_TURN_POLICIES,
} from "./channels.js";

/**
 * `Spec-016 §Turn Policies`, in the table's own order: `free-form` (the default),
 * `round-robin`, `request-based`.
 *
 * `moderated` is NOT a member of it. The neighbouring `moderation` member of
 * `GrowthChannelConfig` — the pre-turn gate and the post-turn review — is a separate
 * axis that applies under any policy, and reading it as a fourth policy both sent a
 * value the daemon must refuse and left `request-based` unreachable from the form.
 */
const REGISTERED_TURN_POLICIES = ["free-form", "round-robin", "request-based"];

/** `Spec-016 §Interfaces And Contracts` (D-016-21), audience. */
const REGISTERED_AUDIENCES = ["participants", "humans-only"];

/** `Spec-016 §Interfaces And Contracts` (D-016-21), channel kind. */
const REGISTERED_KINDS = ["general", "direct"];

describe("the channel configuration a form may offer", () => {
  it("offers exactly the turn policies the corpus registers", () => {
    expect([...GROWTH_CHANNEL_TURN_POLICIES]).toStrictEqual(REGISTERED_TURN_POLICIES);
  });

  it("never offers the moderation axis as a turn policy", () => {
    // The two are independent members of one configuration, and conflating them is
    // what put an unregistered value on the wire.
    expect([...GROWTH_CHANNEL_TURN_POLICIES]).not.toContain("moderated");
  });

  it("offers exactly the two audiences", () => {
    expect([...GROWTH_CHANNEL_AUDIENCES]).toStrictEqual(REGISTERED_AUDIENCES);
  });

  it("offers exactly the two channel kinds", () => {
    expect([...GROWTH_CHANNEL_KINDS]).toStrictEqual(REGISTERED_KINDS);
  });

  it("negative control: the pin discriminates on a set that grew a member", () => {
    // Without this the four cases above would pass over a comparison that answered
    // true for anything — which is what a pin written against a mutable copy does.
    expect([...GROWTH_CHANNEL_TURN_POLICIES, "moderated"]).not.toStrictEqual(
      REGISTERED_TURN_POLICIES,
    );
  });
});
