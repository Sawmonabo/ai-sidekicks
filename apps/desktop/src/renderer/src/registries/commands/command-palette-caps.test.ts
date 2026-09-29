import { describe, expect, it } from "vitest";

import { COMMAND_PALETTE_RECENTS_CAP, COMMAND_PALETTE_RESULT_CAP } from "./command-palette-caps.js";

describe("the command palette's two caps describe one list", () => {
  it("does not remember more commands than the list can show", () => {
    // Recents are drawn inside the ranked result list, so a recents cap above the
    // result cap would remember rows no one can reach.
    expect(COMMAND_PALETTE_RECENTS_CAP).toBeLessThanOrEqual(COMMAND_PALETTE_RESULT_CAP);
  });
});
