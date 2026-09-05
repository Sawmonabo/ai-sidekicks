// What a worktree card puts on screen, and what it refuses to.
//
// The cases drive the real card against real records rather than a stand-in, and
// each clean assertion is paired with the case that would pass if the card stopped
// doing the thing: a disposition line asserted present on a retired row is only
// meaningful beside the ready row that must not carry one.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../../primitives/index.js";
import { worktreeRecord } from "./repo-mounts.test-support.js";
import { WorktreeCard } from "./WorktreeCard.js";
import { WORKTREE_DISK_DISPOSITION_COPY, WORKTREE_STATE_PRESENTATION } from "./worktree-model.js";
import {
  WORKTREE_ABSENT_COLUMN_COPY,
  WORKTREE_COLUMN_LABELS,
  WORKTREE_DETAIL_COLUMNS,
} from "./worktree-columns.js";

// Built rather than parsed: a fixture instant is this suite's own decision, and the
// console's one reader of a wire stamp is `parseInstant`, not this line.
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
    // Never auto-suffix and never re-derive: a daemon-derived name that took a
    // suffix is displayed as sent, and a card that normalised it would be showing
    // a branch the daemon does not have.
    const record = worktreeRecord({ branchName: "sidekicks/abc123/rate-limit-wiring-2" });
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(within(container).getByRole("heading", { level: 4 }).textContent).toBe(
      "sidekicks/abc123/rate-limit-wiring-2",
    );
  });

  it("keeps the exact creation stamp beside the reading of it", () => {
    // The eight rules: no formatted figure hides the value the daemon sent.
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

describe("WorktreeCard — the retired-with-files sub-state", () => {
  it("says the files are still on disk when a retired row has no sweep stamp", () => {
    const { container } = render(
      <WorktreeCard
        record={worktreeRecord({ state: "retired" })}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain(WORKTREE_DISK_DISPOSITION_COPY["retired-on-disk"]);
  });

  it("says the checkout is gone once the sweep has stamped it", () => {
    const { container } = render(
      <WorktreeCard
        record={worktreeRecord({ state: "retired", cleanedAt: "2026-01-01T09:20:00.000Z" })}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain(WORKTREE_DISK_DISPOSITION_COPY.reclaimed);
  });

  it("negative control: a live row carries no disposition line at all", () => {
    // Without this the two cases above would pass against a card that printed all
    // three sentences on every row.
    const { container } = render(
      <WorktreeCard record={worktreeRecord()} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.querySelector(".meridian-root-card__disposition")).toBeNull();
    expect(container.textContent).not.toContain(WORKTREE_DISK_DISPOSITION_COPY["retired-on-disk"]);
  });
});

describe("WorktreeCard — provenance survives retirement", () => {
  it("renders every disclosure column's label and value", () => {
    const record = worktreeRecord({ state: "retired", cleanedAt: "2026-01-01T09:20:00.000Z" });
    const { container } = render(
      <WorktreeCard record={record} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    for (const column of WORKTREE_DETAIL_COLUMNS) {
      expect(container.textContent).toContain(WORKTREE_COLUMN_LABELS[column]);
    }
    // The two the design names: losing run provenance when a worktree is later
    // retired is the pitfall this row exists to not have.
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
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Provenance and cleanup");
  });
});

describe("WorktreeCard — the controls it does not offer", () => {
  it("offers no retire, force, or branch-switch control on any state", () => {
    // Preview is consent: the retire confirm enumerates an inspection this card is
    // never given, and a force-override is deliberately unscheduled. A card that
    // grew one of these buttons would be offering an act with no preview behind it.
    for (const state of ["ready", "dirty", "merged", "retired", "failed", "creating"] as const) {
      const { container } = render(
        <WorktreeCard record={worktreeRecord({ state })} nowMilliseconds={NOW_MILLISECONDS} />,
      );
      expect(container.querySelectorAll("button")).toHaveLength(0);
    }
  });
});
