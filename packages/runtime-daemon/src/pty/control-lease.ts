// One shell's control lease: who may write to it, size it and close it.
//
// The lease is held by one of the person's devices, or by an agent's run on this machine, and lives
// only in this daemon's memory. Beside that holder it keeps bindings: for a device, each pane output
// subscription it was taken or written through, with the connection that subscription belongs to;
// for a run, the command it last took it for and the device hold it took it from. Only a bound
// connection writes to or sizes a device's shell, and each further pane it takes or writes through
// is bound too; another connection of that device binds by taking it. A device takes a shell nobody
// holds by taking it or by writing to it. No verb gives a shell back: a connection or pane
// subscription closing ends its bindings, and a device's hold ends with the last of them or when
// another device takes it; a run's hold ends when the command it holds the shell for ends or the run
// leaves its running state, whichever comes first. A run's hold is never taken by a device, forced
// or not. A run may take a shell a device holds; the lease keeps that hold aside, with those of its
// bindings still open, and hands it back when the run's hold ends.
//
// Every change of holder raises the lease version by one, so a reader of the holder keeps whichever
// reading is newest.
//
// Every decision reads and replaces the holder with no `await` in between, so two takes in one
// tick cannot both win. Changes of holder run one at a time: while one is being broadcast, the
// next waits for it to settle and then decides on the holder it left, and every check and reading
// waits the same way, so none sees a holder no broadcast has confirmed. A take whose broadcast fails
// is undone, and a hand-back whose broadcast fails leaves nobody holding, so no holder stands
// unannounced; a release to nobody whose broadcast fails still stands, because the holder it ended
// is gone. Either failure reaches the caller.
import type { CommandId } from "@ai-sidekicks/contracts/command";
import {
  PTY_CONTROL_HELD_BY_OTHER_CODE,
  PTY_CONTROL_NOT_HELD_CODE,
  type PtyControlChangedPayload,
  type PtyControlChangedReason,
  type PtyControlHeldByOtherDetails,
  type PtyListEntry,
  type SessionTakeControlResponse,
  type TerminalControlHolder,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { DaemonDomainError } from "../ipc/domain-error.js";

/** One device connection: the device and the connection it called on. */
export interface ShellConnection {
  deviceId: DeviceId;
  transportId: number;
}

/** A device connection asking for a shell through its pane's output subscription to that shell. */
export interface ShellLeaseCaller extends ShellConnection {
  outputSubscriptionId: SubscriptionId;
}

/** An agent's running command asking for a shell through the run's write path. */
export interface ShellLeaseRun {
  runId: RunId;
  commandId: CommandId;
}

/** Who writes one frame to a shell: a device's connection, or an agent's run on this machine. */
export type ShellWriter = ({ kind: "device" } & ShellLeaseCaller) | { kind: "run"; runId: RunId };

/** What a {@link ShellControlLease} is built with. */
export interface ShellControlLeaseOptions {
  sessionId: SessionId;
  terminalId: TerminalId;
  /** This machine's own device id, which a run's hold names as its device. */
  machineDeviceId: DeviceId;
  /** Records one change of holder; a rejection fails the act that made the change. */
  broadcast: (change: PtyControlChangedPayload) => Promise<void>;
  /**
   * Throws the refusal for a device caller whose pane output subscription, or whose shell, has
   * ended. Called in the same tick as each binding a take or a write adds for that caller.
   */
  refuseEndedCaller: (caller: ShellLeaseCaller) => void;
}

// A device's hold, bound to each pane output subscription it was taken through, by the connection
// that subscription belongs to.
type DeviceHold = {
  kind: "device";
  deviceId: DeviceId;
  bindings: ReadonlyMap<SubscriptionId, number>;
};

// A run's hold carries the device hold it took the shell from, handed back when the run's hold
// ends, or `null` when it took the shell from nobody.
type RunHold = { kind: "run"; runId: RunId; commandId: CommandId; keptAside: DeviceHold | null };

type LeaseHolder = DeviceHold | RunHold;

// Whether the connection is one the device's hold is bound to; a connection belongs to one device.
function isBoundTo(hold: DeviceHold, connection: ShellConnection): boolean {
  return (
    hold.deviceId === connection.deviceId &&
    [...hold.bindings.values()].includes(connection.transportId)
  );
}

// The hold with the caller's pane bound to it, or the same hold when that pane already is.
function withBinding(hold: DeviceHold, caller: ShellLeaseCaller): DeviceHold {
  return hold.bindings.has(caller.outputSubscriptionId)
    ? hold
    : {
        ...hold,
        bindings: new Map([...hold.bindings, [caller.outputSubscriptionId, caller.transportId]]),
      };
}

function deviceHoldOf(caller: ShellLeaseCaller): DeviceHold {
  return {
    kind: "device",
    deviceId: caller.deviceId,
    bindings: new Map([[caller.outputSubscriptionId, caller.transportId]]),
  };
}

// The hold's bindings with the ended ones dropped.
function openBindingsOf(
  hold: DeviceHold,
  isEnded: (outputSubscriptionId: SubscriptionId, transportId: number) => boolean,
): ReadonlyMap<SubscriptionId, number> {
  return new Map(
    [...hold.bindings].filter(([outputSubscriptionId, transportId]) => {
      return !isEnded(outputSubscriptionId, transportId);
    }),
  );
}

/** A take, resize or close refused because another device or a run holds the shell. */
class PtyControlHeldByOtherError extends DaemonDomainError {
  constructor(details: PtyControlHeldByOtherDetails) {
    super(
      details.holderRunId === undefined
        ? `shell ${details.terminalId} is held by another device`
        : `shell ${details.terminalId} is held by an agent's running command`,
      { code: PTY_CONTROL_HELD_BY_OTHER_CODE, detail: { ...details } },
    );
  }
}

/**
 * A write from a writer that does not hold the shell, or a resize from a connection that does not
 * while nobody else holds it or its own device holds it on another connection.
 */
class PtyControlNotHeldError extends DaemonDomainError {
  constructor(terminalId: TerminalId) {
    super(`shell ${terminalId} is not held by this writer`, {
      code: PTY_CONTROL_NOT_HELD_CODE,
      detail: { terminalId },
    });
  }
}

/**
 * One shell's control lease, kept with the shell it guards. Takes and releases broadcast each
 * change of holder; the `admit*` checks throw a `pty.control_held_by_other` or
 * `pty.control_not_held` refusal when the caller may not act, and `admitWrite` takes a shell
 * nobody holds for the device writing to it.
 */
export class ShellControlLease {
  readonly #sessionId: SessionId;
  readonly #terminalId: TerminalId;
  readonly #machineDeviceId: DeviceId;
  readonly #broadcast: (change: PtyControlChangedPayload) => Promise<void>;
  readonly #refuseEndedCaller: (caller: ShellLeaseCaller) => void;
  #holder: LeaseHolder | null = null;
  #leaseVersion = 0;
  // The broadcast of the one change of holder in flight; a join awaits it, any other act waits for
  // it to settle.
  #pendingBroadcast: Promise<void> | undefined;

  constructor(options: ShellControlLeaseOptions) {
    this.#sessionId = options.sessionId;
    this.#terminalId = options.terminalId;
    this.#machineDeviceId = options.machineDeviceId;
    this.#broadcast = options.broadcast;
    this.#refuseEndedCaller = options.refuseEndedCaller;
  }

  /**
   * Takes the shell for a device connection, bound to the output subscription it names. A device's
   * retake of a shell it holds sends no broadcast and adds that binding; while the take that gave
   * the device the hold is still being broadcast, the retake waits for it and fails with it.
   * `force` moves the shell off another device; nothing moves it off a run. A caller whose pane
   * or shell ended meanwhile is refused before anything binds to it.
   */
  async take(caller: ShellLeaseCaller, force: boolean): Promise<SessionTakeControlResponse> {
    const response = { terminalId: this.#terminalId, holderDeviceId: caller.deviceId };
    for (;;) {
      // Checked again after every wait, in the tick the binding is added.
      this.#refuseEndedCaller(caller);
      const current = this.#holder;
      if (current?.kind === "device" && current.deviceId === caller.deviceId) {
        // A binding beside the holder, announced by nobody; undoing the hold drops it.
        this.#holder = withBinding(current, caller);
        await this.#pendingBroadcast;
        return response;
      }
      if (this.#pendingBroadcast !== undefined) {
        await this.#settled();
        continue;
      }
      if (current?.kind === "run" || (current !== null && !force)) {
        throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
      }
      await this.#changeHolder(deviceHoldOf(caller), current === null ? "taken" : "taken_by_force");
      return response;
    }
  }

  /**
   * Takes the shell for an agent's running command, off a device's hold too, which it keeps aside
   * for the hand-back. Answers `false` with nothing changed when `isShellIdle`, called in the same
   * tick as the take, says something was typed at the prompt.
   */
  async takeForRun(run: ShellLeaseRun, isShellIdle: () => boolean): Promise<boolean> {
    for (;;) {
      const current = this.#holder;
      if (
        current?.kind === "run" &&
        current.runId === run.runId &&
        current.commandId === run.commandId
      ) {
        await this.#pendingBroadcast;
        return true;
      }
      if (this.#pendingBroadcast !== undefined) {
        await this.#settled();
        continue;
      }
      if (!isShellIdle()) {
        return false;
      }
      await this.#changeHolder(
        {
          kind: "run",
          runId: run.runId,
          commandId: run.commandId,
          keptAside: current?.kind === "device" ? current : (current?.keptAside ?? null),
        },
        "taken",
      );
      return true;
    }
  }

  /**
   * Hands one write frame to `write`, in the same tick as the check that its writer holds the
   * shell, and refuses it otherwise; a device's write to a shell nobody holds takes it first, and
   * a holding connection's write binds the pane it came through. A device whose pane or shell
   * ended meanwhile is refused. The shell's ordered write path makes these calls one at a time, so
   * frames keep their order.
   */
  async admitWrite(writer: ShellWriter, write: () => void): Promise<void> {
    for (;;) {
      // Checked again after every wait, in the tick the write lands or the binding is added.
      if (writer.kind === "device") {
        this.#refuseEndedCaller(writer);
      }
      const current = this.#holder;
      const isHeldByWriter =
        writer.kind === "device"
          ? current?.kind === "device" && isBoundTo(current, writer)
          : current?.kind === "run" && current.runId === writer.runId;
      if (this.#pendingBroadcast !== undefined) {
        // A pending change that made the writer the holder is its own take or hand-back: the write
        // fails with it. Any other is waited out.
        await (isHeldByWriter ? this.#pendingBroadcast : this.#settled());
        continue;
      }
      if (isHeldByWriter) {
        if (writer.kind === "device" && current?.kind === "device") {
          // Typing in a pane keeps the hold through it as a take there would, announced by nobody.
          this.#holder = withBinding(current, writer);
        }
        write();
        return;
      }
      if (writer.kind === "run" || current !== null) {
        throw new PtyControlNotHeldError(this.#terminalId);
      }
      await this.#changeHolder(deviceHoldOf(writer), "taken");
    }
  }

  /**
   * Hands a resize to `resize`, in the same tick as the check, only from a connection holding the
   * shell. Another device's or a run's hold refuses it `pty.control_held_by_other`; nobody's, or
   * another connection of the caller's own device, `pty.control_not_held`.
   */
  async admitResize(caller: ShellConnection, resize: () => void): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await this.#settled();
    }
    const current = this.#holder;
    if (current?.kind === "run" || (current !== null && current.deviceId !== caller.deviceId)) {
      throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
    }
    if (current === null || !isBoundTo(current, caller)) {
      throw new PtyControlNotHeldError(this.#terminalId);
    }
    resize();
  }

  /**
   * Hands a close to `close`, in the same tick as the check, unless a run holds the shell, or
   * another device does without `force`.
   */
  async admitClose(deviceId: DeviceId, force: boolean, close: () => void): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await this.#settled();
    }
    const current = this.#holder;
    if (
      current?.kind === "run" ||
      (current?.kind === "device" && current.deviceId !== deviceId && !force)
    ) {
      throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
    }
    close();
  }

  /**
   * Drops an ended connection's bindings, giving the shell back once none remains. A hold kept
   * aside under a run loses them too, and is dropped once none remains.
   */
  async releaseConnection(transportId: number): Promise<void> {
    await this.#dropBindings(
      (_outputSubscriptionId, boundTransportId) => boundTransportId === transportId,
      "auto_released_disconnect",
    );
  }

  /**
   * Drops the binding a closed pane output subscription carried, giving the shell back once none
   * remains; the shell keeps running. A hold kept aside under a run loses it too.
   */
  async releaseSubscription(outputSubscriptionId: SubscriptionId): Promise<void> {
    await this.#dropBindings(
      (boundSubscriptionId) => boundSubscriptionId === outputSubscriptionId,
      "auto_released_pane_closed",
    );
  }

  /**
   * Ends a run's hold when the command it holds the shell for ends; a run past that command keeps
   * it. The shell goes back to the device hold kept aside, or to nobody.
   */
  async releaseCommand(run: ShellLeaseRun): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await this.#settled();
    }
    const current = this.#holder;
    if (
      current?.kind !== "run" ||
      current.runId !== run.runId ||
      current.commandId !== run.commandId
    ) {
      return;
    }
    await this.#changeHolder(current.keptAside, "auto_released_command_ended");
  }

  /**
   * Ends a run's hold when the run leaves its running state. The shell goes back to the device hold
   * kept aside, or to nobody.
   */
  async releaseRun(runId: RunId): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await this.#settled();
    }
    const current = this.#holder;
    if (current?.kind !== "run" || current.runId !== runId) {
      return;
    }
    await this.#changeHolder(current.keptAside, "auto_released_run_idle");
  }

  /**
   * Who holds the shell once every change in flight has settled, `null` while nobody does, and the
   * lease version it was read at, for a shell list entry or an opening frame.
   */
  async readHolder(): Promise<Pick<PtyListEntry, "holder" | "leaseVersion">> {
    while (this.#pendingBroadcast !== undefined) {
      await this.#settled();
    }
    return {
      holder: this.#holder === null ? null : this.#describeHolder(this.#holder),
      leaseVersion: this.#leaseVersion,
    };
  }

  async #dropBindings(
    isEnded: (outputSubscriptionId: SubscriptionId, transportId: number) => boolean,
    reason: "auto_released_disconnect" | "auto_released_pane_closed",
  ): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await this.#settled();
    }
    const current = this.#holder;
    const hold = current?.kind === "run" ? current.keptAside : current;
    if (hold === null) {
      return;
    }
    const open = openBindingsOf(hold, isEnded);
    if (open.size === hold.bindings.size) {
      return;
    }
    if (current?.kind === "run") {
      this.#holder = { ...current, keptAside: open.size > 0 ? { ...hold, bindings: open } : null };
      return;
    }
    if (open.size > 0) {
      this.#holder = { ...hold, bindings: open };
      return;
    }
    await this.#changeHolder(null, reason);
  }

  #describeHolder(holder: LeaseHolder): TerminalControlHolder {
    return holder.kind === "device"
      ? { holderDeviceId: holder.deviceId }
      : {
          holderDeviceId: this.#machineDeviceId,
          holderRunId: holder.runId,
          holderCommandId: holder.commandId,
        };
  }

  #heldByOtherDetails(holder: LeaseHolder): PtyControlHeldByOtherDetails {
    return { terminalId: this.#terminalId, ...this.#describeHolder(holder) };
  }

  // A change of holder, raising the lease version. An undone change raises it again, so a reading
  // taken after the undo is newer than the change no broadcast confirmed.
  #replaceHolder(next: LeaseHolder | null): void {
    this.#holder = next;
    this.#leaseVersion += 1;
  }

  // Waits until no change of holder is in flight; that change's failure is its own caller's to
  // report. The caller resumes a tick later, when another act may have started a change, so every
  // caller checks again before it acts.
  async #settled(): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await Promise.allSettled([this.#pendingBroadcast]);
    }
  }

  // Replaces the holder at once, then broadcasts the change, naming the holder after it, or nobody,
  // and the device it moved off. Called only while no other change is in flight, so a failed take
  // puts back exactly the holder it replaced, and a failed hand-back leaves nobody holding rather
  // than an unannounced device; a failed release to nobody stands, as the hold it ended is gone.
  async #changeHolder(next: LeaseHolder | null, reason: PtyControlChangedReason): Promise<void> {
    const previous = this.#holder;
    this.#replaceHolder(next);
    // An async wrapper, so a broadcast that throws before returning takes the same undo path.
    const broadcasting = (async () =>
      this.#broadcast({
        sessionId: this.#sessionId,
        terminalId: this.#terminalId,
        ...(next === null ? { holderDeviceId: null } : this.#describeHolder(next)),
        previousHolderDeviceId:
          previous === null ? null : this.#describeHolder(previous).holderDeviceId,
        reason,
        leaseVersion: this.#leaseVersion,
      }))();
    this.#pendingBroadcast = broadcasting;
    try {
      await broadcasting;
    } catch (error) {
      const restored = reason === "taken" || reason === "taken_by_force" ? previous : null;
      // A release to nobody leaves the holder as it was, so the version stays.
      if (restored !== this.#holder) {
        this.#replaceHolder(restored);
      }
      throw error;
    } finally {
      this.#pendingBroadcast = undefined;
    }
  }
}
