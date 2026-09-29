import { describe, expect, it } from "vitest";

import { PALETTE_RECENTS_CAP, PALETTE_RESULT_CAP } from "./palette.js";

describe("the command palette's two caps describe one list", () => {
  it("does not remember more commands than the list can show", () => {
    // Recents are drawn inside the ranked result list, so a recents cap above the
    // result cap would remember rows no one can reach.
    expect(PALETTE_RECENTS_CAP).toBeLessThanOrEqual(PALETTE_RESULT_CAP);
  });
});
