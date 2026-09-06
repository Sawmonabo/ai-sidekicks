// The scope model's one interesting claim: asking to choose beats retention.
//
// Every case here is written against the fold it replaced — `chosen ?? retained` —
// so the negative control is not a separate test but the shape of the assertion: on
// the old fold, `choosing` and `retained` are the same value, and the first case
// below is the one that separates them.

import { describe, expect, it } from "vitest";

import {
  AWAITING_SESSION_CHOICE,
  FOLLOWING_WINDOW_RETENTION,
  chosenScope,
  scopeSessionIdFor,
} from "./destination-scope.js";

const RETAINED = "019b7a10-0280-75e5-8510-ada11a5a3333";
const PICKED = "019b7a10-0280-75e5-8510-ada11a5a4444";

describe("which session the workflows destination reads from", () => {
  it("follows the window's retained session while nothing else has been said", () => {
    expect(scopeSessionIdFor(FOLLOWING_WINDOW_RETENTION, RETAINED)).toBe(RETAINED);
  });

  it("reads from nothing while a person is choosing, even under a retained session", () => {
    // The whole finding, as one assertion: the old fold answered `RETAINED` here,
    // because "no choice yet" and "follow the window" were one value. The picker
    // therefore never appeared for anybody who had opened a session.
    expect(scopeSessionIdFor(AWAITING_SESSION_CHOICE, RETAINED)).toBeUndefined();
  });

  it("reads from the picked session, overriding what the window retained", () => {
    expect(scopeSessionIdFor(chosenScope(PICKED), RETAINED)).toBe(PICKED);
  });

  it("has nothing to read from when the window retained nothing and nobody chose", () => {
    expect(scopeSessionIdFor(FOLLOWING_WINDOW_RETENTION, undefined)).toBeUndefined();
  });
});
