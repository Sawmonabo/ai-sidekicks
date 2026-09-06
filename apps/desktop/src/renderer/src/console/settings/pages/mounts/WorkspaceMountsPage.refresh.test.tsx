// What makes the mounts page read again, and what it offers when a read refused.
//
// Split from `WorkspaceMountsPage.test.tsx`, which covers what the page RENDERS.
// These two are about the page's behaviour over time — which signals reach the
// refresh chokepoint, and whether a refusal is the end of the conversation — and
// both drive the page through the harness in
// `workspace-mounts-page.test-support.tsx`.

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PAST_REFRESH_DEBOUNCE_MS } from "../../../core/settle.test-support.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { initialisedStore } from "../../../store/session-store-registry.test-support.js";
import { MOUNT_A, SESSION_ID } from "./mounts.test-support.js";
import { contextReading, renderSettledPage } from "./workspace-mounts-page.test-support.js";

describe("the page's refresh signals", () => {
  it("re-reads the inventory when the retained session reports a run terminal", async () => {
    // The wire this case pins is the PAGE's: the surface resolves the retained
    // session's store, the page hands it to the read, and the read binds it. A page
    // that dropped the member on its way through would still render, and the list
    // would go quietly stale.
    const sessionStore = initialisedStore(SESSION_ID);
    const listMethods: string[] = [];
    const context = contextReading({
      mountIds: [MOUNT_A],
      sessionStore,
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { clock, settle } = await renderSettledPage(context);
    const listReadsBefore = listMethods.filter((method) => method === "repo.workspaceList").length;
    expect(listReadsBefore).toBe(1);

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await settle();
    });

    expect(listMethods.filter((method) => method === "repo.workspaceList")).toHaveLength(2);
  });

  it("negative control: the same event moves nothing when the window holds no store", async () => {
    // Without this the case above would pass over a page that re-read on any
    // render, and would prove nothing about which signal reached the read.
    const sessionStore = initialisedStore(SESSION_ID);
    const listMethods: string[] = [];
    const context = contextReading({
      mountIds: [MOUNT_A],
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { clock, settle } = await renderSettledPage(context);

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await settle();
    });

    expect(listMethods.filter((method) => method === "repo.workspaceList")).toHaveLength(1);
  });
});

describe("the mounts list — a refused read is not the end of it", () => {
  it("re-reads the inventory when the refused arm's control is pressed", async () => {
    // The list's three signals are the session's event stream, window focus, and
    // nothing else — so a refusal that clears a moment later stood on screen until
    // one of the two happened to fire. The control is the third way back, and it is
    // the only one a person can reach on purpose.
    const { page, settle } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: { code: "repo.node_not_attached", message: "that node is not attached" },
        rejectionCount: 1,
      }),
    );
    expect(page.textContent ?? "").toContain("that node is not attached");

    await act(async () => {
      page.querySelector<HTMLButtonElement>(".meridian-nothing button")?.click();
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(page.querySelectorAll(".meridian-mount-list__item")).toHaveLength(1);
    expect(page.textContent ?? "").not.toContain("that node is not attached");
  });

  it("negative control: the list offers no such control once it has read", async () => {
    // Without this, the case above would hold for a page that drew the control on
    // every arm — a re-read offered beside an inventory that is already current.
    const { page } = await renderSettledPage(contextReading({ mountIds: [MOUNT_A] }));

    expect(page.querySelector(".meridian-nothing button")).toBeNull();
  });

  it("negative control: a refusal that has not cleared refuses the re-read too", async () => {
    // Without this, the first case would hold for a control that cleared the refused
    // arm on press whatever the daemon then said — reporting a recovery that did not
    // happen, which is worse than the state it replaced.
    const { page, settle } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: { code: "repo.node_not_attached", message: "that node is not attached" },
      }),
    );

    await act(async () => {
      page.querySelector<HTMLButtonElement>(".meridian-nothing button")?.click();
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(page.textContent ?? "").toContain("that node is not attached");
  });
});
