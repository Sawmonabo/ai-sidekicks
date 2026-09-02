// The mounts page renders both health axes separately, offers no detach, and says
// which session it is reading for.

import type { RepoMountReadResponse, WorkspaceListResponse } from "@ai-sidekicks/contracts";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
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
}): SettingsPageContext {
  return {
    bridge: {
      source: "fixture",
      scenarioEngine: { clock: options.clock },
      sidekicks: {
        daemon: {
          call: async (method: string, request: unknown): Promise<unknown> => {
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
async function renderSettledPage(
  clock: ManualClock,
  context: SettingsPageContext,
): Promise<HTMLElement> {
  const { container } = render(<WorkspaceMountsPage context={context} />);
  await act(async () => {
    clock.advance(500);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  return container;
}

describe("workspace mounts page", () => {
  it("renders the mount's path and both health axes, never folded together", async () => {
    const clock = new ManualClock();
    const container = await renderSettledPage(
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
    const container = await renderSettledPage(
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
    const container = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: ["mount-a"], activeSessionId: undefined }),
    );
    expect(container.textContent ?? "").toContain("Mounts belong to a session");
    expect(container.querySelector(".meridian-mount-list")).toBeNull();
  });

  it("reports an empty session as empty and not as unread", async () => {
    const clock = new ManualClock();
    const container = await renderSettledPage(clock, contextReading({ clock, mountIds: [] }));
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.textContent ?? "").toContain("mounted no repositories");
  });

  it("offers no detach control and no control at all on a row", async () => {
    const clock = new ManualClock();
    const container = await renderSettledPage(
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
