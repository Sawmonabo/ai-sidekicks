// The mounts page renders both health axes separately, offers no detach, and says
// which session it is reading for.
//
// The refresh signals and the refused read are the suite next door
// (`WorkspaceMountsPage.refresh.test.tsx`); both drive the page through the harness
// in `workspace-mounts-page.test-support.tsx`.

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LIVE_ANNOUNCEMENT_HOLD_MS, MOUNT_INVENTORY_READ_CAP } from "../../../core/index.js";
import { formatClockTime, formatDateTime } from "../../../primitives/index.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";
import { MOUNT_A, MOUNT_B, mountIdAt } from "./mounts.test-support.js";
import { registerWorkspaceMountsPage } from "./WorkspaceMountsPage.js";
import { contextReading, renderSettledPage } from "./workspace-mounts-page.test-support.js";

describe("workspace mounts page", () => {
  it("renders the mount's path and both health axes, never folded together", async () => {
    const { page: container } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A],
        mountOverrides: {
          [MOUNT_A]: { health: { status: "unreachable", checkedAt: "2026-09-02T10:00:00.000Z" } },
        },
      }),
    );
    const chipLabels = [...container.querySelectorAll(".meridian-chip__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(chipLabels).toContain("Attachment: attached");
    expect(chipLabels).toContain("Health: unreachable");
    expect(container.textContent ?? "").toContain(`/repos/${MOUNT_A}`);
  });

  it("names the day a mount was last probed, and tells two days apart apart", async () => {
    // The row has no day divider, so a clock-only reading made a probe from last
    // week and one from this morning the same eight characters — and "last probed
    // at" is read precisely to tell how stale the reachability chip is.
    const probedToday = "2026-09-02T10:00:00.000Z";
    const probedLastWeek = "2026-08-26T10:00:00.000Z";
    const { page: container } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A, MOUNT_B],
        mountOverrides: {
          [MOUNT_A]: { health: { status: "healthy", checkedAt: probedToday } },
          [MOUNT_B]: { health: { status: "healthy", checkedAt: probedLastWeek } },
        },
      }),
    );
    const readings = [probedToday, probedLastWeek].map(
      (instant) => container.querySelector(`[title="${instant}"]`)?.textContent ?? "",
    );
    expect(readings[0]).toBe(formatDateTime(probedToday));
    expect(readings[1]).not.toBe(readings[0]);
    // Without this the case would pass over two instants that were never a
    // collision, and would prove nothing about which formatter the row reaches for.
    expect(formatClockTime(probedLastWeek)).toBe(formatClockTime(probedToday));
  });

  it("keeps an unreachable mount listed rather than hiding it", async () => {
    const { page: container } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A, MOUNT_B],
        mountOverrides: {
          [MOUNT_B]: { health: { status: "unreachable", checkedAt: "2026-09-02T10:00:00.000Z" } },
        },
      }),
    );
    expect(container.querySelectorAll(".meridian-mount-list__item")).toHaveLength(2);
  });

  it("says this window has opened no session rather than reading for one", async () => {
    const { page: container } = await renderSettledPage(
      contextReading({ mountIds: [MOUNT_A], retainedSessionId: undefined }),
    );
    expect(container.textContent ?? "").toContain("Mounts belong to a session");
    expect(container.querySelector(".meridian-mount-list")).toBeNull();
  });

  it("reports an empty session as empty and not as unread", async () => {
    const { page: container } = await renderSettledPage(contextReading({ mountIds: [] }));
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.textContent ?? "").toContain("mounted no repositories");
  });

  it("offers no detach control and no control at all on a row", async () => {
    const { page: container } = await renderSettledPage(contextReading({ mountIds: [MOUNT_A] }));
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("negative control: the control sweep bites on one detach button", async () => {
    // Without this the assertion above would pass over any tree with no buttons,
    // including one that failed to render rows at all.
    const { container } = render(
      <div>
        <button type="button">Detach</button>
      </div>,
    );
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(1);
  });

  it("claims the mounts section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerWorkspaceMountsPage(registry);
    const descriptor = registry.descriptorFor("mounts");
    expect(descriptor?.label).toBe("Workspace mounts");
    expect(descriptor?.keywords).toContain("repository");
  });
});

describe("workspace mounts page — the read says it landed, once", () => {
  it("announces what was read and how many", async () => {
    const { politeText } = await renderSettledPage(
      contextReading({ mountIds: [MOUNT_A, MOUNT_B] }),
    );
    expect(politeText()).toBe("Mounts read for this session: 2.");
  });

  it("names the tail it did not open rather than reporting a smaller session", async () => {
    const overCap = Array.from({ length: MOUNT_INVENTORY_READ_CAP + 3 }, (_unused, index) =>
      mountIdAt(index),
    );
    const { politeText } = await renderSettledPage(contextReading({ mountIds: overCap }));
    expect(politeText()).toBe(
      `Mounts read for this session: ${String(MOUNT_INVENTORY_READ_CAP)}, with 3 more not read.`,
    );
  });

  it("announces a refused read in the words the refusal arrived in", async () => {
    const { page, politeText } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A],
        rejectWith: { code: "repo.node_not_attached", message: "that node is not attached" },
      }),
    );
    expect(politeText()).toBe("that node is not attached");
    // The card on screen carries the same words, so the announcement is the spoken
    // half of one fact rather than a second account of it.
    expect(page.textContent ?? "").toContain("that node is not attached");
  });

  it("negative control: a focus refresh finding the same mounts says nothing again", async () => {
    // Without this, a page that announced on every settlement would speak the same
    // sentence every time the window regained focus.
    const methodsAsked: string[] = [];
    const { clock, politeText, settle } = await renderSettledPage(
      contextReading({
        mountIds: [MOUNT_A, MOUNT_B],
        onCall: (method) => methodsAsked.push(method),
      }),
    );
    expect(politeText()).toBe("Mounts read for this session: 2.");
    const askedOnFirstRead = methodsAsked.length;

    await act(async () => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      await crossMacrotaskBoundary();
    });
    expect(politeText()).toBe("");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    // The refresh really happened, so the silence is the announcement rule's doing
    // rather than a read that never ran.
    expect(methodsAsked.length).toBeGreaterThan(askedOnFirstRead);
    expect(politeText()).toBe("");
  });
});
