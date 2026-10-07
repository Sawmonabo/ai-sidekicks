// One shell's control lease: who may write to it, size it and close it.
//
// The lease is held by one connection of one of the person's devices, or by an agent's running
// command on this machine, and lives only in this daemon's memory. Nothing gives a shell back: a
// device's hold ends when another device takes it or its connection ends, a run's hold when the
// run leaves its running state. A run's hold is never taken by a device, forced or not.
//
// Every decision reads and replaces the holder with no `await` in between, so two takes in one
// tick cannot both win; the broadcast is called right after the change, in change order, and
// awaited, so its failure reaches the caller.
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

/** Who is writing one frame to a shell: a device, or an agent's run on this machine. */
export type ShellWriter = { kind: "device"; deviceId: DeviceId } | { kind: "run"; runId: RunId };

/** What a {@link ShellControlLease} is built with. */
export interface ShellControlLeaseOptions {
  sessionId: SessionId;
  terminalId: TerminalId;
  /** This machine's own device id, which a run's hold names as its device. */
  machineDeviceId: DeviceId;
  /** Records one change of holder; a rejection fails the act that made the change. */
  broadcast: (change: PtyControlChangedPayload) => Promise<void>;
}

type LeaseHolder =
  | { kind: "device"; deviceId: DeviceId; transportId: number }
  | { kind: "run"; runId: RunId; commandId: CommandId };

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

  constructor(options: ShellControlLeaseOptions) {
    this.#sessionId = options.sessionId;
    this.#terminalId = options.terminalId;
    this.#machineDeviceId = options.machineDeviceId;
    this.#broadcast = options.broadcast;
  }

  /**
   * Takes the shell for a device connection. A device's retake of a shell it holds succeeds
   * without a change. `force` moves the shell off another device; nothing moves it off a run.
   */
  async take(caller: ShellLeaseCaller, force: boolean): Promise<SessionTakeControlResponse> {
    const current = this.#holder;
    const response = { terminalId: this.#terminalId, holderDeviceId: caller.deviceId };
    if (current?.kind === "device" && current.deviceId === caller.deviceId) {
      return response;
    }
    if (current?.kind === "run" || (current !== null && !force)) {
      throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
    }
    this.#holder = { kind: "device", deviceId: caller.deviceId, transportId: caller.transportId };
    await this.#broadcastChange(current, current === null ? "taken" : "taken_by_force");
    return response;
  }

  /**
   * Takes the shell for an agent's running command. The same run's retake changes nothing, and a
   * different run's take moves the hold to it; a device's hold is never taken by a run.
   */
  async takeForRun(run: ShellLeaseRun): Promise<void> {
    const current = this.#holder;
    if (current?.kind === "run" && current.runId === run.runId) {
      return;
    }
    if (current?.kind === "device") {
      throw new PtyControlHeldByOtherError(this.#heldByOtherDetails(current));
    }
    this.#holder = { kind: "run", runId: run.runId, commandId: run.commandId };
    await this.#broadcastChange(current, "taken");
  }

  /** Lets one write frame through only when its writer holds the shell. */
  admitWrite(writer: ShellWriter): void {
    const current = this.#holder;
    const isHeldByWriter =
      writer.kind === "device"
        ? current?.kind === "device" && current.deviceId === writer.deviceId
        : current?.kind === "run" && current.runId === writer.runId;
    if (!isHeldByWriter) {
      throw new PtyControlNotHeldError(this.#terminalId);
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

  /** Gives the shell back when the device connection holding it ends. */
  async releaseConnection(transportId: number): Promise<void> {
    const current = this.#holder;
    if (current?.kind !== "device" || current.transportId !== transportId) {
      return;
    }
    this.#holder = null;
    await this.#broadcastChange(current, "auto_released_disconnect");
  }

  /** Gives the shell back when the run holding it leaves its running state. */
  async releaseRun(runId: RunId): Promise<void> {
    const current = this.#holder;
    if (current?.kind !== "run" || current.runId !== runId) {
      return;
    }
    this.#holder = null;
    await this.#broadcastChange(current, "auto_released_run_idle");
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

  // Names the holder after the change, or nobody after a release, and the device it moved off.
  #broadcastChange(previous: LeaseHolder | null, reason: PtyControlChangedReason): Promise<void> {
    const after = this.#holder;
    return this.#broadcast({
      sessionId: this.#sessionId,
      terminalId: this.#terminalId,
      ...(after === null ? { holderDeviceId: null } : this.#describeHolder(after)),
      previousHolderDeviceId:
        previous === null ? null : this.#describeHolder(previous).holderDeviceId,
      reason,
    });
  }
}
