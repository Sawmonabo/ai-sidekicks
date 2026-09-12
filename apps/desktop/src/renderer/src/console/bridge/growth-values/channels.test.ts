// The channel plane's one closed vocabulary, held to the set the corpus registers.
//
// WHY A CASE AND NOT THE COMPILER. This tuple is the console's single declaration of
// a shape no code package carries — `packages/contracts` ships `ChannelState` and
// `MAIN_CHANNEL_NAME` and stops there, and `ChannelListResponseChannel` is exactly
// `{id, name?, state, participantCount}` — so nothing in the type system holds it to
// the wire. Both directions of drift reach a PERSON rather than a build: a member
// invented here is offered in the create-channel form and can only be refused by the
// daemon, and a member missing is a configuration nobody can choose. The create form
// derives its options from this tuple, so this is the only place either defect can be
// caught.

import { describe, expect, it } from "vitest";

import { GROWTH_CHANNEL_AUDIENCES } from "./channels.js";

/** The two audiences the wire takes: sidekicks read the channel, or none ever does. */
const REGISTERED_AUDIENCES = ["participants", "humans-only"];

describe("the channel configuration a form may offer", () => {
  it("offers exactly the two audiences", () => {
    expect([...GROWTH_CHANNEL_AUDIENCES]).toStrictEqual(REGISTERED_AUDIENCES);
  });

  it("negative control: the pin discriminates on a set that grew a member", () => {
    // Without this the case above would pass over a comparison that answered true for
    // anything — which is what a pin written against a mutable copy does.
    expect([...GROWTH_CHANNEL_AUDIENCES, "agents-only"]).not.toStrictEqual(REGISTERED_AUDIENCES);
  });
});
