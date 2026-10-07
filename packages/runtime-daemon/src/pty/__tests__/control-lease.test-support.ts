// What every control-lease test builds on: the ids, a lease that records each broadcast parsed
// against the wire schema, a connection's terminal pane, and the refusals a check throws.

import { type CommandId, CommandIdSchema } from "@ai-sidekicks/contracts/command";
import { SubscriptionIdSchema } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  PTY_CONTROL_HELD_BY_OTHER_CODE,
  PTY_CONTROL_NOT_HELD_CODE,
  PtyControlChangedPayloadSchema,
  TerminalIdSchema,
  type PtyControlChangedPayload,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import { type RunId, RunIdSchema } from "@ai-sidekicks/contracts/run/id";
import { type SessionId, SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import { DeviceIdSchema, type DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { type ShellLeaseCaller, ShellControlLease } from "../control-lease.js";

/** The session every test shell belongs to. */
export const SESSION_ID: SessionId = SessionIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e");
/** The shell most cases act on. */
export const TERMINAL_ID: TerminalId = TerminalIdSchema.parse("terminal-1");
/** A second shell of the session, for holds that must stay apart. */
export const OTHER_TERMINAL_ID: TerminalId = TerminalIdSchema.parse("terminal-2");
/** This machine's own device, which a run's hold names. */
export const MACHINE: DeviceId = DeviceIdSchema.parse("device-machine");
/** Another of the person's devices. */
export const LAPTOP: DeviceId = DeviceIdSchema.parse("device-laptop");
/** A third of the person's devices. */
export const PHONE: DeviceId = DeviceIdSchema.parse("device-phone");
/** An agent's run. */
export const RUN_A: RunId = RunIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0a01");
/** Another agent's run. */
export const RUN_B: RunId = RunIdSchema.parse("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0b02");
/** A run's command. */
export const COMMAND_A: CommandId = CommandIdSchema.parse("command-a");
/** A second command. */
export const COMMAND_B: CommandId = CommandIdSchema.parse("command-b");
/** A third command. */
export const COMMAND_C: CommandId = CommandIdSchema.parse("command-c");

/** A lease and every change it broadcast. */
export interface LeaseUnderTest {
  lease: ShellControlLease;
  changes: PtyControlChangedPayload[];
}

/** Opens a lease whose broadcasts succeed, each parsed against the wire schema and recorded. */
export function openLease(terminalId: TerminalId = TERMINAL_ID): LeaseUnderTest {
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

/** The error a synchronous check threw; fails the test when it threw nothing. */
export function refusalOf(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("expected the act to be refused");
}

/** The changes a lease broadcast, each raising the lease version by one from a shell at 0. */
export function inVersionOrder(changes: readonly object[]): object[] {
  return changes.map((change, index) => ({ ...change, leaseVersion: index + 1 }));
}

/**
 * One connection's terminal pane: the connection and its pane's output subscription to the shell,
 * one subscription per connection unless a case opens another with `pane`.
 */
export function paneOn(deviceId: DeviceId, transportId: number, pane = 0): ShellLeaseCaller {
  const suffix = `${String(transportId).padStart(6, "0")}${String(pane).padStart(6, "0")}`;
  return {
    deviceId,
    transportId,
    outputSubscriptionId: SubscriptionIdSchema.parse(`0190f5a2-7c1e-7a3b-8d4e-${suffix}`),
  };
}

/** The shell table's idle check, for every take that is not about it: nothing typed at the prompt. */
export const IDLE = (): boolean => true;

/** The frame's hand-off, for every write that is not about it. */
export const WRITE = (): void => undefined;

/** The refusal of a write or resize from a writer that does not hold the test shell. */
export const NOT_HELD: object = {
  code: PTY_CONTROL_NOT_HELD_CODE,
  detail: { terminalId: TERMINAL_ID },
};

/** The refusal of an act because another device holds the shell. */
export function heldByDevice(deviceId: string, terminalId: TerminalId = TERMINAL_ID): object {
  return { code: PTY_CONTROL_HELD_BY_OTHER_CODE, detail: { terminalId, holderDeviceId: deviceId } };
}
