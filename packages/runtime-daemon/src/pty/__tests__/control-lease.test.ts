// One shell's control lease held by devices: racing takes and first writes, forced takes, holds
// bound to the connections and pane output subscriptions that took or typed into them, failed
// broadcasts, and the write, resize and close checks. Every broadcast is parsed against the wire
// schema, so a contradictory change fails the act that sent it.

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
  openUnreliableLease,
  LOG_UNAVAILABLE,
  holderOf,
  untilTicked,
  inVersionOrder,
  paneOn,
  IDLE,
  HAND_OFF,
  NOT_HELD,
  heldByDevice,
} from "./control-lease.test-support.js";

describe("ShellControlLease", () => {
  it("lets exactly one of two racing takes win, and refuses the loser's writes", async () => {
    const { lease, changes } = openLease();
    const registry = new MethodRegistryImpl();
    registerSessionTakeControl(registry, {
      shellTable: { leaseForOutputSubscription: () => lease },
    });
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
      lease.admitWrite({ kind: "device", ...paneOn(loser, 9) }, HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await lease.admitWrite({ kind: "device", ...paneOn(winner, winnerConnection) }, HAND_OFF);

    // A call with no connection to end the lease with never takes the shell.
    const request = {
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      outputSubscriptionId: paneOn(LAPTOP, 1).outputSubscriptionId,
    };
    await expect(
      registry.dispatch("session.takeControl", request, { deviceId: LAPTOP }),
    ).rejects.toThrow("session.takeControl needs the calling connection");
    expect(changes).toHaveLength(1);
  });

  it("undoes a take whose broadcast throws before returning a promise", async () => {
    let isThrowing = false;
    const lease = new ShellControlLease({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      machineDeviceId: MACHINE,
      refuseEndedCaller: () => undefined,
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
    expect(await holderOf(lease)).toEqual({ holderDeviceId: LAPTOP });
    isThrowing = false;
    await lease.take(paneOn(PHONE, 2), true);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: PHONE });
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
      lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, HAND_OFF);
    // The displaced connection ending no longer touches a hold it lost.
    await lease.releaseConnection(1);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: PHONE });
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
      first.lease.admitWrite({ kind: "device", ...laptopSecondConnection }, HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await expect(
      first.lease.admitFromHoldingConnection(laptopSecondConnection, HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await first.lease.admitFromHoldingConnection(paneOn(LAPTOP, 1), HAND_OFF);

    // Its take binds it with no broadcast, and it keeps the hold through the first connection's
    // end, which ends that connection's writes.
    await expect(first.lease.take(laptopSecondConnection, true)).resolves.toEqual({
      terminalId: TERMINAL_ID,
      holderDeviceId: LAPTOP,
    });
    expect(first.changes).toHaveLength(1);
    await first.lease.admitFromHoldingConnection(laptopSecondConnection, HAND_OFF);
    for (const { lease } of [first, second]) {
      await lease.releaseConnection(1);
    }
    expect(await holderOf(first.lease)).toEqual({ holderDeviceId: LAPTOP });
    await expect(
      first.lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await first.lease.admitWrite({ kind: "device", ...laptopSecondConnection }, HAND_OFF);

    for (const { lease } of [first, second]) {
      await lease.releaseConnection(3);
    }
    expect(await holderOf(first.lease)).toBeNull();
    expect(await holderOf(second.lease)).toEqual({ holderDeviceId: PHONE });
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

  it("undoes a take whose broadcast fails, raising the version again, and a first write's take", async () => {
    const { lease, setFailing } = openUnreliableLease();
    await expect(lease.take(paneOn(LAPTOP, 1), false)).rejects.toThrow(LOG_UNAVAILABLE);
    // The undo raises the version again, so a holder read now is newer than the change that failed.
    await expect(lease.readHolder()).resolves.toEqual({ holder: null, leaseVersion: 2 });
    // A first write's take is undone the same way, and the write never lands.
    const handedOn: string[] = [];
    await expect(
      lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, () => {
        handedOn.push("laptop's first");
      }),
    ).rejects.toThrow(LOG_UNAVAILABLE);
    expect(handedOn).toEqual([]);
    expect(await holderOf(lease)).toBeNull();

    // A failed forced take leaves the device it would have moved the shell off holding.
    setFailing(false);
    await lease.take(paneOn(LAPTOP, 1), false);
    setFailing(true);
    await expect(lease.take(paneOn(PHONE, 2), true)).rejects.toThrow(LOG_UNAVAILABLE);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: LAPTOP });
    await lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, HAND_OFF);

    // A run's failed take off a device leaves the device holding and nothing kept aside.
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE)).rejects.toThrow(
      LOG_UNAVAILABLE,
    );
    expect(await holderOf(lease)).toEqual({ holderDeviceId: LAPTOP });
    setFailing(false);
    await lease.releaseConnection(1);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    expect(await holderOf(lease)).toBeNull();

    // A run's move to its new command is undone the same way.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    setFailing(true);
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_B }, IDLE)).rejects.toThrow(
      LOG_UNAVAILABLE,
    );
    expect(await holderOf(lease)).toMatchObject({ holderRunId: RUN_A, holderCommandId: COMMAND_A });
  });

  it("lets a release to nobody whose broadcast fails stand, raising the version once", async () => {
    const { lease, setFailing } = openUnreliableLease();
    setFailing(false);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    setFailing(true);
    await expect(lease.releaseRun(RUN_A)).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(lease.readHolder()).resolves.toEqual({ holder: null, leaseVersion: 2 });

    setFailing(false);
    await lease.take(paneOn(LAPTOP, 1), false);
    setFailing(true);
    await expect(
      lease.releaseSubscriptions([paneOn(LAPTOP, 1).outputSubscriptionId]),
    ).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(lease.readHolder()).resolves.toEqual({ holder: null, leaseVersion: 4 });
  });

  it("fails a take or write joining a change in flight with it, dropping what the join bound", async () => {
    const { lease, setFailing, holdNextBroadcast } = openUnreliableLease();
    setFailing(false);
    await lease.take(paneOn(LAPTOP, 1), false);

    // A connection joining a forced take still in flight fails with it, and the undo drops the
    // joined connection along with the hold.
    let held = holdNextBroadcast();
    const forcedTake = lease.take(paneOn(PHONE, 2), true);
    const joiningTake = lease.take(paneOn(PHONE, 5), false);
    held.fail();
    await expect(forcedTake).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(joiningTake).rejects.toThrow(LOG_UNAVAILABLE);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: LAPTOP });
    await lease.releaseConnection(5);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: LAPTOP });

    // A hand-back whose broadcast fails leaves nobody holding, never an unannounced device, and a
    // write or take the device joined to it fails with it.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    held = holdNextBroadcast();
    const handBack = lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    // The release settles before it acts, so the joins wait until it has handed the shell back.
    await untilTicked(held.isStarted);
    const takeJoiningHandBack = lease.take(paneOn(LAPTOP, 4), false);
    const writeJoiningHandBack = lease.admitWrite(
      { kind: "device", ...paneOn(LAPTOP, 1) },
      HAND_OFF,
    );
    held.fail();
    await expect(handBack).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(takeJoiningHandBack).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(writeJoiningHandBack).rejects.toThrow(LOG_UNAVAILABLE);
    expect(await holderOf(lease)).toBeNull();

    // The same command's retake joins a pending run take and fails with it.
    held = holdNextBroadcast();
    const runTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const joiningRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    held.fail();
    await expect(runTake).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(joiningRunTake).rejects.toThrow(LOG_UNAVAILABLE);
    expect(await holderOf(lease)).toBeNull();

    // A device's write joining its own pending take fails with it, and another device's write waits
    // for the take to settle and then takes the shell the undo left free.
    held = holdNextBroadcast();
    const laptopPendingTake = lease.take(paneOn(LAPTOP, 1), false);
    const joiningWrite = lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 1) }, HAND_OFF);
    const otherDeviceWrite = lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, HAND_OFF);
    held.fail();
    await expect(laptopPendingTake).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(joiningWrite).rejects.toThrow(LOG_UNAVAILABLE);
    await otherDeviceWrite;
    expect(await holderOf(lease)).toEqual({ holderDeviceId: PHONE });

    // A run's write joining its run's pending take does the same.
    await lease.releaseConnection(2);
    held = holdNextBroadcast();
    const pendingRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const runWrite = lease.admitWrite({ kind: "run", runId: RUN_A }, HAND_OFF);
    held.fail();
    await expect(pendingRunTake).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(runWrite).rejects.toThrow(LOG_UNAVAILABLE);
    expect(await holderOf(lease)).toBeNull();
  });

  it("decides a take or release that arrives during a change on the holder that change leaves", async () => {
    const { lease, setFailing, holdNextBroadcast } = openUnreliableLease();
    setFailing(false);

    // A release never lets a failed take bring back a run that has gone idle, a command that has
    // ended, or a connection that has ended.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    let held = holdNextBroadcast();
    const otherRunTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
    const idleRelease = lease.releaseRun(RUN_A);
    held.fail();
    await expect(otherRunTake).rejects.toThrow(LOG_UNAVAILABLE);
    await idleRelease;
    expect(await holderOf(lease)).toBeNull();

    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    held = holdNextBroadcast();
    const nextCommandTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    const commandEnd = lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    held.fail();
    await expect(nextCommandTake).rejects.toThrow(LOG_UNAVAILABLE);
    await commandEnd;
    expect(await holderOf(lease)).toBeNull();

    await lease.take(paneOn(LAPTOP, 1), false);
    held = holdNextBroadcast();
    const forcedPhoneTake = lease.take(paneOn(PHONE, 2), true);
    const laptopGone = lease.releaseConnection(1);
    held.fail();
    await expect(forcedPhoneTake).rejects.toThrow(LOG_UNAVAILABLE);
    await laptopGone;
    expect(await holderOf(lease)).toBeNull();

    // A take never has its holder wiped out by the undo of a failed take before it.
    held = holdNextBroadcast();
    const laptopTake = lease.take(paneOn(LAPTOP, 1), false);
    const phoneTake = lease.take(paneOn(PHONE, 2), true);
    held.fail();
    await expect(laptopTake).rejects.toThrow(LOG_UNAVAILABLE);
    await phoneTake;
    expect(await holderOf(lease)).toEqual({ holderDeviceId: PHONE });

    await lease.releaseConnection(2);
    held = holdNextBroadcast();
    const firstRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const secondRunTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
    held.fail();
    await expect(firstRunTake).rejects.toThrow(LOG_UNAVAILABLE);
    await secondRunTake;
    expect(await holderOf(lease)).toMatchObject({ holderRunId: RUN_B, holderCommandId: COMMAND_B });
  });

  it("waits out a change in flight before it sizes, closes or reads the shell", async () => {
    const { lease, setFailing, holdNextBroadcast } = openUnreliableLease();
    setFailing(false);
    await lease.take(paneOn(LAPTOP, 1), false);
    const held = holdNextBroadcast();
    const phoneTake = lease.take(paneOn(PHONE, 2), true);
    const handedOn: string[] = [];
    const phoneResize = lease.admitFromHoldingConnection(paneOn(PHONE, 2), () => {
      handedOn.push("phone's resize");
    });
    const phoneClose = lease.admitClose(PHONE, false, () => {
      handedOn.push("phone's close");
    });
    const laptopResize = lease.admitFromHoldingConnection(paneOn(LAPTOP, 1), () => {
      handedOn.push("laptop's resize");
    });
    const reading = lease.readHolder();
    held.fail();
    await expect(phoneTake).rejects.toThrow(LOG_UNAVAILABLE);
    await expect(phoneResize).rejects.toMatchObject(heldByDevice(LAPTOP));
    await expect(phoneClose).rejects.toMatchObject(heldByDevice(LAPTOP));
    await laptopResize;
    expect(handedOn).toEqual(["laptop's resize"]);
    await expect(reading).resolves.toEqual({
      holder: { holderDeviceId: LAPTOP },
      leaseVersion: 3,
    });
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
      await lease.releaseSubscriptions([secondShellPane.outputSubscriptionId]);
    }
    expect(await holderOf(first.lease)).toEqual({ holderDeviceId: LAPTOP });
    expect(await holderOf(second.lease)).toBeNull();
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
    await first.lease.releaseSubscriptions([firstShellPane.outputSubscriptionId]);
    expect(await holderOf(first.lease)).toEqual({ holderDeviceId: LAPTOP });
    await expect(
      first.lease.admitWrite({ kind: "device", ...firstShellPane }, HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await first.lease.admitWrite({ kind: "device", ...otherConnectionPane }, HAND_OFF);
    await first.lease.releaseSubscriptions([otherConnectionPane.outputSubscriptionId]);
    expect(await holderOf(first.lease)).toBeNull();
    expect(first.changes.map((change) => change.reason)).toEqual([
      "taken",
      "auto_released_pane_closed",
    ]);
  });

  it("binds a pane its holding connection types through, so the hold outlives the pane it was taken through", async () => {
    const { lease, changes } = openLease();
    const takenThrough = paneOn(LAPTOP, 1);
    const typedThrough = paneOn(LAPTOP, 1, 1);
    await lease.take(takenThrough, false);
    await lease.admitWrite({ kind: "device", ...typedThrough }, HAND_OFF);

    await lease.releaseSubscriptions([takenThrough.outputSubscriptionId]);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: LAPTOP });
    await lease.admitWrite({ kind: "device", ...typedThrough }, HAND_OFF);
    await lease.releaseSubscriptions([typedThrough.outputSubscriptionId]);
    expect(await holderOf(lease)).toBeNull();
    expect(changes.map((change) => change.reason)).toEqual(["taken", "auto_released_pane_closed"]);
  });

  it("gives a shell nobody holds to the first device that writes to it, exactly one of two", async () => {
    const { lease, changes } = openLease();
    await expect(lease.admitWrite({ kind: "run", runId: RUN_A }, HAND_OFF)).rejects.toMatchObject(
      NOT_HELD,
    );
    await expect(
      lease.admitFromHoldingConnection(paneOn(LAPTOP, 1), HAND_OFF),
    ).rejects.toMatchObject(NOT_HELD);
    await lease.admitClose(LAPTOP, false, HAND_OFF);

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
    expect(await holderOf(lease)).toBeNull();
    await lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, HAND_OFF);
    expect(await holderOf(lease)).toEqual({ holderDeviceId: PHONE });
    await lease.releaseConnection(2);

    await lease.take(paneOn(LAPTOP, 1), false);
    await expect(
      lease.admitFromHoldingConnection(paneOn(PHONE, 2), HAND_OFF),
    ).rejects.toMatchObject(heldByDevice(LAPTOP));
    await expect(lease.admitClose(PHONE, false, HAND_OFF)).rejects.toMatchObject(
      heldByDevice(LAPTOP),
    );
    await lease.admitFromHoldingConnection(paneOn(LAPTOP, 1), HAND_OFF);
    await lease.admitClose(LAPTOP, false, HAND_OFF);
    await lease.admitClose(PHONE, true, HAND_OFF);
  });
});
