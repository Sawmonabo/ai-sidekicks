// What makes the mounted-folders list read again, and what it offers when a read refused.
//
// These cases are about behavior over time (which signals reach the refresh chokepoint, and
// whether a refusal ends the conversation) and drive the block through the harness in
// `MountedFoldersBlock.test-support.tsx`.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MOUNT_A } from "./MountedFolderList.test-support.js";
import { contextReading, renderSettledBlock } from "./MountedFoldersBlock.test-support.js";

describe("the page's refresh signals", () => {
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
});

describe("the mounts list — a refused read is not the end of it", () => {
  it("re-reads the inventory when the refused arm's control is pressed", async () => {
    // The refresh signals are the session's event stream, window focus and reconnect, so a
    // refusal that clears a moment later would stand on screen until one fired. The control
    // is the way back a person can reach on purpose.
    const { page, settle } = await renderSettledBlock(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: "that folder is not attached",
        rejectionCount: 1,
      }),
    );
    expect(page.textContent ?? "").toContain("that folder is not attached");

    await act(async () => {
      within(page).getByRole("button", { name: "Try again" }).click();
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(page.querySelectorAll(".meridian-mount-list__item")).toHaveLength(1);
    expect(page.textContent ?? "").not.toContain("that folder is not attached");
  });

  it("negative control: a refusal that has not cleared refuses the re-read too", async () => {
    // Without this the first case would hold for a control that cleared the refused arm on
    // press whatever the daemon then said, reporting a recovery that did not happen.
    const { page, settle } = await renderSettledBlock(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: "that folder is not attached",
      }),
    );

    await act(async () => {
      within(page).getByRole("button", { name: "Try again" }).click();
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(page.textContent ?? "").toContain("that folder is not attached");
  });
});
