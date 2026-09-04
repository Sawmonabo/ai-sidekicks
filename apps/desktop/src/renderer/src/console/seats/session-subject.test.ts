// The one predicate two families' holders compare through.
//
// It is four lines, and it is worth a suite because the four lines are the whole
// content of a rule both families had written for themselves and both had written
// wrong: they compared the session id, which is equal across a bridge replacement
// and across a rebuilt store. Each case below is one of the substitutions that
// comparison admitted.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { SessionStore } from "../store/index.js";
import { isCurrentSessionSubject } from "./session-subject.js";

function fixtureBridge(sessionId: string): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      id: `seats-session-subject-${sessionId}`,
      label: "Nothing scripted",
      purpose: "Drives the subject predicate against a bridge that plays no beat.",
      sessionId,
      participantIdsInJoinOrder: [],
      beats: [],
      replies: [],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
}

describe("the session subject — what counts as still current", () => {
  it("answers true only for the identical bridge and the identical store", () => {
    const bridge = fixtureBridge("session-1");
    const sessionStore = new SessionStore({ sessionId: "session-1" });
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, sessionStore)).toBe(true);
  });

  it("answers false for a replacement bridge under the same session", () => {
    const sessionStore = new SessionStore({ sessionId: "session-1" });
    const held = { bridge: fixtureBridge("session-1"), sessionStore };
    expect(isCurrentSessionSubject(held, fixtureBridge("session-1"), sessionStore)).toBe(false);
  });

  it("answers false for a rebuilt store under the same session", () => {
    const bridge = fixtureBridge("session-1");
    const held = { bridge, sessionStore: new SessionStore({ sessionId: "session-1" }) };
    expect(
      isCurrentSessionSubject(held, bridge, new SessionStore({ sessionId: "session-1" })),
    ).toBe(false);
  });

  it("negative control: comparing the session ids would call both of those current", () => {
    // Without this, the two cases above would prove nothing about which comparison
    // the predicate performs — both pairs name one session throughout.
    const held = {
      bridge: fixtureBridge("session-1"),
      sessionStore: new SessionStore({ sessionId: "session-1" }),
    };
    const arriving = {
      bridge: fixtureBridge("session-1"),
      sessionStore: new SessionStore({ sessionId: "session-1" }),
    };
    expect(held.sessionStore.sessionId).toBe(arriving.sessionStore.sessionId);
  });

  it("answers false where nothing is held, and where the mount resolved nothing", () => {
    const bridge = fixtureBridge("session-1");
    const sessionStore = new SessionStore({ sessionId: "session-1" });
    expect(isCurrentSessionSubject(undefined, bridge, sessionStore)).toBe(false);
    expect(isCurrentSessionSubject({ bridge, sessionStore }, undefined, sessionStore)).toBe(false);
    expect(isCurrentSessionSubject({ bridge, sessionStore }, bridge, undefined)).toBe(false);
  });
});
