// What makes the mounted-folders list read again, and what it offers when a read refused.
//
// Split from `MountedFoldersBlock.test.tsx`, which covers what the block renders. These cases
// are about behavior over time (which signals reach the refresh chokepoint, and whether a
// refusal ends the conversation) and drive the block through the harness in
// `mounted-folders-block.test-support.tsx`.

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PAST_REFRESH_DEBOUNCE_MS } from "@test/helpers/settle.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { initializedStore } from "@test/helpers/session-store-fixtures.js";
import { MOUNT_A, SESSION_ID } from "./mounted-folders.test-support.js";
import { contextReading, renderSettledBlock } from "./mounted-folders-block.test-support.js";

describe("the page's refresh signals", () => {
  it("re-reads the inventory when the retained session reports a run terminal", async () => {
    // The wire this case pins is the page's: the settings screen resolves the retained
    // session's store, the page hands it to the read, and the read binds it. A page that
    // dropped the member on its way through would still render, and the list would go
    // quietly stale.
    const sessionStore = initializedStore(SESSION_ID);
    const listMethods: string[] = [];
    const context = contextReading({
      mountIds: [MOUNT_A],
      sessionStore,
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { clock, settle } = await renderSettledBlock(context);
    const listReadsBefore = listMethods.filter((method) => method === "workspaceList").length;
    expect(listReadsBefore).toBe(1);

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await settle();
    });

    expect(listMethods.filter((method) => method === "workspaceList")).toHaveLength(2);
  });

  it("re-reads the inventory when the transport comes back", async () => {
    // The third refresh signal, and a different fact from the other two: this window never
    // lost focus and the session never went degraded, but the mount health on screen was
    // read before a gap in the wire.
    const listMethods: string[] = [];
    const reading = contextReading({
      mountIds: [MOUNT_A],
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { settle } = await renderSettledBlock(reading);
    expect(listMethods.filter((method) => method === "workspaceList")).toHaveLength(1);

    await act(async () => {
      // Through the signal's own edge detection, not a direct refresh call: the signal is
      // the one place allowed to decide that a wire went away and came back.
      reading.context.bridge.transportReconnect.observe("unreachable");
      reading.context.bridge.transportReconnect.observe("reachable");
      await settle();
    });

    expect(listMethods.filter((method) => method === "workspaceList")).toHaveLength(2);
  });

  it("negative control: a transport that never went away re-reads nothing", async () => {
    // Without this the case above would hold for a list that re-read on any reachability
    // report, which a live bridge makes on every successful subscribe: a poll under another
    // name.
    const listMethods: string[] = [];
    const reading = contextReading({
      mountIds: [MOUNT_A],
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { settle } = await renderSettledBlock(reading);

    await act(async () => {
      reading.context.bridge.transportReconnect.observe("reachable");
      reading.context.bridge.transportReconnect.observe("reachable");
      await settle();
    });

    expect(listMethods.filter((method) => method === "workspaceList")).toHaveLength(1);
  });

  it("negative control: the same event moves nothing when the window holds no store", async () => {
    // Without this the case above would pass over a page that re-read on any render.
    const sessionStore = initializedStore(SESSION_ID);
    const listMethods: string[] = [];
    const context = contextReading({
      mountIds: [MOUNT_A],
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { clock, settle } = await renderSettledBlock(context);

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await settle();
    });

    expect(listMethods.filter((method) => method === "workspaceList")).toHaveLength(1);
  });
});

describe("the mounts list — a refused read is not the end of it", () => {
  it("re-reads the inventory when the refused arm's control is pressed", async () => {
    // The refresh signals are the session's event stream, window focus and reconnect, so a
    // refusal that clears a moment later would stand on screen until one fired. The control
    // is the way back a person can reach on purpose.
    const { page, settle } = await renderSettledBlock(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: "that node is not attached",
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
    // Without this the case above would hold for a page that drew the control on every arm,
    // offering a re-read beside an inventory that is already current.
    const { page } = await renderSettledBlock(contextReading({ mountIds: [MOUNT_A] }));

    expect(page.querySelector(".meridian-nothing button")).toBeNull();
  });

  it("negative control: a refusal that has not cleared refuses the re-read too", async () => {
    // Without this the first case would hold for a control that cleared the refused arm on
    // press whatever the daemon then said, reporting a recovery that did not happen.
    const { page, settle } = await renderSettledBlock(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: "that node is not attached",
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
