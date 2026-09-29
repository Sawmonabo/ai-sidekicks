// The workspace: what it composes.
//
// The arrangement it saves and restores is `SessionScreen.persistence.test.tsx`. Both mount
// through the same shape, which lives once in `Workspace.test-support.tsx`.

import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SESSION_ID, memoryStore, renderSessionScreen } from "./SessionScreen.test-support.js";

describe("Workspace — what it composes", () => {
  it("renders the session header above the pane layout", async () => {
    const { container } = renderSessionScreen(memoryStore());
    await waitFor(() => {
      expect(container.querySelector(".meridian-pane-layout__pane")).not.toBeNull();
    });
    expect(container.querySelector(".meridian-session-header")).not.toBeNull();
    expect(container.querySelector(".meridian-session-header")?.textContent).toContain(SESSION_ID);
  });
});
