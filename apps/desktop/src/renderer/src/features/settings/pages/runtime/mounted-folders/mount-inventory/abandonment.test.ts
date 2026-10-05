// What stops the composed inventory read when the page that asked for it has left.
//
// Beside the suite that drives `createMountInventoryRead` and asserts what the page is shown.
// These cases call `readMountInventory` directly and assert what it never does, with replies
// the case settles itself so a departure can land between the calls.

import { describe, expect, it } from "vitest";

import { RefusalError, type Refusal } from "@renderer/lib/refusal/refusal.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { readMountInventory, type MountInventoryCalls } from "./mount-inventory.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  mountReadFor,
  workspaceListWith,
} from "../mounted-folders.test-support.js";

/**
 * The two boundaries inside the composed read, and the departure that lands in one: after
 * the workspace list settles and before the fan-out, and after the fan-out lands and before
 * the rows are folded.
 *
 * Called directly, the difference is the whole settlement (a stop, or an inventory composed
 * for a page that has left); through the model above them the two are indistinguishable.
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
   * Calls that hold both replies, and record what was asked and the signal each received.
   *
   * Each call aborts `line` after its reply settles and before the read resumes, which is
   * the gap a checkpoint exists for; `abandonAfter` names which reply the departure follows,
   * and `undefined` leaves the line live.
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
   * A read that composed an inventory settles here instead of rejecting, and this says so
   * rather than passing quietly.
   */
  async function abandonedRefusalOf(reading: Promise<unknown>): Promise<Refusal> {
    try {
      await reading;
    } catch (rejection) {
      if (rejection instanceof RefusalError) {
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
    // The record shows what the settlement alone cannot: the fan-out was never put.
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
    // The first checkpoint passed with the line live, so this case is about the second.
    expect(asked).toStrictEqual(["workspaceList", "mountRead"]);

    mountRead.serve(mountReadFor(MOUNT_A));

    expect((await abandonedRefusalOf(reading)).code).toBe(READ_ABANDONED);
    // Both calls got the read's own signal, so the departure canceled them in flight rather
    // than being noticed after they settled.
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(line.signal);
    expect(signals[1]).toBe(line.signal);
    expect(line.signal.aborted).toBe(true);
  });
});
