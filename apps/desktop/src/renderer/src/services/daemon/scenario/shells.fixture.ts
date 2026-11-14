// The fixture daemon's shell streams for a scenario that scripts shells. `terminal.subscribe` lists
// the session's shells when it opens and again whenever a beat moves one's lease, each shell held
// as the newest delivered `terminal.control.changed` beat for it says. `terminal.output.subscribe`
// opens with the shell's scrollback window, its text as one byte attachment, and nothing follows:
// no beat writes to a shell. Every frame is held to its generated check before it is delivered.

import {
  validateTerminalListUpdate,
  validateTerminalOutputFrame,
  type TerminalControlHolder,
} from "@ai-sidekicks/contracts/terminal";

import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";
import { checkFaultPaths } from "../wire/fault-path.js";
import { TERMINAL_LIST_STREAM, TERMINAL_OUTPUT_STREAM } from "#shared/daemon/streams.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { isWireRecord } from "#renderer/lib/wire/record.js";
import type { ScenarioShell } from "#fixtures/scenario.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import type { ScenarioEngine } from "../engine.fixture.js";
import { FixtureBridgeError } from "../refusal.fixture.js";

/** The lease change beat that moves a shell's holder. */
const LEASE_CHANGE_KIND = "terminal.control.changed";

/** One shell-stream delivery: the frame and the bytes its `{"$bytes": n}` members name. */
export type ShellStreamDelivery = (frame: unknown, attachments: readonly Uint8Array[]) => void;

/**
 * Deliver one shell stream of the scenario's session. A request for another session, or a shell
 * the scenario does not script, delivers nothing.
 */
export function subscribeToScenarioShells(
  engine: ScenarioEngine,
  subscriptionName: string,
  request: unknown,
  deliver: ShellStreamDelivery,
): Unsubscribe {
  const shells = engine.scenario.shells ?? [];
  if (!isWireRecord(request) || request["sessionId"] !== engine.scenario.sessionId) {
    return () => undefined;
  }
  if (subscriptionName === TERMINAL_LIST_STREAM) {
    if (shells.length === 0) {
      return () => undefined;
    }
    const deliverList = (): void => {
      deliver(checkedShellList(engine, shells), []);
    };
    deliverList();
    return engine.subscribe((events) => {
      if (events.some((event) => event.kind === LEASE_CHANGE_KIND)) {
        deliverList();
      }
    });
  }
  if (subscriptionName === TERMINAL_OUTPUT_STREAM) {
    const shell = shells.find((scripted) => scripted.terminalId === request["terminalId"]);
    if (shell !== undefined) {
      deliverScrollback(engine, shell, request["afterOffset"], deliver);
    }
  }
  return () => undefined;
}

/** The list update for every scripted shell, as the delivered log leaves its lease. */
function checkedShellList(engine: ScenarioEngine, shells: readonly ScenarioShell[]): unknown {
  const log = engine.deliveredEvents();
  const list = {
    sessionId: engine.scenario.sessionId,
    terminals: shells.map((shell) => {
      const lease = leaseOf(log, shell.terminalId);
      return {
        terminalId: shell.terminalId,
        title: shell.title,
        status: { state: "running" },
        holder: lease.holder,
        leaseVersion: lease.leaseVersion,
      };
    }),
  };
  if (!validateTerminalListUpdate(list)) {
    throw new FixtureBridgeError(
      TERMINAL_LIST_STREAM,
      "reply-off-contract",
      `the scenario's shells compose a list its generated check refuses at ` +
        faultPathsOf(validateTerminalListUpdate, list),
    );
  }
  return list;
}

/**
 * The scrollback frame of one shell, unless the watcher already holds every byte of it: its
 * window as one attachment, the output offset the window's last byte leaves.
 */
function deliverScrollback(
  engine: ScenarioEngine,
  shell: ScenarioShell,
  afterOffset: unknown,
  deliver: ShellStreamDelivery,
): void {
  const bytes = new TextEncoder().encode(shell.scrollback);
  if (afterOffset === bytes.byteLength) {
    return;
  }
  const lease = leaseOf(engine.deliveredEvents(), shell.terminalId);
  const attachments = [bytes];
  const frame = {
    changes: [
      {
        kind: "scrollback",
        sessionId: engine.scenario.sessionId,
        terminalId: shell.terminalId,
        data: { $bytes: 0 },
        columns: shell.columns,
        rows: shell.rows,
        holder: lease.holder,
        leaseVersion: lease.leaseVersion,
        cursor: bytes.byteLength,
      },
    ],
  };
  if (!validateTerminalOutputFrame.call({ attachments }, frame)) {
    throw new FixtureBridgeError(
      TERMINAL_OUTPUT_STREAM,
      "reply-off-contract",
      `the scenario's scrollback composes a frame its generated check refuses at ` +
        faultPathsOf(validateTerminalOutputFrame, frame),
    );
  }
  deliver(frame, attachments);
}

/** Who holds one shell and at which lease version, per the newest lease beat delivered for it. */
function leaseOf(
  log: readonly ProjectedSessionEvent[],
  terminalId: string,
): { readonly holder: TerminalControlHolder | null; readonly leaseVersion: number } {
  const payload = log.findLast(
    (event) => event.kind === LEASE_CHANGE_KIND && event.payload?.["terminalId"] === terminalId,
  )?.payload;
  if (payload === undefined) {
    return { holder: null, leaseVersion: 0 };
  }
  const { holderDeviceId, holderRunId, holderCommandId, leaseVersion } = payload;
  const holder =
    holderDeviceId === null
      ? null
      : ({
          holderDeviceId,
          ...(holderRunId === undefined ? {} : { holderRunId }),
          ...(holderCommandId === undefined ? {} : { holderCommandId }),
        } as TerminalControlHolder);
  return { holder, leaseVersion: leaseVersion as number };
}

/** Where `check` refused `value`, each member path dotted, for the authoring error. */
function faultPathsOf(check: SchemaCheck<unknown>, value: unknown): string {
  return checkFaultPaths(check, value)
    .map((fault) => fault.path.join(".") || "(root)")
    .join(", ");
}
