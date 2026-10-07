// One shell's control lease: who may write to it, size it and close it.
//
// The lease is held by one of the person's devices, or by an agent's run on this machine, and lives
// only in this daemon's memory. Beside that holder it keeps bindings: the connections a device took
// it from, and the command a run last took it for. A device takes a shell nobody holds by taking it
// or by writing to it. Nothing gives a shell back: a device's hold ends when another device or a
// run takes it or every connection that took it has ended, a run's hold when the command it holds
// the shell for ends or the run leaves its running state, whichever comes first. A run's hold is
// never taken by a device, forced or not. A run that takes a device's hold keeps that hold aside
// and hands it back when its own hold ends, to those of the device's connections still open.
//
// Every decision reads and replaces the holder with no `await` in between, so two takes in one
// tick cannot both win. Changes of holder run one at a time: while one is being broadcast, the
// next waits for it to settle and then decides on the holder it left. A take whose broadcast fails
// is undone, so no holder stands unannounced; a release whose broadcast fails still stands, because
// the holder it ended is gone, and the failure reaches the caller.
import type { CommandId } from "@ai-sidekicks/contracts/command";
import {
  PTY_CONTROL_HELD_BY_OTHER_CODE,
  PTY_CONTROL_NOT_HELD_CODE,
  type PtyControlChangedPayload,
  type PtyControlChangedReason,
  type PtyControlHeldByOtherDetails,
  type SessionTakeControlResponse,
  type TerminalControlHolder,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { DaemonDomainError } from "../ipc/domain-error.js";

/** A device connection asking for a shell: the device and the connection it called on. */
export interface ShellLeaseCaller {
  deviceId: DeviceId;
  transportId: number;
}

/** An agent's running command asking for a shell through the run's write path. */
export interface ShellLeaseRun {
  runId: RunId;
  commandId: CommandId;
}

/** Who writes one frame to a shell: a device's connection, or an agent's run on this machine. */
export type ShellWriter =
  | { kind: "device"; deviceId: DeviceId; transportId: number }
  | { kind: "run"; runId: RunId };

/** What a {@link ShellControlLease} is built with. */
export interface ShellControlLeaseOptions {
  sessionId: SessionId;
  terminalId: TerminalId;
  /** This machine's own device id, which a run's hold names as its device. */
  machineDeviceId: DeviceId;
  /** Records one change of holder; a rejection fails the act that made the change. */
  broadcast: (change: PtyControlChangedPayload) => Promise<void>;
}

type DeviceHold = { kind: "device"; deviceId: DeviceId; transportIds: ReadonlySet<number> };

type LeaseHolder = DeviceHold | { kind: "run"; runId: RunId; commandId: CommandId };

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

/** A write, or a resize, to a shell the writer does not hold; the writer takes the shell first. */
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
 * `pty.control_not_held` refusal when the caller may not act.
 */
export class ShellControlLease {
  readonly #sessionId: SessionId;
  readonly #terminalId: TerminalId;
  readonly #machineDeviceId: DeviceId;
  readonly #broadcast: (change: PtyControlChangedPayload) => Promise<void>;
  #holder: LeaseHolder | null = null;
  // The device hold a run took the shell from, handed back when the run's hold ends; `null` while a
  // device holds the shell, nobody does, or the run took it from nobody.
  #keptAside: DeviceHold | null = null;
  // The broadcast of the one change of holder in flight; a join awaits it, any other act waits for
  // it to settle.
  #pendingBroadcast: Promise<void> | undefined;

  constructor(options: ShellControlLeaseOptions) {
    this.#sessionId = options.sessionId;
    this.#terminalId = options.terminalId;
    this.#machineDeviceId = options.machineDeviceId;
    this.#broadcast = options.broadcast;
  }

  /**
   * Takes the shell for a device connection. A device's retake of a shell it holds sends no
   * broadcast, and its connection then keeps the hold too; while the take that gave the device
   * the hold is still being broadcast, the retake waits for it and fails with it. `force` moves
   * the shell off another device; nothing moves it off a run.
   */
  async take(caller: ShellLeaseCaller, force: boolean): Promise<SessionTakeControlResponse> {
    const response = { terminalId: this.#terminalId, holderDeviceId: caller.deviceId };
    for (;;) {
      const current = this.#holder;
      if (current?.kind === "device" && current.deviceId === caller.deviceId) {
        // A binding beside the holder, announced by nobody; undoing the hold drops it.
        this.#holder = {
          ...current,
          transportIds: new Set([...current.transportIds, caller.transportId]),
        };
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
      await this.#changeHolder(
        { kind: "device", deviceId: caller.deviceId, transportIds: new Set([caller.transportId]) },
        current === null ? "taken" : "taken_by_force",
      );
      return response;
    }
  }

  /**
   * Takes the shell for an agent's running command. The same run's retake from the same command
   * changes nothing, waiting on a pending broadcast of the hold as a device's retake does; from
   * another command it names that command, broadcast as a take. A different run's take moves the
   * hold to it. A take off a device's hold keeps that hold aside for the hand-back; the caller
   * decides first that the shell is idle, since the lease cannot see a half-typed line.
   */
  async takeForRun(run: ShellLeaseRun): Promise<void> {
    for (;;) {
      const current = this.#holder;
      if (
        current?.kind === "run" &&
        current.runId === run.runId &&
        current.commandId === run.commandId
      ) {
        await this.#pendingBroadcast;
        return;
      }
      if (this.#pendingBroadcast !== undefined) {
        await this.#settled();
        continue;
      }
      await this.#changeHolder(
        { kind: "run", runId: run.runId, commandId: run.commandId },
        "taken",
        current?.kind === "device" ? current : this.#keptAside,
      );
      return;
    }
  }

  /**
   * Lets one write frame through only when its writer holds the shell. A device's write to a shell
   * nobody holds takes it for the writing connection first, broadcast as a take, and lands once
   * that broadcast has; a write that joins a pending take fails with it.
   */
  async admitWrite(writer: ShellWriter): Promise<void> {
    for (;;) {
      const current = this.#holder;
      if (writer.kind === "run") {
        if (current?.kind !== "run" || current.runId !== writer.runId) {
          throw new PtyControlNotHeldError(this.#terminalId);
        }
        return;
      }
      if (current?.kind === "device" && current.deviceId === writer.deviceId) {
        await this.#pendingBroadcast;
        return;
      }
      if (this.#pendingBroadcast !== undefined) {
        await this.#settled();
        continue;
      }
      if (current !== null) {
        throw new PtyControlNotHeldError(this.#terminalId);
      }
      await this.#changeHolder(
        { kind: "device", deviceId: writer.deviceId, transportIds: new Set([writer.transportId]) },
        "taken",
      );
      return;
    }
  }

  /** Lets a resize through only from the device holding the shell. */
  admitResize(deviceId: DeviceId): void {
    const current = this.#holder;
    if (current === null) {
      throw new PtyControlNotHeldError(this.#terminalId);
    }
    if (current.kind === "run" || current.deviceId !== deviceId) {
      throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
    }
  }

  /** Lets a close through unless a run holds the shell, or another device does without `force`. */
  admitClose(deviceId: DeviceId, force: boolean): void {
    const current = this.#holder;
    if (
      current?.kind === "run" ||
      (current?.kind === "device" && current.deviceId !== deviceId && !force)
    ) {
      throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
    }
  }

  /**
   * Drops an ended connection from the device's hold, giving the shell back once none remains. A
   * hold kept aside under a run loses the connection too, and is dropped once none remains.
   */
  async releaseConnection(transportId: number): Promise<void> {
    await this.#settled();
    const current = this.#holder;
    const keptAside = this.#keptAside;
    if (current?.kind === "run" && keptAside?.transportIds.has(transportId) === true) {
      const remaining = new Set(keptAside.transportIds);
      remaining.delete(transportId);
      this.#keptAside = remaining.size > 0 ? { ...keptAside, transportIds: remaining } : null;
      return;
    }
    if (current?.kind !== "device" || !current.transportIds.has(transportId)) {
      return;
    }
    const remaining = new Set(current.transportIds);
    remaining.delete(transportId);
    if (remaining.size > 0) {
      this.#holder = { ...current, transportIds: remaining };
      return;
    }
    await this.#changeHolder(null, "auto_released_disconnect");
  }

  /**
   * Ends a run's hold when the command it holds the shell for ends; a run past that command keeps
   * it. The shell goes back to the device hold kept aside, or to nobody.
   */
  async releaseCommand(run: ShellLeaseRun): Promise<void> {
    await this.#settled();
    const current = this.#holder;
    if (
      current?.kind !== "run" ||
      current.runId !== run.runId ||
      current.commandId !== run.commandId
    ) {
      return;
    }
    await this.#changeHolder(this.#keptAside, "auto_released_command_ended", null);
  }

  /**
   * Ends a run's hold when the run leaves its running state. The shell goes back to the device hold
   * kept aside, or to nobody.
   */
  async releaseRun(runId: RunId): Promise<void> {
    await this.#settled();
    const current = this.#holder;
    if (current?.kind !== "run" || current.runId !== runId) {
      return;
    }
    await this.#changeHolder(this.#keptAside, "auto_released_run_idle", null);
  }

  /** Who holds the shell now, or `null` while nobody does. */
  holder(): TerminalControlHolder | null {
    return this.#holder === null ? null : this.#describeHolder(this.#holder);
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

  // Waits until no change of holder is in flight. Its failure is its own caller's to report.
  async #settled(): Promise<void> {
    while (this.#pendingBroadcast !== undefined) {
      await Promise.allSettled([this.#pendingBroadcast]);
    }
  }

  // Replaces the holder and the hold kept aside at once, then broadcasts the change, naming the
  // holder after it, or nobody, and the device it moved off. Called only while no other change is
  // in flight, so a failed take puts back exactly what it replaced; a failed release, a hand-back
  // among them, is not undone, because the hold it ended is gone.
  async #changeHolder(
    next: LeaseHolder | null,
    reason: PtyControlChangedReason,
    keptAside: DeviceHold | null = this.#keptAside,
  ): Promise<void> {
    const previous = this.#holder;
    const previousKeptAside = this.#keptAside;
    this.#holder = next;
    this.#keptAside = keptAside;
    const broadcasting = this.#broadcast({
      sessionId: this.#sessionId,
      terminalId: this.#terminalId,
      ...(next === null ? { holderDeviceId: null } : this.#describeHolder(next)),
      previousHolderDeviceId:
        previous === null ? null : this.#describeHolder(previous).holderDeviceId,
      reason,
    });
    this.#pendingBroadcast = broadcasting;
    try {
      await broadcasting;
    } catch (error) {
      if (reason === "taken" || reason === "taken_by_force") {
        this.#holder = previous;
        this.#keptAside = previousKeptAside;
      }
      throw error;
    } finally {
      this.#pendingBroadcast = undefined;
    }
  }
}
