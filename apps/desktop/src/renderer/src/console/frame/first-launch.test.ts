// The four conjuncts that decide a first launch, one case each and a control each.
//
// The rule is the whole surface here: whether a window opens into the demo is
// decidable from four values, and a table is the honest shape for it. What the ACT
// does with the answer — the durable read, the navigation, the mark — is
// `first-launch-opening.test.tsx`, because an act that is wrong shows the right
// opening twice and a rule that is wrong shows the wrong one once.

import { describe, expect, it } from "vitest";

import { DEFAULT_SCENARIO_ID } from "../bridge/index.js";
import { FIRST_LAUNCH_SEEN_VALUE, firstLaunchRoute, hasSeenFirstLaunch } from "./first-launch.js";

const DEMO_SESSION_ID = "019b78ff-f900-75e5-8510-ada11a5a46a5";

/**
 * A first launch: no route asked for, the default scenario playing, nothing seen.
 *
 * The scenario id comes from the module that decides it rather than from a literal —
 * a rule that compared against a copied string would keep passing on the day the
 * default opening changed, which is exactly when it should fail.
 */
const FIRST_LAUNCH = {
  openedAtHash: "",
  demoSessionId: DEMO_SESSION_ID,
  playingScenarioId: DEFAULT_SCENARIO_ID,
  hasSeenFirstLaunch: false,
} as const;

describe("where a window opens", () => {
  it("opens into the scripted session on a first launch", () => {
    expect(firstLaunchRoute(FIRST_LAUNCH)).toStrictEqual({
      kind: "workspace",
      sessionId: DEMO_SESSION_ID,
    });
  });

  it("negative control: it says nothing once the install has seen it", () => {
    // Without this the case above would pass over a rule that opened the demo on
    // every launch — which is a tour, and the one thing this surface must not be.
    expect(firstLaunchRoute({ ...FIRST_LAUNCH, hasSeenFirstLaunch: true })).toBeUndefined();
  });

  it("negative control: it says nothing where no scenario is playing", () => {
    // The release build. There is no scripted session to open into, so the console
    // opens exactly where it always did and the live first-run frame is untouched.
    expect(firstLaunchRoute({ ...FIRST_LAUNCH, demoSessionId: undefined })).toBeUndefined();
  });

  it("honours a hash that asked for something, including the sessions list", () => {
    // An auxiliary window, a reload, and a person typing an address all arrive this
    // way. `#/sessions` is the load-bearing one: it parses to the same route an empty
    // hash does, so a rule comparing ROUTES would override somebody who asked for the
    // list by name.
    expect(firstLaunchRoute({ ...FIRST_LAUNCH, openedAtHash: "#/settings" })).toBeUndefined();
    expect(firstLaunchRoute({ ...FIRST_LAUNCH, openedAtHash: "#/sessions" })).toBeUndefined();
    // And a bare "#", which a browser leaves behind on its own, is still nothing asked.
    expect(firstLaunchRoute({ ...FIRST_LAUNCH, openedAtHash: "#" })).toStrictEqual({
      kind: "workspace",
      sessionId: DEMO_SESSION_ID,
    });
  });

  it("negative control: it says nothing where a scenario was named", () => {
    // A suite pinning the empty first-run composition, and the picker opening a
    // scenario deliberately, both arrive this way. The session id is left in place on
    // purpose: EVERY scenario scripts one, so a rule that read "a session exists" as
    // "the demo is playing" would hijack a launch that had already said what it wanted
    // — which is what this control would have caught, and did.
    expect(firstLaunchRoute({ ...FIRST_LAUNCH, playingScenarioId: "first-run" })).toBeUndefined();
  });
});

describe("the mark that makes it happen once", () => {
  it("reads any stored record as seen, and nothing as not seen", () => {
    // The presence of the record IS the mark. A read the store could not perform
    // answers `undefined` too, and that is deliberately the same answer: showing the
    // demo a second time costs a minute, and skipping it costs the first launch.
    expect(hasSeenFirstLaunch(undefined)).toBe(false);
    expect(hasSeenFirstLaunch({ value: FIRST_LAUNCH_SEEN_VALUE })).toBe(true);
  });
});
