// The session store's two sequence bounds, held to the relation their rationales claim.

import { describe, expect, it } from "vitest";

import {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALIZATION_BUFFER_CAP,
} from "./session-store-caps.js";

describe("session store caps — the two sequence bounds describe one store", () => {
  it("repairs a gap at least as wide as the pre-initialization buffer can shed", () => {
    // A store whose read never lands sheds its oldest buffered events and the drain re-derives
    // that as one gap. At or below the buffer cap the overflow path would report the stream
    // diverged over events the buffer kept, so the relation is what says the bound sits above.
    expect(MAX_REPAIRABLE_SEQUENCE_GAP).toBeGreaterThan(PRE_INITIALIZATION_BUFFER_CAP);
  });
});
