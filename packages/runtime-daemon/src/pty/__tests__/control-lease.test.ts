// One shell's control lease held by devices: racing takes and first writes, forced takes, holds
// bound to the connections and pane output subscriptions that took them, failed broadcasts, and
// the write, resize and close checks. Every broadcast is parsed against the wire schema, so a
// contradictory change fails the act that sent it.

import { describe, expect, it } from "vitest";

import { registerSessionTakeControl } from "../../ipc/handlers/session/take-control.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { type ShellLeaseCaller, ShellControlLease } from "../control-lease.js";

import {
  SESSION_ID,
  TERMINAL_ID,
  OTHER_TERMINAL_ID,
  MACHINE,
  LAPTOP,
  PHONE,
  RUN_A,
  RUN_B,
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  openLease,
  refusalOf,
  inVersionOrder,
  paneOn,
  IDLE,
  WRITE,
  NOT_HELD,
  heldByDevice,
} from "./control-lease.test-support.js";

describe("ShellControlLease", () => {
  it("lets exactly one of two racing takes win, and refuses the loser's writes", async () => {
    const { lease, changes } = openLease();
    const registry = new MethodRegistryImpl();
    registerSessionTakeControl(registry, { findShellLease: () => lease });
    const takeThrough = (pane: ShellLeaseCaller): Promise<unknown> =>
      registry.dispatch(
        "session.takeControl",
        {
          sessionId: SESSION_ID,
          terminalId: TERMINAL_ID,
          outputSubscriptionId: pane.outputSubscriptionId,
        },
        { deviceId: pane.deviceId, transportId: pane.transportId },
      );

    const outcomes = await Promise.allSettled([
      takeThrough(paneOn(LAPTOP, 1)),
      takeThrough(paneOn(PHONE, 2)),
    ]);

    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = outcomes[0]?.status === "fulfilled" ? LAPTOP : PHONE;
    const loser = winner === LAPTOP ? PHONE : LAPTOP;
    const winnerConnection = winner === LAPTOP ? 1 : 2;
    expect(won[0]?.value).toEqual({ terminalId: TERMINAL_ID, holderDeviceId: winner });
    expect(lost[0]?.reason).toMatchObject(heldByDevice(winner));
    expect(changes).toEqual(
      inVersionOrder([
        {
          sessionId: SESSION_ID,
          terminalId: TERMINAL_ID,
          holderDeviceId: winner,
          previousHolderDeviceId: null,
          reason: "taken",
        },
      ]),
    );
    await expect(
      lease.admitWrite({ kind: "device", ...paneOn(loser, 9) }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);
    await lease.admitWrite({ kind: "device", ...paneOn(winner, winnerConnection) }, WRITE);

    // A call with no connection to end the lease with never takes the shell.
    const request = {
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      outputSubscriptionId: paneOn(LAPTOP, 1).outputSubscriptionId,
    };
    await expect(registry.dispatch("session.takeControl", request, {})).rejects.toThrow(
      "session.takeControl needs the calling device and its connection",
    );
    expect(changes).toHaveLength(1);
  });

  it("undoes a take whose broadcast throws before returning a promise", async () => {
    let isThrowing = false;
    const lease = new ShellControlLease({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      machineDeviceId: MACHINE,
      broadcast: (): Promise<void> => {
        if (isThrowing) {
          throw new Error("the event log is unavailable");
        }
        return Promise.resolve();
      },
    });
    await lease.take(paneOn(LAPTOP, 1), false);
    isThrowing = true;
    await expect(lease.take(paneOn(PHONE, 2), true)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    isThrowing = false;
    await lease.take(paneOn(PHONE, 2), true);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
  });

  it("moves a shell off another device only by force, refusing the displaced writes", async () => {
    const { lease, changes } = openLease();
    await lease.take(paneOn(LAPTOP, 1), false);

    await expect(lease.take(paneOn(PHONE, 2), false)).rejects.toMatchObject(heldByDevice(LAPTOP));
    await expect(lease.take(paneOn(PHONE, 2), true)).resolves.toEqual({
      terminalId: TERMINAL_ID,
      holderDeviceId: PHONE,
    });

    await expect(
      lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);
    await lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, WRITE);
    // The displaced connection ending no longer touches a hold it lost.
    await lease.releaseConnection(1);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
    expect(changes.at(-1)).toEqual({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      holderDeviceId: PHONE,
      previousHolderDeviceId: LAPTOP,
      reason: "taken_by_force",
      leaseVersion: 2,
    });
    expect(changes).toHaveLength(2);
  });

  it("lets only the connections that took a shell write to it, giving it back once all have ended", async () => {
    const first = openLease(TERMINAL_ID);
    const second = openLease(OTHER_TERMINAL_ID);
    await first.lease.take(paneOn(LAPTOP, 1), false);
    await second.lease.take(paneOn(PHONE, 2), false);

    // Another connection of the holding device neither writes to the shell nor sizes it, and its
    // refused write takes nothing.
    const laptopSecondConnection = paneOn(LAPTOP, 3);
    await expect(
      first.lease.admitWrite({ kind: "device", ...laptopSecondConnection }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);
    expect(refusalOf(() => first.lease.admitResize(laptopSecondConnection))).toMatchObject(
      NOT_HELD,
    );
    first.lease.admitResize(paneOn(LAPTOP, 1));

    // Its take binds it with no broadcast, and it keeps the hold through the first connection's
    // end, which ends that connection's writes.
    await expect(first.lease.take(laptopSecondConnection, true)).resolves.toEqual({
      terminalId: TERMINAL_ID,
      holderDeviceId: LAPTOP,
    });
    expect(first.changes).toHaveLength(1);
    first.lease.admitResize(laptopSecondConnection);
    for (const { lease } of [first, second]) {
      await lease.releaseConnection(1);
    }
    expect(first.lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    await expect(
      first.lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);
    await first.lease.admitWrite({ kind: "device", ...laptopSecondConnection }, WRITE);

    for (const { lease } of [first, second]) {
      await lease.releaseConnection(3);
    }
    expect(first.lease.holder()).toBeNull();
    expect(second.lease.holder()).toEqual({ holderDeviceId: PHONE });
    expect(first.changes).toEqual(
      inVersionOrder([
        {
          sessionId: SESSION_ID,
          terminalId: TERMINAL_ID,
          holderDeviceId: LAPTOP,
          previousHolderDeviceId: null,
          reason: "taken",
        },
        {
          sessionId: SESSION_ID,
          terminalId: TERMINAL_ID,
          holderDeviceId: null,
          previousHolderDeviceId: LAPTOP,
          reason: "auto_released_disconnect",
        },
      ]),
    );
    expect(second.changes).toHaveLength(1);
  });

  it("undoes a take whose broadcast fails, never a release, one change at a time", async () => {
    let isBroadcastFailing = true;
    let pendingBroadcast: Promise<void> | undefined;
    const lease = new ShellControlLease({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      machineDeviceId: MACHINE,
      // The next broadcast waits on a pending one when a case sets it, and only that broadcast.
      broadcast: async () => {
        const pending = pendingBroadcast;
        pendingBroadcast = undefined;
        if (pending !== undefined) {
          return pending;
        }
        if (isBroadcastFailing) {
          throw new Error("the event log is unavailable");
        }
      },
    });

    await expect(lease.take(paneOn(LAPTOP, 1), false)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toBeNull();
    // The undo raises the version again, so a holder read now is newer than the change that failed.
    expect(lease.leaseVersion()).toBe(2);
    // A first write's take is undone the same way, and the write never lands.
    await expect(lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, WRITE)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toBeNull();

    isBroadcastFailing = false;
    await lease.take(paneOn(LAPTOP, 1), false);
    isBroadcastFailing = true;
    await expect(lease.take(paneOn(PHONE, 2), true)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    await lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, WRITE);

    // A connection joining a hold whose broadcast is still pending fails with it, and the undo
    // drops the joined connection along with the hold.
    let failPendingBroadcast = (): void => undefined;
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const forcedTake = lease.take(paneOn(PHONE, 2), true);
    const joiningTake = lease.take(paneOn(PHONE, 5), false);
    failPendingBroadcast();
    await expect(forcedTake).rejects.toThrow("the event log is unavailable");
    await expect(joiningTake).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    isBroadcastFailing = false;
    await lease.releaseConnection(5);
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    await lease.take(paneOn(PHONE, 2), true);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });

    // A run's move to its new command is undone the same way.
    await lease.releaseConnection(2);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    isBroadcastFailing = true;
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_B }, IDLE)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_A, holderCommandId: COMMAND_A });

    // A release whose broadcast fails still stands, and its failure reaches the caller.
    await expect(lease.releaseRun(RUN_A)).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toBeNull();

    // A run's failed take off a device leaves the device holding and nothing kept aside; a
    // hand-back whose broadcast fails leaves nobody holding, never an unannounced device, and a
    // write or take the device joined to it fails with it.
    isBroadcastFailing = false;
    await lease.take(paneOn(LAPTOP, 1), false);
    isBroadcastFailing = true;
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    isBroadcastFailing = false;
    await lease.releaseConnection(1);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    expect(lease.holder()).toBeNull();
    await lease.take(paneOn(LAPTOP, 1), false);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const handBack = lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    // The release settles before it acts, so the joins wait, a bounded few ticks, until it has
    // handed the shell back.
    for (let tick = 0; tick < 10 && lease.holder()?.holderRunId !== undefined; tick++) {
      await Promise.resolve();
    }
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    const takeJoiningHandBack = lease.take(paneOn(LAPTOP, 4), false);
    const writeJoiningHandBack = lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, WRITE);
    failPendingBroadcast();
    await expect(handBack).rejects.toThrow("the event log is unavailable");
    await expect(takeJoiningHandBack).rejects.toThrow("the event log is unavailable");
    await expect(writeJoiningHandBack).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toBeNull();
    isBroadcastFailing = true;

    // The same command's retake joins a pending run take and fails with it.
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const runTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const joiningRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    failPendingBroadcast();
    await expect(runTake).rejects.toThrow("the event log is unavailable");
    await expect(joiningRunTake).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toBeNull();

    // A release that arrives while a take is in flight applies to the holder that take leaves, so a
    // failed take never brings back a run that has gone idle or a connection that has ended.
    isBroadcastFailing = false;
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const otherRunTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
    const idleRelease = lease.releaseRun(RUN_A);
    failPendingBroadcast();
    await expect(otherRunTake).rejects.toThrow("the event log is unavailable");
    await idleRelease;
    expect(lease.holder()).toBeNull();
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const nextCommandTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    const commandEnd = lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    failPendingBroadcast();
    await expect(nextCommandTake).rejects.toThrow("the event log is unavailable");
    await commandEnd;
    expect(lease.holder()).toBeNull();

    await lease.take(paneOn(LAPTOP, 1), false);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const forcedPhoneTake = lease.take(paneOn(PHONE, 2), true);
    const laptopGone = lease.releaseConnection(1);
    failPendingBroadcast();
    await expect(forcedPhoneTake).rejects.toThrow("the event log is unavailable");
    await laptopGone;
    expect(lease.holder()).toBeNull();

    // A device's write joining its own pending take fails with it, a run's write joining its run's
    // pending take does the same, and another device's write waits for the take to settle and
    // then takes the shell the undo left free.
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const laptopPendingTake = lease.take(paneOn(LAPTOP, 1), false);
    const joiningWrite = lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, WRITE);
    const otherDeviceWrite = lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, WRITE);
    failPendingBroadcast();
    await expect(laptopPendingTake).rejects.toThrow("the event log is unavailable");
    await expect(joiningWrite).rejects.toThrow("the event log is unavailable");
    await otherDeviceWrite;
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
    await lease.releaseConnection(2);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const pendingRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const runWrite = lease.admitWrite({ kind: "run", runId: RUN_A }, WRITE);
    failPendingBroadcast();
    await expect(pendingRunTake).rejects.toThrow("the event log is unavailable");
    await expect(runWrite).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toBeNull();
    await lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, WRITE);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
    await lease.releaseConnection(2);

    // A take that arrives while another is in flight decides on the holder that one leaves, so the
    // failed take's undo never wipes it out.
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const laptopTake = lease.take(paneOn(LAPTOP, 1), false);
    const phoneTake = lease.take(paneOn(PHONE, 2), true);
    failPendingBroadcast();
    await expect(laptopTake).rejects.toThrow("the event log is unavailable");
    await phoneTake;
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });

    await lease.releaseConnection(2);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const firstRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const secondRunTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
    failPendingBroadcast();
    await expect(firstRunTake).rejects.toThrow("the event log is unavailable");
    await secondRunTake;
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_B, holderCommandId: COMMAND_B });
  });

  it("ends a hold when the pane output subscription it was taken through closes, and only its own", async () => {
    const first = openLease(TERMINAL_ID);
    const second = openLease(OTHER_TERMINAL_ID);
    // One connection holds both shells, each through its pane's own output subscription to it.
    const firstShellPane = paneOn(LAPTOP, 1);
    const secondShellPane = paneOn(LAPTOP, 1, 1);
    await first.lease.take(firstShellPane, false);
    await second.lease.take(secondShellPane, false);

    // One subscription closing ends the hold taken through it alone, its connection still open.
    for (const { lease } of [first, second]) {
      await lease.releaseSubscription(secondShellPane.outputSubscriptionId);
    }
    expect(first.lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    expect(second.lease.holder()).toBeNull();
    expect(second.changes.at(-1)).toEqual({
      sessionId: SESSION_ID,
      terminalId: OTHER_TERMINAL_ID,
      holderDeviceId: null,
      previousHolderDeviceId: LAPTOP,
      reason: "auto_released_pane_closed",
      leaseVersion: 2,
    });
    expect(first.changes).toHaveLength(1);

    // A hold another connection of the device joined through its own pane outlives the first
    // pane's close, which ends the first connection's writes, and ends with the last pane.
    const otherConnectionPane = paneOn(LAPTOP, 3);
    await first.lease.take(otherConnectionPane, false);
    await first.lease.releaseSubscription(firstShellPane.outputSubscriptionId);
    expect(first.lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    await expect(
      first.lease.admitWrite({ kind: "device", ...firstShellPane }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);
    await first.lease.admitWrite({ kind: "device", ...otherConnectionPane }, WRITE);
    await first.lease.releaseSubscription(otherConnectionPane.outputSubscriptionId);
    expect(first.lease.holder()).toBeNull();
    expect(first.changes.map((change) => change.reason)).toEqual([
      "taken",
      "auto_released_pane_closed",
    ]);
  });

  it("gives a shell nobody holds to the first device that writes to it, exactly one of two", async () => {
    const { lease, changes } = openLease();
    await expect(lease.admitWrite({ kind: "run", runId: RUN_A }, WRITE)).rejects.toMatchObject(
      NOT_HELD,
    );
    expect(refusalOf(() => lease.admitResize(paneOn(LAPTOP, 1)))).toMatchObject(NOT_HELD);
    lease.admitClose(LAPTOP, false);

    // Two devices' first keystrokes in one tick: one takes the shell and its write goes through,
    // the other's is refused and never handed on, and the winner's next write goes through.
    const handedOn: string[] = [];
    const outcomes = await Promise.allSettled([
      lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, () => {
        handedOn.push("laptop's first");
      }),
      lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, () => {
        handedOn.push("phone's first");
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    await lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, () => {
      handedOn.push("laptop's second");
    });
    expect(handedOn).toEqual(["laptop's first", "laptop's second"]);
    expect(outcomes[1]?.status === "rejected" ? outcomes[1].reason : undefined).toMatchObject(
      NOT_HELD,
    );
    expect(changes).toEqual(
      inVersionOrder([
        {
          sessionId: SESSION_ID,
          terminalId: TERMINAL_ID,
          holderDeviceId: LAPTOP,
          previousHolderDeviceId: null,
          reason: "taken",
        },
      ]),
    );

    // The take belongs to the writing connection, so that connection's end gives the shell back.
    await lease.releaseConnection(1);
    expect(lease.holder()).toBeNull();
    await lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, WRITE);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
    await lease.releaseConnection(2);

    await lease.take(paneOn(LAPTOP, 1), false);
    expect(refusalOf(() => lease.admitResize(paneOn(PHONE, 2)))).toMatchObject(
      heldByDevice(LAPTOP),
    );
    expect(refusalOf(() => lease.admitClose(PHONE, false))).toMatchObject(heldByDevice(LAPTOP));
    lease.admitResize(paneOn(LAPTOP, 1));
    lease.admitClose(LAPTOP, false);
    lease.admitClose(PHONE, true);
  });
});
