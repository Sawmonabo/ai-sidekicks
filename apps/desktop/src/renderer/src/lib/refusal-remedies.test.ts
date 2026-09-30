// The remedy table answers for its own codes, and `undefined` for any other rather than a nearest
// neighbor, which would advise on a refusal the console does not understand.

import { describe, expect, it } from "vitest";

import { refusalRemedyFor } from "./refusal-remedies.js";

describe("what the table says about each answered code", () => {
  it("sends a vanished session to the banner, because it is not one control's news", () => {
    expect(refusalRemedyFor("session.not_found")?.rendering).toBe("banner");
  });

  it("settles the four whose act cannot be retried, and leaves the one that can", () => {
    // `settled` withdraws a control; a wrong value leaves a button that can only be refused again
    // or removes one that works.
    expect(refusalRemedyFor("intervention.idempotency_conflict")?.settled).toBe(true);
    expect(refusalRemedyFor("approval.already_resolved")?.settled).toBe(true);
    expect(refusalRemedyFor("run.not_found")?.settled).toBe(true);
    expect(refusalRemedyFor("session.not_found")?.settled).toBe(true);
    expect(refusalRemedyFor("session.goal_delivery_failed")?.settled).toBe(false);
  });
});

describe("an unlisted code gets no invented move", () => {
  it.each([
    ["a registered code with no console act", "driver.capability_unsupported"],
    ["a code the corpus registers nowhere", "run.version_conflict"],
    ["a code from a namespace the table names", "session.archived"],
    ["a near miss on a code it does answer", "run.not_found "],
    ["the empty string", ""],
  ])("answers nothing for %s", (_name, code) => {
    expect(refusalRemedyFor(code)).toBeUndefined();
  });

  it("answers nothing for a name inherited from Object.prototype", () => {
    // The lookup is `Object.hasOwn`, not `in`; an inherited key would reach a renderer as a remedy.
    expect(refusalRemedyFor("constructor")).toBeUndefined();
    expect(refusalRemedyFor("toString")).toBeUndefined();
  });
});
