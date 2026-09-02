// What a clone card puts on screen — and specifically the countdown, which is the
// one thing on this surface that changes with nobody acting.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../primitives/index.js";
import { EphemeralCloneCard } from "./EphemeralCloneCard.js";
import {
  CLONE_EXPIRY_COPY,
  EPHEMERAL_CLONE_ABSENT_COLUMN_COPY,
  EPHEMERAL_CLONE_COLUMN_LABELS,
  EPHEMERAL_CLONE_DETAIL_COLUMNS,
  EPHEMERAL_CLONE_STATE_PRESENTATION,
  type EphemeralCloneStatusRecord,
} from "./worktree-model.js";

const EXPIRES_AT = "2026-01-01T12:00:00.000Z";
const BEFORE_EXPIRY = Date.parse("2026-01-01T09:30:00.000Z");
const AFTER_EXPIRY = Date.parse("2026-01-01T13:00:00.000Z");

function cloneRecord(
  overrides: Partial<EphemeralCloneStatusRecord> = {},
): EphemeralCloneStatusRecord {
  return {
    cloneId: "clone-01",
    workspaceId: "workspace-sidekicks",
    cloneRoot: "/Users/dev/.sidekicks/clones/clone-01",
    branchName: "run-9f2c1a",
    state: "ready",
    cleanupPolicy: "on_run_complete",
    expiresAt: EXPIRES_AT,
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  } as EphemeralCloneStatusRecord;
}

describe("EphemeralCloneCard — the face", () => {
  it("names the branch, the state, the root, the age, and the disposal time", () => {
    const record = cloneRecord();
    const { container } = render(
      <EphemeralCloneCard record={record} nowMilliseconds={BEFORE_EXPIRY} />,
    );
    expect(within(container).getByRole("heading", { level: 4 }).textContent).toBe(
      record.branchName,
    );
    expect(container.textContent).toContain(record.state);
    expect(container.textContent).toContain(record.cloneRoot);
    expect(container.textContent).toContain(formatRelativeTime(record.createdAt, BEFORE_EXPIRY));
    expect(container.textContent).toContain(formatRelativeTime(EXPIRES_AT, BEFORE_EXPIRY));
    expect(container.textContent).toContain(EPHEMERAL_CLONE_STATE_PRESENTATION.ready.meaning);
  });

  it("keeps the exact disposal stamp beside the countdown reading of it", () => {
    const { container } = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={BEFORE_EXPIRY} />,
    );
    expect(container.querySelector(`[title="${EXPIRES_AT}"]`)).not.toBeNull();
  });
});

describe("EphemeralCloneCard — the disposal countdown", () => {
  it("states the consequence while disposal is still ahead", () => {
    const { container } = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={BEFORE_EXPIRY} />,
    );
    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.scheduled);
  });

  it("says the refs may already be gone once the time has passed", () => {
    const { container } = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={AFTER_EXPIRY} />,
    );
    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.elapsed);
  });

  it("negative control: the two readings are not the same sentence", () => {
    // Without this the pair above would pass against a card that printed one
    // consequence line whatever the clock said.
    const scheduled = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={BEFORE_EXPIRY} />,
    );
    const elapsed = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={AFTER_EXPIRY} />,
    );
    expect(scheduled.container.textContent).not.toBe(elapsed.container.textContent);
    expect(scheduled.container.textContent).not.toContain(CLONE_EXPIRY_COPY.elapsed);
  });
});

describe("EphemeralCloneCard — the disclosure", () => {
  it("renders every disclosure column, cleanup policy included", () => {
    const { container } = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={BEFORE_EXPIRY} />,
    );
    for (const column of EPHEMERAL_CLONE_DETAIL_COLUMNS) {
      expect(container.textContent).toContain(EPHEMERAL_CLONE_COLUMN_LABELS[column]);
    }
    expect(container.textContent).toContain("on_run_complete");
  });

  it("names an unswept clone rather than blanking the column", () => {
    const { container } = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={BEFORE_EXPIRY} />,
    );
    expect(container.textContent).toContain(EPHEMERAL_CLONE_ABSENT_COLUMN_COPY.cleanedAt);
  });

  it("offers no dispose control", () => {
    // The dispose confirm is a consent surface that enumerates what disposal takes;
    // a card given no such preview must not stand in for one.
    const { container } = render(
      <EphemeralCloneCard record={cloneRecord()} nowMilliseconds={AFTER_EXPIRY} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
