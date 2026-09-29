// What stops the composed inventory read when the page that asked for it has left.
//
// A FILE OF ITS OWN, beside the suite that reads the inventory through its model.
// That one drives `createMountInventoryRead` and asserts what the page is shown;
// these cases call the composed read directly and assert what it never does, with
// calls whose replies the case settles itself so a departure can land between them.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, type ConsoleRefusal } from "@renderer/lib/refusal.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { readMountInventory, type MountInventoryCalls } from "./mount-inventory.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  mountReadFor,
  workspaceListWith,
} from "./mounted-folders.test-support.js";

/**
 * The two boundaries INSIDE the composed read, and the departure that lands in one.
 *
 * The gap after the workspace list settles and before the fan-out starts, and the gap
 * after the fan-out lands and before the rows are folded. Driven at the read's own
 * boundary rather than through the model above it: after the fan-out the two
 * behaviors are indistinguishable from outside the model, but called directly the
 * difference is the whole settlement — a stop, or an inventory composed for a page
 * that has left.
 */
describe("mount inventory read — the line is abandoned between its own calls", () => {
  /** The code the read raises when its owner has gone. */
  const READ_ABANDONED = "read-abandoned";

  /** A reply this suite settles when it chooses, and the act that settles it. */
  interface HeldReply<TValue> {
    readonly promise: Promise<TValue>;
    readonly serve: (value: TValue) => void;
  }

  function heldReply<TValue>(): HeldReply<TValue> {
    let serve: (value: TValue) => void = () => undefined;
    const promise = new Promise<TValue>((resolve) => {
      serve = resolve;
    });
    return { promise, serve };
  }

  /**
   * Calls that HOLD both replies, and the record of what was asked and of the signal
   * each call received.
   *
   * Each call abandons `line` after its reply settles and before the read resumes,
   * which is exactly the gap a checkpoint exists for; `abandonAfter` names which
   * reply the departure follows, and `undefined` leaves the line live.
   */
  function callsHolding(
    workspaceList: Promise<ReturnType<typeof workspaceListWith>>,
    mountRead: Promise<ReturnType<typeof mountReadFor>>,
    line: AbortController,
    abandonAfter: "workspaceList" | "mountRead" | undefined,
  ): { calls: MountInventoryCalls; asked: string[]; signals: AbortSignal[] } {
    const asked: string[] = [];
    const signals: AbortSignal[] = [];
    const calls: MountInventoryCalls = {
      workspaceList: async (_request, signal) => {
        asked.push("workspaceList");
        signals.push(signal);
        const reply = await workspaceList;
        if (abandonAfter === "workspaceList") {
          line.abort();
        }
        return reply;
      },
      mountRead: async (_request, signal) => {
        asked.push("mountRead");
        signals.push(signal);
        const reply = await mountRead;
        if (abandonAfter === "mountRead") {
          line.abort();
        }
        return reply;
      },
    };
    return { calls, asked, signals };
  }

  /**
   * The refusal a stopped read raised, or a failure saying it did not stop.
   *
   * The negative control is built in: a read that composed an inventory settles here
   * rather than rejecting, and this says so instead of passing quietly.
   */
  async function abandonedRefusalOf(reading: Promise<unknown>): Promise<ConsoleRefusal> {
    try {
      await reading;
    } catch (rejection) {
      if (rejection instanceof ConsoleRefusalError) {
        return rejection.refusal;
      }
      throw rejection;
    }
    throw new Error("the inventory read composed a reading instead of stopping");
  }

  it("starts no mount read when the line is abandoned before the fan-out", async () => {
    const line = new AbortController();
    const workspaceList = heldReply<ReturnType<typeof workspaceListWith>>();
    const mountRead = heldReply<ReturnType<typeof mountReadFor>>();
    const { calls, asked } = callsHolding(
      workspaceList.promise,
      mountRead.promise,
      line,
      "workspaceList",
    );

    const reading = readMountInventory(calls, SESSION_ID, line.signal);
    workspaceList.serve(workspaceListWith([MOUNT_A, MOUNT_B]));

    expect((await abandonedRefusalOf(reading)).code).toBe(READ_ABANDONED);
    // The claim the record makes and the settlement alone cannot: the fan-out was
    // never put. Two mounts were named and neither was asked for.
    expect(asked).toStrictEqual(["workspaceList"]);
  });

  it("folds no rows when the line is abandoned after the fan-out lands", async () => {
    const line = new AbortController();
    const workspaceList = heldReply<ReturnType<typeof workspaceListWith>>();
    const mountRead = heldReply<ReturnType<typeof mountReadFor>>();
    const { calls, asked, signals } = callsHolding(
      workspaceList.promise,
      mountRead.promise,
      line,
      "mountRead",
    );

    const reading = readMountInventory(calls, SESSION_ID, line.signal);
    workspaceList.serve(workspaceListWith([MOUNT_A]));
    await crossMacrotaskBoundary();
    // The first checkpoint passed with the line live, so this case is about the
    // second one and cannot be satisfied by the first.
    expect(asked).toStrictEqual(["workspaceList", "mountRead"]);

    mountRead.serve(mountReadFor(MOUNT_A));

    expect((await abandonedRefusalOf(reading)).code).toBe(READ_ABANDONED);
    // Both calls were handed the read's own signal, so the departure cancelled them
    // in flight rather than only being noticed after they settled.
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(line.signal);
    expect(signals[1]).toBe(line.signal);
    expect(line.signal.aborted).toBe(true);
  });

  it("negative control: the same interleaving on a live line composes the inventory", async () => {
    // Without this both cases above would hold over a read that refused every pass,
    // and the checkpoints would be indistinguishable from a broken fan-out.
    const line = new AbortController();
    const workspaceList = heldReply<ReturnType<typeof workspaceListWith>>();
    const mountRead = heldReply<ReturnType<typeof mountReadFor>>();
    const { calls, asked } = callsHolding(
      workspaceList.promise,
      mountRead.promise,
      line,
      undefined,
    );

    const reading = readMountInventory(calls, SESSION_ID, line.signal);
    workspaceList.serve(workspaceListWith([MOUNT_A]));
    await crossMacrotaskBoundary();
    mountRead.serve(mountReadFor(MOUNT_A));

    const inventory = await reading;
    expect(inventory.readings.map((mount) => mount.id)).toStrictEqual([MOUNT_A]);
    expect(asked).toStrictEqual(["workspaceList", "mountRead"]);
  });
});
