// The session store's two sequence bounds, held to the relation their rationales claim.

import { describe, expect, it } from "vitest";

import {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALIZATION_BUFFER_CAP,
} from "./session-store-caps.js";

describe("session store caps — the two sequence bounds describe one store", () => {
  it("repairs a gap at least as wide as the pre-initialization buffer can shed", () => {
    // A store whose read never lands sheds its oldest buffered events, and the
    // drain re-derives that loss as one gap. At or below the buffer's own cap the
    // ordinary overflow path would report the stream DIVERGED — refusing the very
    // events the buffer kept — so the repairable bound has to sit above it, and
    // the relation is what says so rather than the two numbers happening to.
    expect(MAX_REPAIRABLE_SEQUENCE_GAP).toBeGreaterThan(PRE_INITIALIZATION_BUFFER_CAP);
  });
});
