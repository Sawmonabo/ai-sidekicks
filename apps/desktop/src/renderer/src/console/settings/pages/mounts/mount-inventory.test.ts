// The inventory composes two registered reads, settles each mount independently,
// and never asks for more mounts than its cap.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, ManualClock, refuse } from "../../../core/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { MOUNT_INVENTORY_READ_CAP } from "../../../core/index.js";
import type { SessionStore } from "../../../store/index.js";
import { createMountInventoryRead, distinctMountIds } from "./mount-inventory.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  eventOfKind,
  mountIdAt,
  mountReadFor,
  workspaceListWith,
} from "./mounts.test-support.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../../core/settle.test-support.js";
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
 * A bridge whose daemon call answers the two registered methods and records every
 * call it was asked to make.
 *
 * The CALL is stubbed and the inventory is real — the module under test composes
 * the two reads, and that composition is what is being asserted.
 */
function bridgeAnswering(options: {
  readonly mountIds: readonly string[];
  readonly refuseMountIds?: readonly string[];
}): { bridge: ConsoleBridge; calls: { method: string; request: unknown }[] } {
  const calls: { method: string; request: unknown }[] = [];
  const bridge = {
    source: "fixture",
    sidekicks: {
      daemon: {
        call: async (method: string, request: unknown): Promise<unknown> => {
          calls.push({ method, request });
          if (method === "repo.workspaceList") {
            return workspaceListWith(options.mountIds);
          }
          const { repoMountId } = request as { repoMountId: string };
          if (options.refuseMountIds?.includes(repoMountId) === true) {
            throw new ConsoleRefusalError(
              refuse("daemon", "repo.mount_not_found", `No mount ${repoMountId}.`),
            );
          }
          return mountReadFor(repoMountId);
        },
      },
    },
  } as unknown as ConsoleBridge;
  return { bridge, calls };
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
    const { bridge, calls } = bridgeAnswering({ mountIds: [MOUNT_A, MOUNT_B, MOUNT_A] });
    const read = createMountInventoryRead({
      bridge,
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    expect(calls[0]?.method).toBe("repo.workspaceList");
    expect(calls.filter((call) => call.method === "repo.mountRead")).toHaveLength(2);
    expect(read.state.kind).toBe("loaded");
    read.dispose();
    expect(clock.pendingCount).toBe(0);
  });

  it("keeps a refused mount as its own row rather than failing the list", async () => {
    const clock = new ManualClock();
    const { bridge } = bridgeAnswering({
      mountIds: [MOUNT_A, MOUNT_B],
      refuseMountIds: [MOUNT_B],
    });
    const read = createMountInventoryRead({
      bridge,
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    const state = read.state;
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") {
      return;
    }
    expect(state.value.readings.map((reading) => reading.kind)).toStrictEqual(["read", "refused"]);
    const refused = state.value.readings[1];
    expect(refused?.kind === "refused" ? refused.refusal.code : undefined).toBe(
      "repo.mount_not_found",
    );
    read.dispose();
  });

  it("negative control: a failing workspace list fails the whole read", async () => {
    // The per-mount arms above are only meaningful because the LIST has no such
    // arm — there is no partial inventory when nothing named the mounts.
    const clock = new ManualClock();
    const bridge = {
      source: "fixture",
      sidekicks: {
        daemon: {
          call: async (): Promise<unknown> => {
            throw new Error("transport closed");
          },
        },
      },
    } as unknown as ConsoleBridge;
    const read = createMountInventoryRead({
      bridge,
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
    const { bridge, calls } = bridgeAnswering({ mountIds });
    const read = createMountInventoryRead({
      bridge,
      sessionId: SESSION_ID,
      clock,
      sessionStore: undefined,
    });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    const state = read.state;
    expect(calls.filter((call) => call.method === "repo.mountRead")).toHaveLength(
      MOUNT_INVENTORY_READ_CAP,
    );
    expect(state.kind === "loaded" ? state.value.unreadMountCount : undefined).toBe(3);
  });

  it("opens no subscription where this window has no store for the session", async () => {
    // The one honest absence left: no store open means no stream to bind. What must
    // still hold is that nothing is armed behind the page once it leaves.
    const clock = new ManualClock();
    const { bridge } = bridgeAnswering({ mountIds: [MOUNT_A] });
    const read = createMountInventoryRead({
      bridge,
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
    const { bridge, calls } = bridgeAnswering({ mountIds: [MOUNT_A] });
    const read = createMountInventoryRead({ bridge, sessionId: SESSION_ID, clock, sessionStore });
    read.start();
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();
    return {
      clock,
      read,
      listCallCount: () => calls.filter((call) => call.method === "repo.workspaceList").length,
    };
  }

  it("re-reads when a run this session was executing reaches a terminal", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);
    expect(listCallCount()).toBe(1);

    sessionStore.apply(eventOfKind(sessionStore, "run.completed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("re-reads when the mount's own attachment lifecycle moves", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore, "repo.detached", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(2);
    read.dispose();
  });

  it("re-reads when a workspace lifecycle event changes which mounts this session names", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);

    sessionStore.apply(eventOfKind(sessionStore, "workspace.ready", 1));
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
      eventOfKind(sessionStore, "run.completed", 1),
      eventOfKind(sessionStore, "repo.attached", 2),
      eventOfKind(sessionStore, "workspace.ready", 3),
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

    sessionStore.apply(eventOfKind(sessionStore, "run.starting", 1));
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

    sessionStore.apply(eventOfKind(sessionStore, "run.completed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(1);
    read.dispose();
  });

  it("hears nothing more once the page has left", async () => {
    const sessionStore = initialisedStore(SESSION_ID);
    const { clock, read, listCallCount } = await startedRead(sessionStore);
    read.dispose();

    sessionStore.apply(eventOfKind(sessionStore, "run.failed", 1));
    clock.advance(PAST_REFRESH_DEBOUNCE_MS);
    await settle();

    expect(listCallCount()).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });
});
