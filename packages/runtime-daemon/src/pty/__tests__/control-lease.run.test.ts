// One shell's control lease held by an agent's run: a hold no device take moves, that names its
// latest command and ends with that command or the run, a device's hold lent to a run and handed
// back, the prompt check as a run takes, and one change of holder at a time.

import { describe, expect, it } from "vitest";

import {
  PTY_CONTROL_HELD_BY_OTHER_CODE,
  PtyControlChangedPayloadSchema,
  type PtyControlChangedPayload,
} from "@ai-sidekicks/contracts/pty";
import type { CommandId } from "@ai-sidekicks/contracts/command";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { ShellControlLease } from "../control-lease.js";

import {
  SESSION_ID,
  TERMINAL_ID,
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
} from "./control-lease.test-support.js";

describe("ShellControlLease", () => {
  it("never lets a device take a run's hold, which follows its command and ends with it or the run", async () => {
    const { lease, changes } = openLease();
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
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
        await expect(lease.take(paneOn(deviceId, 1), force)).rejects.toMatchObject(heldByRunA);
      }
    }
    expect(refusalOf(() => lease.admitResize(paneOn(MACHINE, 9)))).toMatchObject(heldByRunA);
    expect(refusalOf(() => lease.admitClose(MACHINE, true))).toMatchObject(heldByRunA);
    await expect(
      lease.admitWrite({ kind: "device", ...paneOn(MACHINE, 9) }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);

    // The same run's retake keeps the run; from another of its commands it names that command,
    // so stopping the run reaches the live one, and from the same command it changes nothing.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    expect(lease.holder()).toEqual({
      holderDeviceId: MACHINE,
      holderRunId: RUN_A,
      holderCommandId: COMMAND_C,
    });
    await lease.admitWrite({ kind: "run", runId: RUN_A }, WRITE);

    await lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
    await expect(lease.admitWrite({ kind: "run", runId: RUN_A }, WRITE)).rejects.toMatchObject(
      NOT_HELD,
    );
    await lease.admitWrite({ kind: "run", runId: RUN_B }, WRITE);

    // The run that lost the hold leaving its running state releases nothing.
    await lease.releaseRun(RUN_A);
    await lease.releaseRun(RUN_B);

    // A run's hold ends when its command ends; an ended command the run has moved past, or the
    // run's later idle transition, releases nothing more.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    await lease.releaseCommand({ runId: RUN_B, commandId: COMMAND_C });
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_A, holderCommandId: COMMAND_C });
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_C });
    expect(lease.holder()).toBeNull();
    await lease.releaseRun(RUN_A);

    const runHold = { sessionId: SESSION_ID, terminalId: TERMINAL_ID };
    expect(changes).toEqual(
      inVersionOrder([
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
          holderDeviceId: null,
          previousHolderDeviceId: MACHINE,
          reason: "auto_released_command_ended",
        },
      ]),
    );
  });

  it("lends a device's idle hold to a run's command and hands it back to its open connections", async () => {
    const { lease, changes } = openLease();
    await lease.take(paneOn(LAPTOP, 1), false);
    await lease.take(paneOn(LAPTOP, 3), false);
    await expect(lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE)).resolves.toBe(
      true,
    );
    await expect(
      lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 3) }, WRITE),
    ).rejects.toMatchObject(NOT_HELD);
    await expect(lease.take(paneOn(LAPTOP, 3), true)).rejects.toMatchObject({
      code: PTY_CONTROL_HELD_BY_OTHER_CODE,
    });

    // One of the device's connections ends under the run; the command's end hands the shell back
    // to the device on the one still open.
    await lease.releaseConnection(1);
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    await lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 3) }, WRITE);

    // A hold kept aside follows the hold through another run's take, back to the device.
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    await lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
    await lease.releaseRun(RUN_A);
    await lease.releaseRun(RUN_B);
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });

    // A hold handed back is no longer kept aside: once its connection ends, a later run's take
    // from nobody hands the shell back to nobody.
    await lease.releaseConnection(3);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    await lease.releaseRun(RUN_A);
    expect(lease.holder()).toBeNull();

    // Once the last of the device's connections ends under the run, the hand-back reaches nobody.
    await lease.take(paneOn(LAPTOP, 5), false);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_C }, IDLE);
    await lease.releaseConnection(5);
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_A });
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_C });
    expect(lease.holder()).toBeNull();

    const shell = { sessionId: SESSION_ID, terminalId: TERMINAL_ID };
    const laptopTake = {
      ...shell,
      holderDeviceId: LAPTOP,
      previousHolderDeviceId: null,
      reason: "taken",
    };
    const runTake = (runId: RunId, commandId: CommandId, previous: string | null) => ({
      ...shell,
      holderDeviceId: MACHINE,
      holderRunId: runId,
      holderCommandId: commandId,
      previousHolderDeviceId: previous,
      reason: "taken",
    });
    const runRelease = (holderDeviceId: string | null, reason: string) => ({
      ...shell,
      holderDeviceId,
      previousHolderDeviceId: MACHINE,
      reason,
    });
    expect(changes).toEqual(
      inVersionOrder([
        laptopTake,
        runTake(RUN_A, COMMAND_A, LAPTOP),
        runRelease(LAPTOP, "auto_released_command_ended"),
        runTake(RUN_A, COMMAND_C, LAPTOP),
        runTake(RUN_B, COMMAND_B, MACHINE),
        runRelease(LAPTOP, "auto_released_run_idle"),
        {
          ...shell,
          holderDeviceId: null,
          previousHolderDeviceId: LAPTOP,
          reason: "auto_released_disconnect",
        },
        runTake(RUN_A, COMMAND_A, null),
        runRelease(null, "auto_released_run_idle"),
        laptopTake,
        runTake(RUN_A, COMMAND_C, LAPTOP),
        runRelease(null, "auto_released_command_ended"),
      ]),
    );
  });

  it("binds no pane to a run's hold, and hands a lent hold whose pane has closed to nobody", async () => {
    const { lease, changes } = openLease();
    const laptopPane = paneOn(LAPTOP, 1);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    await lease.releaseSubscription(laptopPane.outputSubscriptionId);
    expect(lease.holder()).toMatchObject({ holderRunId: RUN_A });
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A });

    // The pane the lent hold was taken through closes under the run, its connection still open.
    await lease.take(laptopPane, false);
    await lease.takeForRun({ runId: RUN_A, commandId: COMMAND_B }, IDLE);
    await lease.releaseSubscription(laptopPane.outputSubscriptionId);
    await lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_B });
    expect(lease.holder()).toBeNull();
    expect(changes.map((change) => [change.reason, change.holderDeviceId])).toEqual([
      ["taken", MACHINE],
      ["auto_released_command_ended", null],
      ["taken", LAPTOP],
      ["taken", MACHINE],
      ["auto_released_command_ended", null],
    ]);
  });

  it("takes a shell for a run only while nothing is typed at its prompt, checked as it takes", async () => {
    let pendingBroadcast: Promise<void> | undefined;
    const changes: PtyControlChangedPayload[] = [];
    const lease = new ShellControlLease({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      machineDeviceId: MACHINE,
      broadcast: async (change) => {
        changes.push(PtyControlChangedPayloadSchema.parse(change));
        await pendingBroadcast;
      },
    });
    await lease.take(paneOn(LAPTOP, 1), false);
    await expect(
      lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, () => false),
    ).resolves.toBe(false);
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
    expect(changes).toHaveLength(1);

    // A run's take waiting on a change in flight checks the prompt once that change has settled,
    // so a keystroke handed on meanwhile, which the shell table records as it goes, refuses it.
    let isTyped = false;
    let landBroadcast = (): void => undefined;
    pendingBroadcast = new Promise((resolve) => {
      landBroadcast = resolve;
    });
    const phoneTake = lease.take(paneOn(PHONE, 2), true);
    pendingBroadcast = undefined;
    const keystroke = lease.admitWrite({ kind: "device", ...paneOn(PHONE, 2) }, () => {
      isTyped = true;
    });
    const runTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, () => !isTyped);
    landBroadcast();
    await phoneTake;
    await keystroke;
    await expect(runTake).resolves.toBe(false);
    expect(lease.holder()).toEqual({ holderDeviceId: PHONE });
  });

  it("lets one change of holder through at a time, a release waiting out a chain of them", async () => {
    // Each broadcast waits on the next promise a case queues, or lands at once when none is queued.
    const queued: Promise<void>[] = [];
    const lease = new ShellControlLease({
      sessionId: SESSION_ID,
      terminalId: TERMINAL_ID,
      machineDeviceId: MACHINE,
      broadcast: async () => queued.shift(),
    });
    let landTake = (): void => undefined;
    let failRunTake = (): void => undefined;
    queued.push(
      new Promise((resolve) => {
        landTake = resolve;
      }),
      new Promise((_resolve, reject) => {
        failRunTake = () => {
          reject(new Error("the event log is unavailable"));
        };
      }),
    );
    // A device's take is in flight, a run's take waits on it, and the device's connection ends.
    const laptopTake = lease.take(paneOn(LAPTOP, 1), false);
    const runTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
    const laptopGone = lease.releaseConnection(1);
    landTake();
    await laptopTake;
    for (let tick = 0; tick < 10 && lease.holder()?.holderRunId === undefined; tick++) {
      await Promise.resolve();
    }
    failRunTake();
    await expect(runTake).rejects.toThrow("the event log is unavailable");
    await laptopGone;
    // The connection's end waited out the run's failed take as well, so it ended the hold the
    // undo put back rather than leaving it standing for a connection that is gone.
    expect(lease.holder()).toBeNull();

    // A run's command end and its idle transition wait out a chain the same way: each ends the hold
    // the failed take's undo put back.
    for (const release of [
      () => lease.releaseCommand({ runId: RUN_A, commandId: COMMAND_A }),
      () => lease.releaseRun(RUN_A),
    ]) {
      let landRunTake = (): void => undefined;
      let failOtherTake = (): void => undefined;
      queued.push(
        new Promise((resolve) => {
          landRunTake = resolve;
        }),
        new Promise((_resolve, reject) => {
          failOtherTake = () => {
            reject(new Error("the event log is unavailable"));
          };
        }),
      );
      const firstTake = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, IDLE);
      const otherTake = lease.takeForRun({ runId: RUN_B, commandId: COMMAND_B }, IDLE);
      const ended = release();
      landRunTake();
      await firstTake;
      for (let tick = 0; tick < 10 && lease.holder()?.holderRunId !== RUN_B; tick++) {
        await Promise.resolve();
      }
      failOtherTake();
      await expect(otherTake).rejects.toThrow("the event log is unavailable");
      await ended;
      expect(lease.holder()).toBeNull();
    }

    // A keystroke handed on in the same tick as its check is seen by a run's take that follows it.
    await lease.take(paneOn(LAPTOP, 3), false);
    let isTyped = false;
    const keystroke = lease.admitWrite({ kind: "device", ...paneOn(LAPTOP, 3) }, () => {
      isTyped = true;
    });
    const typedOver = lease.takeForRun({ runId: RUN_A, commandId: COMMAND_A }, () => !isTyped);
    await keystroke;
    await expect(typedOver).resolves.toBe(false);
    expect(lease.holder()).toEqual({ holderDeviceId: LAPTOP });
  });
});
