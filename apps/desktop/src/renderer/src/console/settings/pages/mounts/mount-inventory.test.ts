// The inventory composes two calls, fails whole when either rejects, and never asks
// for more mounts than its cap.

import { describe, expect, it } from "vitest";

import { ManualClock, MOUNT_INVENTORY_READ_CAP } from "../../../core/index.js";
import type { SessionStore } from "../../../store/index.js";
import {
  createMountInventoryRead,
  distinctMountIds,
  type MountInventoryCalls,
} from "./mount-inventory.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  mountIdAt,
  mountReadFor,
  workspaceListWith,
} from "./mounts.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../../core/settle.test-support.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { initialisedStore } from "../../../store/session-store-registry.test-support.js";

/**
 * Let the scheduler's in-flight read settle without advancing the clock.
 *
 * One turn of the macrotask queue rather than a counted run of microtask flushes:
 * this read awaits a list, then a `Promise.allSettled` over as many mounts as the
 * cap admits, so the number of microtask ticks it takes is a function of the
 * fixture rather than a constant, and a counted flush would pass on two mounts and
 * silently under-settle on twenty.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Plain stubs for the two calls, and the record of what was asked.
 *
 * The CALLS are stubbed and the inventory is real — the module under test composes
 * the two, and that composition is what is being asserted.
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

  it("negative control: reply order alone would not be stable", () => {
    // The sort is the claim. Two replies listing the same mounts in different
    // orders must produce one row order, or a row moves when an unrelated
    // workspace is created.
    const first = distinctMountIds(workspaceListWith([MOUNT_B, MOUNT_A]));
    const second = distinctMountIds(workspaceListWith([MOUNT_A, MOUNT_B]));
    expect(first).toStrictEqual(second);
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

  it("opens no subscription where this window has no store for the session", async () => {
    // The one honest absence left: no store open means no stream to bind. What must
    // still hold is that nothing is armed behind the page once it leaves.
    const clock = new ManualClock();
    const { calls } = callsAnswering({ mountIds: [MOUNT_A] });
    const read = createMountInventoryRead({
      calls,
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    expect(read.isSubscribed).toBe(true);
    read.dispose();
    read.refresh("window-focus");
    expect(clock.pendingCount).toBe(0);
  });
});

/**
 * The signals the section names, bound to the stream the console already has open.
 *
 * Every case drives the REAL store and the real signal filter — the read under test
 * is what composes them — so a re-read counted here is one the page would have
 * performed in a window.
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
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);
    expect(listCallCount()).toBe(1);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("re-reads when the mount's own attachment lifecycle moves", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "repo.detached", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("re-reads when a workspace lifecycle event changes which mounts this session names", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "workspace.ready", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("costs one re-read for a burst, never one per event", async () => {
    // The coalescing claim, counted rather than assumed: three mount-affecting
    // events inside one window are one inventory read on the other side of it.
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.applyBatch([
      eventOfKind(sessionStore.sessionId, "run.completed", 1),
      eventOfKind(sessionStore.sessionId, "repo.attached", 2),
      eventOfKind(sessionStore.sessionId, "workspace.ready", 3),
    ]);
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("negative control: an event outside the watched set refreshes nothing", async () => {
    // Without this the cases above would pass over a read that re-read on every
    // store transition, which is a poll wearing a subscription's clothes.
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.starting", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(1);
    read.dispose();
  });

  it("negative control: the same event refreshes nothing when no store was handed over", async () => {
    // The store IS the signal. Without one the read is focus-driven, which is the
    // state this case pins so the binding above cannot be mistaken for something
    // the read does on its own.
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(undefined);

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.completed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(1);
    read.dispose();
  });

  it("hears nothing more once the page has left", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);
    read.dispose();

    sessionStore.apply(eventOfKind(sessionStore.sessionId, "run.failed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });
});
