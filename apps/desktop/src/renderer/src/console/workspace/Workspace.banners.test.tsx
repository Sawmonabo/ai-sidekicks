// The banners the workspace raises, when the same thing goes wrong twice.
//
// Both cases drive the real surface rather than the fold: what a person sees is a
// column of banners, and the two defects this file exists for are things that column
// did — it grew a duplicate row for every repeat of one refusal, and dismissing one
// row renumbered the keys of every row below it, so React remounted banners nobody
// had touched and took focus off the control somebody was tabbing through.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UiStateStore } from "../persistence/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { SESSION_ID, memoryStore, sessionStore, workspaceFor } from "./Workspace.test-support.js";

/** A store whose writes fail, which is what raises the workspace's own save refusal. */
class RejectingWriteAdapter extends MemoryPersistenceAdapter {
  public override async write(): Promise<void> {
    throw new Error("the store is closed");
  }
}

function renderSession(uiStateStore: UiStateStore): HTMLElement {
  const { container } = render(
    workspaceFor({ sessionId: SESSION_ID, store: sessionStore() }, uiStateStore, false),
  );
  return container;
}

/** Press the detach control the test pane body offers, and let the refusal settle. */
async function pressDetach(container: HTMLElement): Promise<void> {
  const control = container.querySelector<HTMLButtonElement>("[data-detach='timeline']");
  expect(control).not.toBeNull();
  await act(async () => {
    control?.click();
    await Promise.resolve();
  });
}

function bannerRows(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".meridian-workspace__banner")];
}

function rowCarrying(container: HTMLElement, text: string): HTMLElement {
  const row = bannerRows(container).find((candidate) => candidate.textContent?.includes(text));
  if (row === undefined) {
    throw new Error(`no banner carrying ${text}`);
  }
  return row;
}

async function dismiss(row: HTMLElement): Promise<void> {
  const control = row.querySelector<HTMLButtonElement>('[aria-label="Dismiss this notice"]');
  expect(control).not.toBeNull();
  await act(async () => {
    control?.click();
    await Promise.resolve();
  });
}

describe("Workspace — the banner column", () => {
  it("counts a refusal raised three times rather than stacking three of it", async () => {
    // The window wire is not registered in this build, so every press refuses with the
    // same three fields. Three rows saying one thing is three chances to dismiss the
    // wrong one and no more information than the first.
    const container = renderSession(memoryStore());
    await waitFor(() => {
      expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
    });

    await pressDetach(container);
    await pressDetach(container);
    await pressDetach(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "wire-unregistered").textContent).toContain("×3");
  });

  it("negative control: one raise carries no count at all", async () => {
    // Without this, the case above would pass over a row that rendered a count on
    // every banner, and "×1" would be noise on the common case.
    const container = renderSession(memoryStore());
    await waitFor(() => {
      expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
    });

    await pressDetach(container);

    expect(bannerRows(container)).toHaveLength(1);
    expect(rowCarrying(container, "wire-unregistered").textContent).not.toContain("×");
  });

  it("keeps a surviving banner's own node when another is dismissed", async () => {
    // Keyed by array position, dismissing the first banner renumbered the rest: React
    // unmounted and remounted rows nobody had touched, which loses focus from the
    // dismiss control a person is tabbing through and re-announces the row.
    const container = renderSession(new UiStateStore({ adapter: new RejectingWriteAdapter() }));
    await waitFor(() => {
      expect(container.querySelector("[data-detach='timeline']")).not.toBeNull();
    });
    // The failing store raises its own refusal on the arrangement the restore opened.
    await waitFor(() => {
      expect(bannerRows(container).length).toBeGreaterThan(0);
    });
    await pressDetach(container);
    const raisedCount = bannerRows(container).length;
    // The store refuses the deck's arrangement and the sidebar's in different words,
    // so this column carries more than the two the case strictly needs.
    expect(raisedCount).toBeGreaterThan(1);

    const survivor = rowCarrying(container, "wire-unregistered");
    const dismissed = bannerRows(container).find((row) => row !== survivor);
    expect(dismissed).toBeDefined();
    if (dismissed !== undefined) {
      await dismiss(dismissed);
    }

    expect(bannerRows(container)).toHaveLength(raisedCount - 1);
    // The same element, not one carrying the same words: a remount is what the old
    // position key caused, and it is invisible in the markup.
    expect(rowCarrying(container, "wire-unregistered")).toBe(survivor);
  });
});
