// What a worktree card puts on screen.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "@renderer/lib/wire-figures.js";
import { worktreeRecord } from "../repo-mounts.test-support.js";
import { WorktreeCard } from "./WorktreeCard.js";
import { WORKTREE_STATE_PRESENTATION } from "../execution-root-model.js";

// A fixture instant built directly, not parsed.
const NOW_MILLISECONDS = Date.UTC(2026, 0, 1, 9, 30, 0);

describe("WorktreeCard — the face", () => {
  it("names the branch, the state, the root, and the age", () => {
    const record = worktreeRecord();
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const card = within(container);
    expect(card.getByRole("heading", { level: 4 }).textContent).toBe(record.branchName);
    expect(container.textContent).toContain(record.state);
    expect(container.textContent).toContain(record.fsRoot);
    expect(container.textContent).toContain(formatRelativeTime(record.createdAt, NOW_MILLISECONDS));
    expect(container.textContent).toContain(WORKTREE_STATE_PRESENTATION.ready.meaning);
  });
});
