// One shell's control lease: racing takes, a run's hold that no device take moves and that names
// its latest command, forced takes, holds that end with the last connection that took them, failed
// broadcasts, and the write, resize and close checks. Every broadcast is parsed against the wire
// schema, so a contradictory change fails the act that sent it.

import { describe, expect, it } from "vitest";

import { CommandIdSchema } from "@ai-sidekicks/contracts/command";
import {
  PTY_CONTROL_HELD_BY_OTHER_CODE,
  PTY_CONTROL_NOT_HELD_CODE,
  PtyControlChangedPayloadSchema,
  TerminalIdSchema,
  type PtyControlChangedPayload,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import { RunIdSchema } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { registerSessionTakeControl } from "../../ipc/handlers/session/take-control.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { ShellControlLease } from "../control-lease.js";

const SESSION_ID = SessionIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e");
const TERMINAL_ID = TerminalIdSchema.parse("terminal-1");
const OTHER_TERMINAL_ID = TerminalIdSchema.parse("terminal-2");
const MACHINE = DeviceIdSchema.parse("device-machine");
const LAPTOP = DeviceIdSchema.parse("device-laptop");
const PHONE = DeviceIdSchema.parse("device-phone");
const RUN_A = RunIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0a01");
const RUN_B = RunIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0b02");
const COMMAND_A = CommandIdSchema.parse("command-a");
const COMMAND_B = CommandIdSchema.parse("command-b");
const COMMAND_C = CommandIdSchema.parse("command-c");

interface LeaseUnderTest {
  lease: ShellControlLease;
  changes: PtyControlChangedPayload[];
}

function openLease(terminalId: TerminalId = TERMINAL_ID): LeaseUnderTest {
  const changes: PtyControlChangedPayload[] = [];
  const lease = new ShellControlLease({
    sessionId: SESSION_ID,
    terminalId,
    machineDeviceId: MACHINE,
    broadcast: async (change) => {
      changes.push(PtyControlChangedPayloadSchema.parse(change));
    },
  });
  return { lease, changes };
}

function refusalOf(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("expected the act to be refused");
}

const NOT_HELD = { code: PTY_CONTROL_NOT_HELD_CODE, detail: { terminalId: TERMINAL_ID } };

function heldByDevice(deviceId: string, terminalId: TerminalId = TERMINAL_ID): object {
  return { code: PTY_CONTROL_HELD_BY_OTHER_CODE, detail: { terminalId, holderDeviceId: deviceId } };
}

describe("ShellControlLease", () => {
  it("lets exactly one of two racing takes win, and refuses the loser's writes", async () => {
    const { lease, changes } = openLease();
    const registry = new MethodRegistryImpl();
    registerSessionTakeControl(registry, { findShellLease: () => lease });
    const request = { sessionId: SESSION_ID, terminalId: TERMINAL_ID };

    const outcomes = await Promise.allSettled([
      registry.dispatch("session.takeControl", request, { deviceId: LAPTOP, transportId: 1 }),
      registry.dispatch("session.takeControl", request, { deviceId: PHONE, transportId: 2 }),
    ]);

    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = outcomes[0]?.status === "fulfilled" ? LAPTOP : PHONE;
    const loser = winner === LAPTOP ? PHONE : LAPTOP;
    expect(won[0]?.value).toEqual({ terminalId: TERMINAL_ID, holderDeviceId: winner });
    expect(lost[0]?.reason).toMatchObject(heldByDevice(winner));
    expect(changes).toEqual([
      {
        sessionId: SESSION_ID,
        terminalId: TERMINAL_ID,
        holderDeviceId: winner,
        previousHolderDeviceId: null,
        reason: "taken",
      },
    ]);
    expect(refusalOf(() => lease.admitWrite({ kind: "device", deviceId: loser }))).toMatchObject(
      NOT_HELD,
    );
    lease.admitWrite({ kind: "device", deviceId: winner });

    // A call with no connection to end the lease with never takes the shell.
    await expect(registry.dispatch("session.takeControl", request, {})).rejects.toThrow(
      "session.takeControl needs the calling device and its connection",
    );
    expect(changes).toHaveLength(1);
  });

  it("never lets a device take a run's hold, which follows its command and ends with it", async () => {
    const { lease, changes } = openLease();
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A });
    const heldByRunA = {
      code: PTY_CONTROL_HELD_BY_OTHER_CODE,
      detail: {
        terminalId: TERMINAL_ID,
        holderDeviceId: MACHINE,
        holderRunId: RUN_A,
        holderCommandId: COMMAND_A,
      },
    };

    // The machine's own device is refused too: a run's hold is not that device's to retake.
    for (const deviceId of [LAPTOP, MACHINE]) {
      for (const force of [false, true]) {
        await expect(lease.take({ deviceId, transportId: 1 }, force)).rejects.toMatchObject(
          heldByRunA,
        );
      }
    }
    expect(refusalOf(() => lease.admitResize(MACHINE))).toMatchObject(heldByRunA);
    expect(refusalOf(() => lease.admitClose(MACHINE, true))).toMatchObject(heldByRunA);
    expect(refusalOf(() => lease.admitWrite({ kind: "device", deviceId: MACHINE }))).toMatchObject(
      NOT_HELD,
    );

    // The same run's retake keeps the run; from another of its commands it names that command,
    // so stopping the run reaches the live one, and from the same command it changes nothing.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C });
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C });
    expect(lease.holder()).toEqual({
      holderDeviceId: MACHINE,
      holderRunId: RUN_A,
      holderCommandId: COMMAND_C,
    });
    lease.admitWrite({ kind: "run", runId: RUN_A });

    await lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B });
    expect(refusalOf(() => lease.admitWrite({ kind: "run", runId: RUN_A }))).toMatchObject(
      NOT_HELD,
    );
    lease.admitWrite({ kind: "run", runId: RUN_B });

    // The run that lost the hold leaving its running state releases nothing.
    await lease.releaseRun(RUN_A);
    await lease.releaseRun(RUN_B);
    await lease.take({ deviceId: LAPTOP, transportId: 1 }, false);
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A })).rejects.toMatchObject(
      heldByDevice(LAPTOP),
    );

    const runHold = { sessionId: SESSION_ID, terminalId: TERMINAL_ID };
    expect(changes).toEqual([
      {
        ...runHold,
        holderDeviceId: MACHINE,
        holderRunId: RUN_A,
        holderCommandId: COMMAND_A,
        previousHolderDeviceId: null,
        reason: "taken",
      },
      {
        ...runHold,
        holderDeviceId: MACHINE,
        holderRunId: RUN_A,
        holderCommandId: COMMAND_C,
        previousHolderDeviceId: MACHINE,
        reason: "taken",
      },
      {
        ...runHold,
        holderDeviceId: MACHINE,
        holderRunId: RUN_B,
        holderCommandId: COMMAND_B,
        previousHolderDeviceId: MACHINE,
        reason: "taken",
      },
      {
        ...runHold,
        holderDeviceId: null,
        previousHolderDeviceId: MACHINE,
        reason: "auto_released_run_idle",
      },
      { ...runHold, holderDeviceId: LAPTOP, previousHolderDeviceId: null, reason: "taken" },
    ]);
  });

  it("moves a shell off another device only by force, refusing the displaced writes", async () => {
    const { lease, changes } = openLease();
    await lease.take({ deviceId: LAPTOP, transportId: 1 }, false);

    await expect(lease.take({ deviceId: PHONE, transportId: 2 }, false)).rejects.toMatchObject(
      heldByDevice(LAPTOP),
    );
    await expect(lease.take({ deviceId: PHONE, transportId: 2 }, true)).resolves.toEqual({
      terminalId: TERMINAL_ID,
      holderDeviceId: PHONE,
    });

    expect(refusalOf(() => lease.admitWrite({ kind: "device", deviceId: LAPTOP }))).toMatchObject(
      NOT_HELD,
    );
    lease.admitWrite({ kind: "device", deviceId: PHONE });
    // The displaced connection ending no longer touches a hold it lost.
    await lease.releaseConnection(1);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
    expect(changes.at(-1)).toEqual({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      holderDeviceId: PHONE,
      previousHolderDeviceId: LAPTOP,
      reason: "taken_by_force",
    });
    expect(changes).toHaveLength(2);
  });

  it("gives a shell back only once every connection that took it has ended", async () => {
    const first = openLease(TERMINAL_ID);
    const second = openLease(OTHER_TERMINAL_ID);
    await first.lease.take({ deviceId: LAPTOP, transportId: 1 }, false);
    await second.lease.take({ deviceId: PHONE, transportId: 2 }, false);

    // A second connection of the holding device retakes with no broadcast, and keeps the hold
    // through the first connection's end.
    await expect(first.lease.take({ deviceId: LAPTOP, transportId: 3 }, true)).resolves.toEqual({
      terminalId: TERMINAL_ID,
      holderDeviceId: LAPTOP,
    });
    expect(first.changes).toHaveLength(1);
    for (const { lease } of [first, second]) {
      await lease.releaseConnection(1);
    }
    expect(first.lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    first.lease.admitWrite({ kind: "device", deviceId: LAPTOP });

    for (const { lease } of [first, second]) {
      await lease.releaseConnection(3);
    }
    expect(first.lease.holder()).toBeNull();
    expect(second.lease.holder()).toEqual({ holderDeviceId: PHONE });
    expect(first.changes).toEqual([
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
    ]);
    expect(second.changes).toHaveLength(1);
  });

  it("undoes a take whose broadcast fails, never a release, one change at a time", async () => {
    let isBroadcastFailing = true;
    let pendingBroadcast: Promise<void> | undefined;
    const lease = new ShellControlLease({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      machineDeviceId: MACHINE,
      broadcast: async () => {
        if (pendingBroadcast !== undefined) {
          return pendingBroadcast;
        }
        if (isBroadcastFailing) {
          throw new Error("the event log is unavailable");
        }
      },
    });

    await expect(lease.take({ deviceId: LAPTOP, transportId: 1 }, false)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toBeNull();
    expect(refusalOf(() => lease.admitWrite({ kind: "device", deviceId: LAPTOP }))).toMatchObject(
      NOT_HELD,
    );

    isBroadcastFailing = false;
    await lease.take({ deviceId: LAPTOP, transportId: 1 }, false);
    isBroadcastFailing = true;
    await expect(lease.take({ deviceId: PHONE, transportId: 2 }, true)).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    lease.admitWrite({ kind: "device", deviceId: LAPTOP });

    // A connection joining a hold whose broadcast is still pending fails with it, and the undo
    // drops the joined connection along with the hold.
    let failPendingBroadcast = (): void => undefined;
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const forcedTake = lease.take({ deviceId: PHONE, transportId: 2 }, true);
    const joiningTake = lease.take({ deviceId: PHONE, transportId: 5 }, false);
    pendingBroadcast = undefined;
    failPendingBroadcast();
    await expect(forcedTake).rejects.toThrow("the event log is unavailable");
    await expect(joiningTake).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    isBroadcastFailing = false;
    await lease.releaseConnection(5);
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    await lease.take({ deviceId: PHONE, transportId: 2 }, true);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });

    // A run's move to its new command is undone the same way.
    await lease.releaseConnection(2);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A });
    isBroadcastFailing = true;
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_B })).rejects.toThrow(
      "the event log is unavailable",
    );
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_A, holderCommandId: COMMAND_A });

    // A release whose broadcast fails still stands, and its failure reaches the caller.
    await expect(lease.releaseRun(RUN_A)).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toBeNull();

    // The same command's retake joins a pending run take and fails with it.
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const runTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A });
    const joiningRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A });
    pendingBroadcast = undefined;
    failPendingBroadcast();
    await expect(runTake).rejects.toThrow("the event log is unavailable");
    await expect(joiningRunTake).rejects.toThrow("the event log is unavailable");
    expect(lease.holder()).toBeNull();

    // A release that arrives while a take is in flight applies to the holder that take leaves, so a
    // failed take never brings back a run that has gone idle or a connection that has ended.
    isBroadcastFailing = false;
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A });
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const otherRunTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B });
    const idleRelease = lease.releaseRun(RUN_A);
    pendingBroadcast = undefined;
    failPendingBroadcast();
    await expect(otherRunTake).rejects.toThrow("the event log is unavailable");
    await idleRelease;
    expect(lease.holder()).toBeNull();

    await lease.take({ deviceId: LAPTOP, transportId: 1 }, false);
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const forcedPhoneTake = lease.take({ deviceId: PHONE, transportId: 2 }, true);
    const laptopGone = lease.releaseConnection(1);
    pendingBroadcast = undefined;
    failPendingBroadcast();
    await expect(forcedPhoneTake).rejects.toThrow("the event log is unavailable");
    await laptopGone;
    expect(lease.holder()).toBeNull();

    // A take that arrives while another is in flight decides on the holder that one leaves, so the
    // failed take's undo never wipes it out.
    pendingBroadcast = new Promise((_resolve, reject) => {
      failPendingBroadcast = () => {
        reject(new Error("the event log is unavailable"));
      };
    });
    const laptopTake = lease.take({ deviceId: LAPTOP, transportId: 1 }, false);
    pendingBroadcast = undefined;
    const phoneTake = lease.take({ deviceId: PHONE, transportId: 2 }, true);
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
    const firstRunTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A });
    pendingBroadcast = undefined;
    const secondRunTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B });
    failPendingBroadcast();
    await expect(firstRunTake).rejects.toThrow("the event log is unavailable");
    await secondRunTake;
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_B, holderCommandId: COMMAND_B });
  });

  it("refuses writes to an unheld shell, and a non-holder's resize and plain close", async () => {
    const { lease } = openLease();
    expect(refusalOf(() => lease.admitWrite({ kind: "device", deviceId: LAPTOP }))).toMatchObject(
      NOT_HELD,
    );
    expect(refusalOf(() => lease.admitWrite({ kind: "run", runId: RUN_A }))).toMatchObject(
      NOT_HELD,
    );
    expect(refusalOf(() => lease.admitResize(LAPTOP))).toMatchObject(NOT_HELD);
    lease.admitClose(LAPTOP, false);

    await lease.take({ deviceId: LAPTOP, transportId: 1 }, false);
    expect(refusalOf(() => lease.admitResize(PHONE))).toMatchObject(heldByDevice(LAPTOP));
    expect(refusalOf(() => lease.admitClose(PHONE, false))).toMatchObject(heldByDevice(LAPTOP));
    lease.admitResize(LAPTOP);
    lease.admitClose(LAPTOP, false);
    lease.admitClose(PHONE, true);
  });
});
