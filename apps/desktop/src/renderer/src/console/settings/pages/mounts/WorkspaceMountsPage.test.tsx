// The mounts page renders both health axes separately, offers no detach, and says
// which session it is reading for.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MOUNT_INVENTORY_READ_CAP } from "../../../core/index.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../../../core/index.js";
import {
  LiveAnnouncer,
  LiveAnnouncerProvider,
  formatClockTime,
  formatDateTime,
} from "../../../primitives/index.js";
import type { SessionStore } from "../../../store/index.js";
import { WorkspaceMountsPage, registerWorkspaceMountsPage } from "./WorkspaceMountsPage.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  eventOfKind,
  initialisedStore,
  mountIdAt,
  mountReadFor,
  workspaceListWith,
} from "./mounts.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../../core/settle.test-support.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";

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
  readonly retainedSessionId?: string | undefined;
  /** The retained session's store, where the window has one open. */
  readonly sessionStore?: SessionStore | undefined;
  /** Counts what the page asked for, so a refresh can be proved rather than assumed. */
  readonly onCall?: (method: string) => void;
  /** Makes the enumerating read reject, which is the list's own refused arm. */
  readonly rejectWith?: { readonly code: string; readonly message: string };
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
              // A wire ENVELOPE and not a bare `Error`: the call door normalizes a
              // rejection into the console's refusal shape, and only an envelope
              // carries a code of its own for it to keep. A bare message would be
              // normalized under the door's own code, which is a different assertion.
              throw options.rejectWith;
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
    retainedSessionId: "retainedSessionId" in options ? options.retainedSessionId : SESSION_ID,
    retainedSessionStore: options.sessionStore,
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
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
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
    expect(chipLabels).toContain("Reachability: unreachable");
    expect(container.textContent ?? "").toContain(`/repos/${MOUNT_A}`);
  });

  it("names the day a mount was last probed, and tells two days apart apart", async () => {
    // The row has no day divider, so a clock-only reading made a probe from last
    // week and one from this morning the same eight characters — and "last probed
    // at" is read precisely to tell how stale the reachability chip is.
    const probedToday = "2026-09-02T10:00:00.000Z";
    const probedLastWeek = "2026-08-26T10:00:00.000Z";
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({
        clock,
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
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({
        clock,
        mountIds: [MOUNT_A, MOUNT_B],
        mountOverrides: {
          [MOUNT_B]: { health: { status: "unreachable", checkedAt: "2026-09-02T10:00:00.000Z" } },
        },
      }),
    );
    expect(container.querySelectorAll(".meridian-mount-list__item")).toHaveLength(2);
  });

  it("says this window has opened no session rather than reading for one", async () => {
    const clock = new ManualClock();
    const { page: container } = await renderSettledPage(
      clock,
      contextReading({ clock, mountIds: [MOUNT_A], retainedSessionId: undefined }),
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
      contextReading({ clock, mountIds: [MOUNT_A] }),
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
      contextReading({ clock, mountIds: [MOUNT_A, MOUNT_B] }),
    );
    expect(politeText()).toBe("Mounts read for this session: 2.");
  });

  it("names the tail it did not open rather than reporting a smaller session", async () => {
    const clock = new ManualClock();
    const overCap = Array.from({ length: MOUNT_INVENTORY_READ_CAP + 3 }, (_unused, index) =>
      mountIdAt(index),
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
      contextReading({
        clock,
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
    const clock = new ManualClock();
    const methodsAsked: string[] = [];
    const { politeText, settle } = await renderSettledPage(
      clock,
      contextReading({
        clock,
        mountIds: [MOUNT_A, MOUNT_B],
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

describe("the page's refresh signals", () => {
  it("re-reads the inventory when the retained session reports a run terminal", async () => {
    // The wire this case pins is the PAGE's: the surface resolves the retained
    // session's store, the page hands it to the read, and the read binds it. A page
    // that dropped the member on its way through would still render, and the list
    // would go quietly stale.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(SESSION_ID);
    const listMethods: string[] = [];
    const context = contextReading({
      clock,
      mountIds: [MOUNT_A],
      sessionStore,
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { settle } = await renderSettledPage(clock, context);
    const listReadsBefore = listMethods.filter((method) => method === "repo.workspaceList").length;
    expect(listReadsBefore).toBe(1);

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore, "run.completed", 1));
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await settle();
    });

    expect(listMethods.filter((method) => method === "repo.workspaceList")).toHaveLength(2);
  });

  it("negative control: the same event moves nothing when the window holds no store", async () => {
    // Without this the case above would pass over a page that re-read on any
    // render, and would prove nothing about which signal reached the read.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(SESSION_ID);
    const listMethods: string[] = [];
    const context = contextReading({
      clock,
      mountIds: [MOUNT_A],
      onCall: (method) => {
        listMethods.push(method);
      },
    });
    const { settle } = await renderSettledPage(clock, context);

    await act(async () => {
      sessionStore.apply(eventOfKind(sessionStore, "run.completed", 1));
      clock.advance(PAST_REFRESH_DEBOUNCE_MS);
      await settle();
    });

    expect(listMethods.filter((method) => method === "repo.workspaceList")).toHaveLength(1);
  });
});
