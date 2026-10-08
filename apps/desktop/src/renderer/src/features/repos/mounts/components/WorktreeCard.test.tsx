// What a worktree card says about the worktree's state, drawn from the status record alone.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "#renderer/lib/wire/figures.js";
import { worktreeRecord } from "../repo-mounts.test-support.js";
import { WorktreeCard } from "./WorktreeCard.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";

// A fixture instant built directly, not parsed.
const NOW_MILLISECONDS = Date.UTC(2026, 0, 1, 9, 30, 0);

describe("WorktreeCard — the face", () => {
  it("names the branch, the state, the root, and the age", () => {
    const record = worktreeRecord();
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
      // The bridge the card's clock locale comes from.
      { wrapper: liveBridgeWrapper() },
    );
    const card = within(container);
    expect(card.getByRole("heading", { level: 4 }).textContent).toBe(record.branchName);
    // The fixture record is `ready`, which the chip reads as a word.
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain(record.fsRoot);
    expect(container.textContent).toContain(formatRelativeTime(record.createdAt, NOW_MILLISECONDS));
  });
});
