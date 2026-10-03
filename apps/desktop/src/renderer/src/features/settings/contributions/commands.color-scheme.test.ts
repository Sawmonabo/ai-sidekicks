// The `Color scheme` row moves the window through the design's cycle: following the system,
// then dark, then light, then back.

import { describe, expect, it } from "vitest";

import type { SchemePreference } from "@renderer/styles/tokens.js";
import { buildColorSchemeCommand } from "./commands.js";

describe("the Color scheme row", () => {
  it("cycles from following the system to dark, to light, and back", async () => {
    let current: SchemePreference = "system";
    const chosen: SchemePreference[] = [];
    const row = buildColorSchemeCommand(
      () => current,
      (preference) => {
        chosen.push(preference);
        current = preference;
      },
    );

    await row.run();
    await row.run();
    await row.run();

    expect(chosen).toStrictEqual(["dark", "light", "system"]);
  });

  it("starts from the scheme the window holds when it runs, not when it was built", async () => {
    let current: SchemePreference = "system";
    const chosen: SchemePreference[] = [];
    const row = buildColorSchemeCommand(
      () => current,
      (preference) => {
        chosen.push(preference);
      },
    );
    current = "light";

    await row.run();

    expect(chosen).toStrictEqual(["system"]);
  });
});
