// What a worktree card puts on screen, and what it refuses to.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "@renderer/lib/wire-figures.js";
import { worktreeRecord } from "../repo-mounts.test-support.js";
import { WorktreeCard } from "./WorktreeCard.js";
import { WORKTREE_STATE_PRESENTATION } from "../execution-root-model.js";
import {
  WORKTREE_ABSENT_COLUMN_COPY,
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
} from "../execution-root-columns.js";

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

  it("renders the branch verbatim, ordinal suffix included", () => {
    // A daemon-derived name that took a suffix is displayed as sent, never normalized.
    const record = worktreeRecord({ branchName: "sidekicks/abc123/rate-limit-wiring-2" });
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(within(container).getByRole("heading", { level: 4 }).textContent).toBe(
      "sidekicks/abc123/rate-limit-wiring-2",
    );
  });

  it("keeps the exact creation stamp beside the reading of it", () => {
    const record = worktreeRecord();
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.querySelector(`[title="${record.createdAt}"]`)).not.toBeNull();
  });

  it("negative control: the age moves with the instant it is given, not with the wall clock", () => {
    const record = worktreeRecord();
    const early = render(<WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />);
    const late = render(
      <WorktreeCard record={record} nowMilliseconds={Date.UTC(2026, 0, 4, 9, 0, 0)} />,
    );
    expect(early.container.textContent).not.toBe(late.container.textContent);
  });
});

describe("WorktreeCard — provenance", () => {
  it("renders every disclosure column's label and value", () => {
    const record = worktreeRecord({ state: "merged" });
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    for (const column of WORKTREE_DETAIL_COLUMNS) {
      expect(container.textContent).toContain(WORKTREE_COLUMN_LABELS[column]);
    }
    expect(container.textContent).toContain(record.createdBySessionId);
    expect(container.textContent).toContain("run-01");
  });

  it("names an absent run as a producer state rather than a gap", () => {
    const { container } = render(
      <WorktreeCard
        record={worktreeRecord({ createdByRunId: undefined })}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain(WORKTREE_ABSENT_COLUMN_COPY.createdByRunId);
  });

  it("the disclosure is a native details element, so it is keyboard-reachable and holds no state", () => {
    const { container } = render(
      <WorktreeCard record={worktreeRecord()} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const disclosure = container.querySelector("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Provenance");
  });
});

describe("WorktreeCard — the controls it does not offer", () => {
  it("offers no retire, force, or branch-switch control on any state", () => {
    // The retire confirm enumerates an inspection this card is never given, so a button here
    // would offer an act with no preview behind it.
    for (const state of ["ready", "dirty", "merged", "failed", "creating"] as const) {
      const { container } = render(
        <WorktreeCard record={worktreeRecord({ state })} nowMilliseconds={NOW_MILLISECONDS} />,
      );
      expect(container.querySelectorAll("button")).toHaveLength(0);
    }
  });
});
