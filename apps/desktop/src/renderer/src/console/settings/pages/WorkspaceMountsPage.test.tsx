// The mounts page renders both health axes separately, offers no detach, and says
// which session it is reading for.

import type { RepoMountReadResponse, WorkspaceListResponse } from "@ai-sidekicks/contracts";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MOUNT_INVENTORY_READ_CAP } from "../../collaboration/constants.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../../core/index.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../../primitives/index.js";
import { WorkspaceMountsPage, registerWorkspaceMountsPage } from "./WorkspaceMountsPage.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../settings-page-registry.js";

function workspaceListWith(mountIds: readonly string[]): WorkspaceListResponse {
  return {
    workspaces: mountIds.map((repoMountId, index) => ({
      id: `workspace-${String(index)}` as WorkspaceListResponse["workspaces"][number]["id"],
      repoMountId: repoMountId as WorkspaceListResponse["workspaces"][number]["repoMountId"],
      executionMode: "worktree",
      state: "ready",
    })),
  };
}

function mountReadFor(
  repoMountId: string,
  overrides: Partial<RepoMountReadResponse> = {},
): RepoMountReadResponse {
  return {
    id: repoMountId as RepoMountReadResponse["id"],
    sessionId: "session-1" as RepoMountReadResponse["sessionId"],
    nodeId: "node-1" as RepoMountReadResponse["nodeId"],
    localPath: `/repos/${repoMountId}`,
    canonicalRoot: `/repos/${repoMountId}`,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-09-02T10:00:00.000Z" },
    attachedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * A settings context whose bridge answers the two registered reads on a clock the
 * test owns.
 *
 * The clock rides `scenarioEngine`, which is where the page looks for one: a
 * fixture bridge supplies the story's clock and a live bridge supplies none, and
 * this test drives the same resolution rather than reaching around it. Without it
 * the page builds a `RealClock` and the read's coalescing window becomes a real
 * timer nothing here can advance.
 */
function contextReading(options: {
  readonly clock: ManualClock;
  readonly mountIds: readonly string[];
  readonly mountOverrides?: Readonly<Record<string, Partial<RepoMountReadResponse>>>;
  readonly activeSessionId?: string | undefined;
  /** Counts what the page asked for, so a refresh can be proved rather than assumed. */
  readonly onCall?: (method: string) => void;
  /** Makes the enumerating read reject, which is the list's own refused arm. */
  readonly rejectWith?: string;
}): SettingsPageContext {
  return {
    bridge: {
      source: "fixture",
      scenarioEngine: { clock: options.clock },
      sidekicks: {
        daemon: {
          call: async (method: string, request: unknown): Promise<unknown> => {
            options.onCall?.(method);
            if (options.rejectWith !== undefined) {
              throw new Error(options.rejectWith);
            }
            if (method === "repo.workspaceList") {
              return workspaceListWith(options.mountIds);
            }
            const { repoMountId } = request as { repoMountId: string };
            return mountReadFor(repoMountId, options.mountOverrides?.[repoMountId] ?? {});
          },
        },
      },
    },
    openSection: () => undefined,
    activeSessionId: "activeSessionId" in options ? options.activeSessionId : "session-1",
  } as unknown as SettingsPageContext;
}

/**
 * Mount, advance past the coalescing window, and let the two chained reads settle.
 *
 * The read itself is the real one and only the wire is a stand-in. Settling is one
 * turn of the macrotask queue rather than a counted run of microtask flushes,
 * because the number of ticks a fan-out takes is a function of how many mounts the
 * fixture named.
 */
/** The page's own element, so a case never reads the announcer's regions by accident. */
function mountsPageOf(root: HTMLElement): HTMLElement {
  const page = root.querySelector<HTMLElement>(".meridian-settings-page");
  if (page === null) {
    throw new Error("the mounts page did not render");
  }
  return page;
}

async function renderSettledPage(
  clock: ManualClock,
  context: SettingsPageContext,
): Promise<{
  readonly page: HTMLElement;
  readonly politeText: () => string;
  readonly settle: () => Promise<void>;
}> {
  // One announcer, on the page's own frozen clock — the resolution `AppFrame` makes
  // in a window. A second time base here would make "was it said again" a question
  // about the runner rather than about the read.
  const announcer = new LiveAnnouncer({ clock });
  const { container } = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <WorkspaceMountsPage context={context} />
    </LiveAnnouncerProvider>,
  );
  const settle = async (): Promise<void> => {
    await act(async () => {
      clock.advance(500);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  };
  await settle();
  return {
    page: mountsPageOf(container),
    politeText: () => container.querySelector('[data-live-region="polite"]')?.textContent ?? "",
    settle,
  };
}

describe("workspace mounts page", () => {
  it("renders the mount's path and both health axes, never folded together", async () => {
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({
        clock,
        mountIds: ["mount-a"],
        mountOverrides: {
          "mount-a": { health: { status: "unreachable", checkedAt: "2026-09-02T10:00:00.000Z" } },
        },
      }),
    );
    const chipLabels = [...container.querySelectorAll(".meridian-chip__label")].map(
      (element) => element.textContent ?? "",
    );
    expect(chipLabels).toContain("Attachment: attached");
    expect(chipLabels).toContain("Reachability: unreachable");
    expect(container.textContent ?? "").toContain("/repos/mount-a");
  });

  it("keeps an unreachable mount listed rather than hiding it", async () => {
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({
        clock,
        mountIds: ["mount-a", "mount-b"],
        mountOverrides: {
          "mount-b": { health: { status: "unreachable", checkedAt: "2026-09-02T10:00:00.000Z" } },
        },
      }),
    );
    expect(container.querySelectorAll(".meridian-mount-list__item")).toHaveLength(2);
  });

  it("says the address names no session rather than reading for one", async () => {
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: ["mount-a"], activeSessionId: undefined }),
    );
    expect(container.textContent ?? "").toContain("Mounts belong to a session");
    expect(container.querySelector(".meridian-mount-list")).toBeNull();
  });

  it("reports an empty session as empty and not as unread", async () => {
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: [] }),
    );
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.textContent ?? "").toContain("mounted no repositories");
  });

  it("offers no detach control and no control at all on a row", async () => {
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: ["mount-a"] }),
    );
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
    const clock = new ManualClock();
    const { politeText } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: ["mount-a", "mount-b"] }),
    );
    expect(politeText()).toBe("Mounts read for this session: 2.");
  });

  it("names the tail it did not open rather than reporting a smaller session", async () => {
    const clock = new ManualClock();
    const overCap = Array.from(
      { length: MOUNT_INVENTORY_READ_CAP + 3 },
      (_unused, index) => `mount-${String(index).padStart(2, "0")}`,
    );
    const { politeText } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: overCap }),
    );
    expect(politeText()).toBe(
      `Mounts read for this session: ${String(MOUNT_INVENTORY_READ_CAP)}, with 3 more not read.`,
    );
  });

  it("announces a refused read in the words the refusal arrived in", async () => {
    const clock = new ManualClock();
    const { page, politeText } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: ["mount-a"], rejectWith: "that node is not attached" }),
    );
    expect(politeText()).toBe("that node is not attached");
    // The card on screen carries the same words, so the announcement is the spoken
    // half of one fact rather than a second account of it.
    expect(page.textContent ?? "").toContain("that node is not attached");
  });

  it("negative control: a focus refresh finding the same mounts says nothing again", async () => {
    // Without this, a page that announced on every settlement would speak the same
    // sentence every time the window regained focus.
    const clock = new ManualClock();
    const methodsAsked: string[] = [];
    const { politeText, settle } = await renderSettledPage(
      clock,
      contextReading({
        clock,
        mountIds: ["mount-a", "mount-b"],
        onCall: (method) => methodsAsked.push(method),
      }),
    );
    expect(politeText()).toBe("Mounts read for this session: 2.");
    const askedOnFirstRead = methodsAsked.length;

    await act(async () => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      await Promise.resolve();
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
