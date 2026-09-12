// The session goal, as the approvals pane renders it.
//
// Its own file on the precedent beside it: the goal is a section this pane hosts
// rather than one of its two reads, with its own draft and its own mutation. Reading
// it out of the pane's own suite made two subjects share one file and one setup.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mountPane, settle } from "./approvals-pane.test-support.js";

describe("the session goal", () => {
  it("renders the goal section with its control, in the pane's own region", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const goal = screen.getByRole("region", { name: "Session goal" });
    expect(within(goal).getByText("No goal set")).not.toBeNull();
    expect(within(goal).getByRole("button", { name: "Set a goal" })).not.toBeNull();
  });
});
