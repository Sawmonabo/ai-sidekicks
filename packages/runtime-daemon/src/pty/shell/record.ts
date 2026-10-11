// What the shell table holds for one shell of a session, and how a new one is built: its control
// lease, flow control, screen copy, marks, scrollback window and input and size queues, each host
// call naming the shell's terminal host session while it runs. A change of holder closes a paste
// the shell had open and forgets the appearance the last holder's pane reported; a terminal answer
// that comes while a marked paste is open follows that paste's end mark.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  TerminalIdSchema,
  type PtyControlChangedPayload,
  type PtyOpenRequest,
  type PtyShellStatus,
  type TerminalCellSize,
  type TerminalColors,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { mintUuidV7 } from "../../uuid-v7.js";
import { ShellControlLease, type ShellLeaseCaller } from "../control-lease.js";
import { ShellFlowControl } from "../flow-control.js";
import type { PtyHost } from "../host/contract.js";
import type { ShellMarkNonce } from "./integration/injection.js";
import { ShellMarkReader } from "./integration/marks.js";
import { ShellScreen } from "./output/screen.js";
import type { ShellOutputStream } from "./output/stream.js";
import { ShellPastes } from "./paste.js";
import { ShellResizeQueue, type ShellSize } from "./queue/resize.js";
import { ShellWriteQueue } from "./queue/write.js";
import { ScrollbackWindow } from "./scrollback.js";

/** The size a shell starts at before any pane sizes it: the conventional terminal's. */
export const INITIAL_SHELL_SIZE: ShellSize = { columns: 80, rows: 24 };

/** One shell of a session, as the shell table holds it. */
export interface ShellRecord {
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  readonly clientIdempotencyKey: string;
  /** The base name of the program started, its title until it sets its own. */
  readonly programName: string;
  /** The terminal host's id for the shell's PTY while it runs. */
  hostSessionId: string | null;
  /** Stops following the host session's output and exit; set while the shell runs. */
  unfollowPtySession: (() => void) | null;
  status: PtyShellStatus;
  readonly lease: ShellControlLease;
  readonly flowControl: ShellFlowControl;
  readonly screen: ShellScreen;
  /** The colors and cell size the holding pane last reported, until the shell changes holder. */
  paneAppearance: { readonly colors: TerminalColors; readonly cellSize: TerminalCellSize } | null;
  readonly markReader: ShellMarkReader | null;
  /** The file the shell reads its nonce from, until the shell has read it or never will. */
  markNonce: ShellMarkNonce | null;
  /** Whether a prompt mark carrying the shell's nonce has arrived; a shell without one has none. */
  isReportingMarks: boolean;
  readonly scrollback: ScrollbackWindow;
  /** Bytes of output, its marks taken out, since the shell started. */
  outputOffset: number;
  /** The size the shell was last drawn at, which stays while nobody holds it. */
  size: ShellSize;
  readonly writeQueue: ShellWriteQueue;
  readonly pastes: ShellPastes;
  readonly resizeQueue: ShellResizeQueue;
  /** The write frames awaiting their lease check, one after another in arrival order. */
  admissions: Promise<void>;
  readonly streams: Map<SubscriptionId, ShellOutputStream>;
  /** Whether a device typed into the shell since its last prompt mark. */
  hasInputSincePrompt: boolean;
}

/** How a new shell started: what it was opened with and what the host made of it. */
export interface ShellRecordStart {
  readonly request: PtyOpenRequest;
  readonly programName: string;
  readonly status: PtyShellStatus;
  /** The host's session for the shell, or `null` for a shell that did not start. */
  readonly hostSessionId: string | null;
  readonly markNonce: ShellMarkNonce | null;
}

/** What a shell's record calls back into the table for. */
export interface ShellRecordHooks {
  readonly host: PtyHost;
  /** This machine's own device id, which a run's hold names. */
  readonly machineDeviceId: DeviceId;
  /** What the shell's terminal answers a program asking its name and version. */
  readonly terminalVersion: string;
  /** Appends one change of the shell's holder to its session's event log. */
  readonly appendControlChange: (change: PtyControlChangedPayload) => Promise<void>;
  /** The console theme's terminal colors, for a shell whose holder reported none. */
  readonly readConsoleColors: () => TerminalColors | null;
  /** Queues bytes no caller waits on behind the shell's admitted input, reporting a failure. */
  readonly writeInput: (shell: ShellRecord, bytes: Uint8Array, failure: string) => void;
  /** Sends the session's shell list again. */
  readonly refreshList: (sessionId: SessionId) => void;
  /** Refuses a caller whose shell or subscription ended while its act waited. */
  readonly refuseEndedCaller: (
    shell: ShellRecord,
    caller: Pick<ShellLeaseCaller, "transportId" | "outputSubscriptionId">,
  ) => void;
}

/** Builds a new shell's record, with a fresh terminal id, at the size every shell starts at. */
export function createShellRecord(start: ShellRecordStart, hooks: ShellRecordHooks): ShellRecord {
  const { sessionId } = start.request;
  const terminalId = TerminalIdSchema.parse(mintUuidV7());
  const { host } = hooks;
  // Each host call is async, so a shell that stopped running fails the call that named it rather
  // than the queue that made it. A read or a size has nothing to do once it stopped.
  const ifRunning = async (call: (hostSession: string) => Promise<void>): Promise<void> => {
    if (shell.hostSessionId !== null) {
      await call(shell.hostSessionId);
    }
  };
  const shell: ShellRecord = {
    sessionId,
    terminalId,
    clientIdempotencyKey: start.request.clientIdempotencyKey,
    programName: start.programName,
    hostSessionId: start.hostSessionId,
    unfollowPtySession: null,
    status: start.status,
    lease: new ShellControlLease({
      sessionId,
      terminalId,
      machineDeviceId: hooks.machineDeviceId,
      broadcast: async (change) => {
        // The new holder's pane answers for the shell once it reports its own appearance.
        shell.paneAppearance = null;
        // The new holder's keys never land inside a paste the shell had open before.
        const closing = shell.pastes.closeAll();
        if (closing.byteLength > 0) {
          hooks.writeInput(shell, closing, "could not close a paste open as its holder changed");
        }
        try {
          await hooks.appendControlChange(change);
        } finally {
          hooks.refreshList(sessionId);
        }
      },
      refuseEndedCaller: (caller) => {
        hooks.refuseEndedCaller(shell, caller);
      },
    }),
    flowControl: new ShellFlowControl({
      pause: () => ifRunning((hostSession) => host.pause(hostSession)),
      resume: () => ifRunning((hostSession) => host.resume(hostSession)),
    }),
    screen: new ShellScreen({
      columns: INITIAL_SHELL_SIZE.columns,
      rows: INITIAL_SHELL_SIZE.rows,
      terminalVersion: hooks.terminalVersion,
      readAppearance: () => ({
        colors: shell.paneAppearance?.colors ?? hooks.readConsoleColors(),
        cellSize: shell.paneAppearance?.cellSize ?? null,
      }),
      answer: (answer) => {
        // A program that has stopped running takes no answer.
        if (shell.hostSessionId === null) {
          return;
        }
        const bytes = Buffer.from(answer, "utf8");
        if (!shell.pastes.holdAnswer(bytes)) {
          hooks.writeInput(shell, bytes, "could not take its terminal's answer");
        }
      },
      onTitleChange: () => {
        hooks.refreshList(sessionId);
      },
    }),
    paneAppearance: null,
    markReader: start.markNonce === null ? null : new ShellMarkReader(start.markNonce.nonce),
    markNonce: start.markNonce,
    isReportingMarks: false,
    scrollback: new ScrollbackWindow(),
    outputOffset: 0,
    size: INITIAL_SHELL_SIZE,
    writeQueue: new ShellWriteQueue(async (bytes) => {
      if (shell.hostSessionId === null) {
        throw new Error(`Shell ${terminalId} stopped running before its input was written`);
      }
      await host.write(shell.hostSessionId, bytes);
    }),
    pastes: new ShellPastes(),
    resizeQueue: new ShellResizeQueue((size) =>
      ifRunning((hostSession) => host.resize(hostSession, size.rows, size.columns)),
    ),
    admissions: Promise.resolve(),
    streams: new Map(),
    hasInputSincePrompt: false,
  };
  return shell;
}
