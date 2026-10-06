// The inventory composes two calls, fails whole when either rejects, and never asks
// for more mounts than its cap.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { MOUNT_INVENTORY_READ_CAP } from "./caps.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { createMountInventoryRead, distinctMountIds, type MountInventoryCalls } from "./read.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  mountIdAt,
  mountReadFor,
  workspaceListWith,
} from "../MountedFolderList.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "#test/helpers/settle.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { initializedStore } from "#test/helpers/session/store/fixtures.js";
import { countStoreListeners } from "#test/helpers/session/store/listeners.js";

/**
 * Let the scheduler's in-flight read settle without advancing the clock.
 *
 * One macrotask turn, not a counted run of microtask flushes: the read awaits a list, then
 * a `Promise.all` over as many mounts as the cap admits, so the tick count depends on the
 * fixture and a counted flush would under-settle on twenty mounts.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Plain stubs for the two calls, and the record of what was asked.
 *
 * The calls are stubbed and the inventory is real, since the composition is what is asserted.
 */
function callsAnswering(options: { readonly mountIds: readonly string[] }): {
  calls: MountInventoryCalls;
  asked: string[];
} {
  const asked: string[] = [];
  const calls: MountInventoryCalls = {
    workspaceList: () => {
      asked.push("workspaceList");
      return Promise.resolve(workspaceListWith(options.mountIds));
    },
    mountRead: (request) => {
      asked.push("mountRead");
      return Promise.resolve(mountReadFor(request.repoMountId));
    },
  };
  return { calls, asked };
}

describe("distinct mount ids", () => {
  it("names each mount once, in a stable order", () => {
    const ids = distinctMountIds(workspaceListWith([MOUNT_B, MOUNT_A, MOUNT_B]));
    expect(ids).toStrictEqual([MOUNT_A, MOUNT_B]);
  });
});

describe("mount inventory read", () => {
  it("reads each distinct mount once, after listing the session's workspaces", async () => {
    const clock = new ManualClock();
    const { calls, asked } = callsAnswering({ mountIds: [MOUNT_A, MOUNT_B, MOUNT_A] });
    const read = createMountInventoryRead({
      calls,
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    expect(asked[0]).toBe("workspaceList");
    expect(asked.filter((call) => call === "mountRead")).toHaveLength(2);
    expect(read.state.kind).toBe("loaded");
    read.dispose();
    expect(clock.pendingCount).toBe(0);
  });

  it("fails the whole read when one mount's call rejects", async () => {
    const clock = new ManualClock();
    const { calls } = callsAnswering({ mountIds: [MOUNT_A, MOUNT_B] });
    const read = createMountInventoryRead({
      calls: {
        ...calls,
        mountRead: (request, signal) =>
          request.repoMountId === MOUNT_B
            ? Promise.reject(new Error("no such mount"))
            : calls.mountRead(request, signal),
      },
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    expect(read.state.kind).toBe("failed");
    read.dispose();
  });

  it("fails the read when the workspace list rejects, naming no partial inventory", async () => {
    const clock = new ManualClock();
    const { calls } = callsAnswering({ mountIds: [MOUNT_A] });
    const read = createMountInventoryRead({
      calls: { ...calls, workspaceList: () => Promise.reject(new Error("transport closed")) },
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    expect(read.state.kind).toBe("failed");
    read.dispose();
  });

  it("stops at the cap and reports how many it did not read", async () => {
    const clock = new ManualClock();
    const mountIds = Array.from({ length: MOUNT_INVENTORY_READ_CAP + 3 }, (_unused, index) =>
      mountIdAt(index),
    );
    const { calls, asked } = callsAnswering({ mountIds });
    const read = createMountInventoryRead({
      calls,
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    const state = read.state;
    expect(asked.filter((call) => call === "mountRead")).toHaveLength(MOUNT_INVENTORY_READ_CAP);
    expect(state.kind === "loaded" ? state.value.unreadMountCount : undefined).toBe(3);
  });
});

/**
 * The refresh signals, bound to the stream the console already has open.
 *
 * Every case drives the real store and signal filter, so a re-read counted here is one a
 * window would perform.
 */
describe("what refreshes the inventory", () => {
  /** A started read over one mount, already settled on its first reading. */
  async function startedRead(sessionStore: SessionStore | undefined): Promise<{
    readonly clock: ManualClock;
    readonly read: ReturnType<typeof createMountInventoryRead>;
    readonly listCallCount: () => number;
  }> {
    const clock = new ManualClock();
    const { calls, asked } = callsAnswering({ mountIds: [MOUNT_A] });
    const read = createMountInventoryRead({ calls, sessionId: SESSION_ID, clock, sessionStore });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    return {
      clock,
      read,
      listCallCount: () => asked.filter((call) => call === "workspaceList").length,
    };
  }

  it("re-reads when a run this session was executing reaches a terminal", async () => {
    const sessionStore = initializedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);
    expect(listCallCount()).toBe(1);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("re-reads when a workspace event changes which mounts this session names", async () => {
    const sessionStore = initializedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "workspace.ready", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("costs one re-read for a burst, never one per event", async () => {
    // Counted, not assumed: three mount-affecting events inside one window are one
    // inventory read after it.
    const sessionStore = initializedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.applyBatch([
      eventOfKind(sessionStore.sessionId, "run.completed", 1),
      eventOfKind(sessionStore.sessionId, "workspace.archived", 2),
      eventOfKind(sessionStore.sessionId, "workspace.ready", 3),
    ]);
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("negative control: an event outside the watched set refreshes nothing", async () => {
    // Without this the cases above would pass over a read that re-read on every store
    // transition, which is a poll.
    const sessionStore = initializedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.starting", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(1);
    read.dispose();
  });

  it("holds no listener on the session's store once disposed", async () => {
    const sessionStore = initializedStore(SESSION_ID);
    const liveListeners = countStoreListeners(sessionStore);
    const { read } = await startedRead(sessionStore);
    expect(liveListeners()).toBe(1);

    read.dispose();

    expect(liveListeners()).toBe(0);
  });
});
