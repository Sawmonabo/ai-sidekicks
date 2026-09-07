// What stops the composed inventory read when the page that asked for it has left.
//
// A FILE OF ITS OWN, beside the suite that reads the inventory through its model.
// That one drives `createMountInventoryRead` and asserts what the page is shown;
// these cases call the composed read directly and assert what it never does. The two
// need different bridges — one that scripts an answer and settles it at once, and one
// that HOLDS both replies so a case can place a departure between them — and a file
// carrying both was one file answering two questions.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, type ConsoleRefusal } from "../../../core/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { readMountInventory } from "./mount-inventory.js";
import {
  MOUNT_A,
  MOUNT_B,
  SESSION_ID,
  mountReadFor,
  workspaceListWith,
} from "./mounts.test-support.js";

/**
 * The two boundaries INSIDE the composed read, and the departure that lands in one.
 *
 * The call door guards its own three points, and this read has two more the door
 * cannot see: the gap after the workspace list settles and before the fan-out starts,
 * and the gap after the fan-out lands and before the rows are folded. An abort in
 * either one reaches no listener the door has left attached — it retires its own the
 * instant a reply wins the race — so the settlement reads `served` while nobody is
 * waiting, one microtask before this frame resumes.
 *
 * DRIVEN AT THE READ'S OWN BOUNDARY rather than through the model above it. The saving
 * a checkpoint buys is work not done, and after the fan-out the two behaviours are
 * indistinguishable from outside the model: with the check the read stops, without it
 * the read folds twelve rows and `PushDrivenRead` discards the answer, and either way
 * nothing is published. Called directly, the difference is the whole settlement — a
 * stop, or an inventory composed for a page that has left.
 */
describe("mount inventory read — the line is abandoned between its own calls", () => {
  /** The registered method that names which mounts the session holds. */
  const WORKSPACE_LIST_METHOD = "repo.workspaceList";

  /** The registered method that answers one mount. */
  const MOUNT_READ_METHOD = "repo.mountRead";

  /** The code the call door raises for a read whose owner has gone. */
  const READ_ABANDONED = "read-abandoned";

  /** A reply this suite settles when it chooses, and the act that settles it. */
  interface HeldReply {
    readonly promise: Promise<unknown>;
    readonly serve: (value: unknown) => void;
  }

  function heldReply(): HeldReply {
    let serve: (value: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve) => {
      serve = resolve;
    });
    return { promise, serve };
  }

  /**
   * A bridge that HOLDS both registered replies, and the record of what it was asked.
   *
   * Distinct from the suite's other builder above, which scripts an answer and settles
   * it at once: these cases place the departure relative to a settlement, so the
   * settlement has to be the case's own act rather than the bridge's.
   */
  function bridgeHolding(
    workspaceList: Promise<unknown>,
    mountRead: Promise<unknown>,
  ): { bridge: ConsoleBridge; calls: string[] } {
    const calls: string[] = [];
    const bridge = {
      source: "fixture",
      sidekicks: {
        daemon: {
          call: (method: string): Promise<unknown> => {
            calls.push(method);
            return method === WORKSPACE_LIST_METHOD ? workspaceList : mountRead;
          },
        },
      },
    } as unknown as ConsoleBridge;
    return { bridge, calls };
  }

  /**
   * Abandon `line` one microtask behind `settlement`, which is exactly the gap.
   *
   * Registered AFTER the read has started, so the door's own handler on that same
   * promise runs first and the door still sees a live line — it serves, and the
   * composed read's own boundary is the one left to stop it. Queued one turn deeper
   * because the door spends a turn resuming and returning its parsed reply; abort in
   * the same turn and the door's own post-race check answers instead, which is a
   * different claim and one its suite already makes.
   */
  function abandonBehind(settlement: Promise<unknown>, line: AbortController): void {
    void settlement.then(() => {
      queueMicrotask(() => {
        line.abort();
      });
    });
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
    const workspaceList = heldReply();
    const mountRead = heldReply();
    const { bridge, calls } = bridgeHolding(workspaceList.promise, mountRead.promise);

    const reading = readMountInventory(bridge, SESSION_ID, line.signal);
    abandonBehind(workspaceList.promise, line);
    workspaceList.serve(workspaceListWith([MOUNT_A, MOUNT_B]));

    expect((await abandonedRefusalOf(reading)).code).toBe(READ_ABANDONED);
    // The claim the record makes and the settlement alone cannot: the fan-out was
    // never put. Two mounts were named and neither was asked for.
    expect(calls).toStrictEqual([WORKSPACE_LIST_METHOD]);
  });

  it("folds no rows when the line is abandoned after the fan-out lands", async () => {
    const line = new AbortController();
    const workspaceList = heldReply();
    const mountRead = heldReply();
    const { bridge, calls } = bridgeHolding(workspaceList.promise, mountRead.promise);

    const reading = readMountInventory(bridge, SESSION_ID, line.signal);
    workspaceList.serve(workspaceListWith([MOUNT_A]));
    await crossMacrotaskBoundary();
    // The first checkpoint passed with the line live, so this case is about the
    // second one and cannot be satisfied by the first.
    expect(calls).toStrictEqual([WORKSPACE_LIST_METHOD, MOUNT_READ_METHOD]);

    abandonBehind(mountRead.promise, line);
    mountRead.serve(mountReadFor(MOUNT_A));

    expect((await abandonedRefusalOf(reading)).code).toBe(READ_ABANDONED);
  });

  it("negative control: the same interleaving on a live line composes the inventory", async () => {
    // Without this both cases above would hold over a read that refused every pass,
    // and the checkpoints would be indistinguishable from a broken fan-out.
    const workspaceList = heldReply();
    const mountRead = heldReply();
    const { bridge, calls } = bridgeHolding(workspaceList.promise, mountRead.promise);

    const reading = readMountInventory(bridge, SESSION_ID, new AbortController().signal);
    workspaceList.serve(workspaceListWith([MOUNT_A]));
    await crossMacrotaskBoundary();
    mountRead.serve(mountReadFor(MOUNT_A));

    const inventory = await reading;
    expect(inventory.readings.map((row) => row.kind)).toStrictEqual(["read"]);
    expect(calls).toStrictEqual([WORKSPACE_LIST_METHOD, MOUNT_READ_METHOD]);
  });
});
