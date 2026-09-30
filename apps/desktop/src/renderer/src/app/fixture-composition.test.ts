// A window started without a fixture launch composes nothing, so it runs on the preload's bridge
// and never plays a scenario in place of the daemon.

import { describe, expect, it } from "vitest";

import { composeFixtureLaunch } from "./fixture-composition.js";

describe("composeFixtureLaunch — the launch the preload exposed", () => {
  it("composes nothing for a window started without a launch", () => {
    expect(composeFixtureLaunch()).toBeUndefined();
  });
});
