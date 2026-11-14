// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's shells as a client addresses them: the live list, opening, closing and ordering, one shell's output stream, writing and resizing, terminal appearance, flow control, and the per-shell control lease.

import type { SchemaCheck } from "../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "./checks/jsonrpc/streaming.js";
import { validateNullPayload } from "./checks/method-descriptor.js";
import {
  validateTerminalAppearanceReportRequest,
  validateTerminalCloseRequest,
  validateTerminalControlTakeRequest,
  validateTerminalControlTakeResponse,
  validateTerminalFlowControlUpdateRequest,
  validateTerminalFlowControlUpdateResponse,
  validateTerminalListUpdate,
  validateTerminalOpenRequest,
  validateTerminalOpenResponse,
  validateTerminalOutputFrame,
  validateTerminalOutputSubscribeRequest,
  validateTerminalReorderRequest,
  validateTerminalResizeRequest,
  validateTerminalSubscribeRequest,
  validateTerminalWriteRequest,
} from "./checks/terminal.js";
import type { HexColor } from "./color.js";
import type { CommandId } from "./command.js";
import type { SubscribeAcknowledgmentResponse, SubscriptionId } from "./jsonrpc/streaming.js";
import type { NullPayload } from "./method-descriptor.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";
import type { DeviceId } from "./trust-statement.js";

/** How many colors a terminal's ANSI palette holds: eight and their eight bright forms. */
export const TERMINAL_PALETTE_LENGTH = 16 as const;

/** The longest terminal id the daemon accepts. */
export const TERMINAL_ID_MAX_LEN = 256 as const;

/**
 * The longest title a shell carries on the wire, in code points; the daemon cuts a longer
 * title the shell sets to whole graphemes within it, and within it to whole code points only
 * when one grapheme alone is longer.
 */
export const SHELL_TITLE_MAX_LEN = 256 as const;

/**
 * The most UTF-8 bytes one `terminal.write`'s `data` holds, counted on its text before JSON
 * escapes it, so a client splits a paste by the text's own bytes.
 */
export const TERMINAL_WRITE_MAX_BYTES = 65536 as const;

/**
 * How many writes to one shell a client keeps waiting for an answer before it joins its next
 * typed keys into later writes, sent in order as answers return.
 */
export const TERMINAL_WRITES_WAITING_PER_SHELL = 8 as const;

/**
 * How many of one connection's writes to one shell may wait for an answer; a write that finds
 * this many waiting is refused `terminal.write.limitReached`. Twice the client's own figure,
 * so an interrupt, quit or suspend key sent at once with the keys before it still fits.
 */
export const TERMINAL_WRITES_WAITING_LIMIT = 16 as const;

/** The event every change of one shell's holder is broadcast on. */
export const TERMINAL_CONTROL_CHANGED_EVENT = "terminal.control.changed" as const;

/** Every reason a shell's holder can change. */
export const TERMINAL_CONTROL_CHANGED_REASONS = [
  "taken",
  "takenByForce",
  "autoReleasedDisconnect",
  "autoReleasedPaneClosed",
  "autoReleasedCommandEnded",
  "autoReleasedRunIdle",
] as const;

/**
 * The daemon-minted id of one shell in a session, opaque to every client.
 */
export type TerminalId = string & { readonly __brand: "TerminalId" };
/**
 * Where one shell's process stands. A shell that ends keeps its entry with its exit code until it
 * is closed; a shell that could not start keeps its entry with the daemon's words for why, and
 * takes no input.
 */
export type TerminalShellStatus =
  | {
      state: "running";
    }
  | {
      state: "exited";
      /**
       * The program's exit code.
       */
      exitCode: number;
    }
  | {
      state: "didNotStart";
      /**
       * The daemon's words for why.
       */
      cause: string;
    };
/**
 * One change on a shell's output stream; `cursor` is the shell's output offset once the change is
 * applied, in bytes since the shell started. `scrollback` opens the scrollback window, starting at
 * its first whole line, with the columns and rows it was last drawn at (so a running program's
 * boxes come back unwrapped) and who holds it at which lease version; a window too large for one
 * message goes on in `scrollbackContinuation` changes, each in a frame of its own, before any
 * output. `output` is what the shell wrote next, in order; `exited` is its program's end. Output
 * and scrollback travel as raw bytes, an attachment each, with no character held back.
 */
export type TerminalOutputChange =
  | {
      kind: "scrollback";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The window's bytes.
       */
      data: Uint8Array;
      /**
       * The columns it was last drawn at.
       */
      columns: number;
      /**
       * The rows it was last drawn at.
       */
      rows: number;
      /**
       * Who holds the shell, or `null`.
       */
      holder: TerminalControlHolder | null;
      /**
       * The lease version the holder was read at.
       */
      leaseVersion: number;
      /**
       * The output offset after the change.
       */
      cursor: number;
    }
  | {
      kind: "scrollbackContinuation";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The window's next bytes.
       */
      data: Uint8Array;
      /**
       * The output offset after the change.
       */
      cursor: number;
    }
  | {
      kind: "output";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The bytes.
       */
      data: Uint8Array;
      /**
       * The output offset after the change.
       */
      cursor: number;
    }
  | {
      kind: "exited";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The program's exit code.
       */
      exitCode: number;
      /**
       * The output offset after the change.
       */
      cursor: number;
    };
/**
 * `terminal.write`: input for one shell, written as it arrives; the writer's connection must hold
 * the shell. The write is bound to `outputSubscriptionId`, the writing pane's own
 * output feed (`terminal.output.subscribe`) of that shell: a first write to a shell nobody holds
 * takes it through that subscription, and a holding connection's write binds it to the hold.
 * `keys` is typed text. A `paste` is pasted text sent in one or more parts, each under the wire's
 * message cap, all naming the client-minted `pasteId` and the last one `isLastPart`; when the
 * program in the shell asked for pasted text to be marked as pasted, the daemon marks the whole
 * paste once around all its parts. Each pane has one paste open at a time: a part naming a new
 * `pasteId` closes the pane's earlier paste first. Each write's `data` is at most
 * `TERMINAL_WRITE_MAX_BYTES` of UTF-8. The daemon answers a write once the shell's write queue
 * takes it, which it does while the queue holds less than 64 KiB, so typing into a program that
 * is not reading holds no call open and a paste past the queue's bound is paced by the shell. A
 * write takes no slot of the connection's call cap: a client keeps at most
 * `TERMINAL_WRITES_WAITING_PER_SHELL` writes per shell waiting for an answer, and the daemon
 * refuses one that finds `TERMINAL_WRITES_WAITING_LIMIT` of its connection's writes to that shell
 * waiting.
 */
export type TerminalWriteRequest =
  | {
      kind: "keys";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The writing pane's output subscription.
       */
      outputSubscriptionId: SubscriptionId;
      /**
       * The text, at most [`TERMINAL_WRITE_MAX_BYTES`] of UTF-8.
       */
      data: string;
    }
  | {
      kind: "paste";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The writing pane's output subscription.
       */
      outputSubscriptionId: SubscriptionId;
      /**
       * The part's text, at most [`TERMINAL_WRITE_MAX_BYTES`] of UTF-8.
       */
      data: string;
      /**
       * The paste, minted by the client.
       */
      pasteId: string;
      /**
       * Whether this is the paste's last part.
       */
      isLastPart: boolean;
    };
/**
 * `terminal.appearance.report`: the appearance the daemon answers a program's questions about
 * its terminal from, as no screen answers them. `consoleTheme` is the console theme's terminal
 * colors, which the desktop reports on connecting and at every change of appearance; it serves
 * every shell whose holder reported none. `holdingPane` is the colors and cell size of the pane
 * holding the shell, which only a connection the shell's hold is bound to may report, refused as a
 * resize from another is; it outranks the console theme until the shell changes holder.
 */
export type TerminalAppearanceReportRequest =
  | {
      source: "consoleTheme";
      /**
       * The colors.
       */
      colors: TerminalColors;
    }
  | {
      source: "holdingPane";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The colors.
       */
      colors: TerminalColors;
      /**
       * The cell size.
       */
      cellSize: TerminalCellSize;
    };
/**
 * Why a shell's holder changed: it was taken, taken by force off another device, the holding
 * connection ended, the pane's output subscription it was taken through closed, the holding run's
 * command ended, or the holding run left its running state. A run's two releases hand the shell
 * back to the device the run took it from, while one of that device's bindings is open.
 */
export type TerminalControlChangedReason =
  | "taken"
  | "takenByForce"
  | "autoReleasedDisconnect"
  | "autoReleasedPaneClosed"
  | "autoReleasedCommandEnded"
  | "autoReleasedRunIdle";
/**
 * The `terminal.control.changed` payload: one change of one shell's holder. The holder
 * members name who holds it after the change, `previousHolderDeviceId` who held it before,
 * and `leaseVersion` the change's lease version. A take names a holder, every release
 * names the holder it ended, a disconnect or a closed pane names nobody after it, a run's
 * release names the device it hands the shell back to or nobody, and a forced take moves
 * the shell off another device to a device. Clients keep the newest version they have read
 * and never infer a holder from a take they made.
 */
export type TerminalControlChangedPayload =
  | {
      reason: "taken";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The change's lease version.
       */
      leaseVersion: number;
      /**
       * The device holding it after the take.
       */
      holderDeviceId: DeviceId;
      /**
       * The holding run.
       */
      holderRunId?: RunId;
      /**
       * The holding command.
       */
      holderCommandId?: CommandId;
      /**
       * The device that held it before, or `null`.
       */
      previousHolderDeviceId: DeviceId | null;
    }
  | {
      reason: "takenByForce";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The change's lease version.
       */
      leaseVersion: number;
      /**
       * The device holding it after the take.
       */
      holderDeviceId: DeviceId;
      /**
       * Never present: no run takes a shell by force.
       */
      holderRunId?: never;
      /**
       * Never present: no run takes a shell by force.
       */
      holderCommandId?: never;
      /**
       * The device it was moved off.
       */
      previousHolderDeviceId: DeviceId;
    }
  | {
      reason: "autoReleasedDisconnect";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The change's lease version.
       */
      leaseVersion: number;
      /**
       * The device holding it after the release.
       */
      holderDeviceId: null;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderRunId?: never;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderCommandId?: never;
      /**
       * The holder the release ended.
       */
      previousHolderDeviceId: DeviceId;
    }
  | {
      reason: "autoReleasedPaneClosed";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The change's lease version.
       */
      leaseVersion: number;
      /**
       * The device holding it after the release.
       */
      holderDeviceId: null;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderRunId?: never;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderCommandId?: never;
      /**
       * The holder the release ended.
       */
      previousHolderDeviceId: DeviceId;
    }
  | {
      reason: "autoReleasedCommandEnded";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The change's lease version.
       */
      leaseVersion: number;
      /**
       * The device holding it after the release.
       */
      holderDeviceId: DeviceId | null;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderRunId?: never;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderCommandId?: never;
      /**
       * The holder the release ended.
       */
      previousHolderDeviceId: DeviceId;
    }
  | {
      reason: "autoReleasedRunIdle";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The shell.
       */
      terminalId: TerminalId;
      /**
       * The change's lease version.
       */
      leaseVersion: number;
      /**
       * The device holding it after the release.
       */
      holderDeviceId: DeviceId | null;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderRunId?: never;
      /**
       * Never present: a release leaves no run holding the shell.
       */
      holderCommandId?: never;
      /**
       * The holder the release ended.
       */
      previousHolderDeviceId: DeviceId;
    };

/**
 * Who holds one shell's control lease; a run's hold names its command.
 */
export interface TerminalControlHolder {
  /**
   * The holding device: this machine's own while a run holds the shell.
   */
  holderDeviceId: DeviceId;
  /**
   * The holding run, whose agent the screen reads from the run.
   */
  holderRunId?: RunId;
  /**
   * The holding command, which is what stopping the hold stops.
   */
  holderCommandId?: CommandId;
}
/**
 * `terminal.subscribe`: the session whose shells the subscription follows.
 */
export interface TerminalSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One shell as the tab strip draws it. `title` is the title the shell set for itself, or its
 * program's base name until it sets one. `holder` is `null` while nobody holds the shell, and
 * `leaseVersion` is the lease version that holder was read at.
 */
export interface TerminalListEntry {
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * Its title.
   */
  title: string;
  /**
   * Where its process stands.
   */
  status: TerminalShellStatus;
  /**
   * Who holds it, or `null`.
   */
  holder: TerminalControlHolder | null;
  /**
   * The lease version the holder was read at.
   */
  leaseVersion: number;
}
/**
 * The session's whole set of shells, sent on every change, in tab order. The order is the
 * daemon's, so every device draws the same strip. A shell gone before the list was first read is
 * not in it, and a shell appears at most once.
 */
export interface TerminalListUpdate {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its shells, in tab order.
   */
  terminals: TerminalListEntry[];
}
/**
 * `terminal.open`: another shell for the session, the person's own login shell in the session's
 * tree, so the request carries no program, arguments or folder. The caller mints the key, and a
 * retry with the same key never opens a second shell.
 */
export interface TerminalOpenRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The caller's key for this open.
   */
  clientIdempotencyKey: string;
}
/**
 * The new shell's id. A shell that fails to start still has one: its tab stays and its list entry
 * reads `didNotStart` with the cause.
 */
export interface TerminalOpenResponse {
  /**
   * The shell.
   */
  terminalId: TerminalId;
}
/**
 * `terminal.close`: closes one shell and ends its process; closing several sends this once per
 * shell. The daemon refuses it while a run holds the shell, and while another device holds it
 * unless `force` is true, which the screen sends only after the person confirmed.
 */
export interface TerminalCloseRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * Whether to close it off another device.
   */
  force?: boolean;
}
/**
 * `terminal.reorder`: the session's shells in their new tab order, each named at most once.
 */
export interface TerminalReorderRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The shells, in their new order.
   *
   * @minItems 1
   */
  terminalIds: [TerminalId, ...TerminalId[]];
}
/**
 * `terminal.output.subscribe`: the shell whose output the subscription streams. `afterOffset` is
 * where a watcher that reconnects got to: while that offset is still inside the scrollback window
 * it gets only the bytes after it, and a fresh `scrollback` otherwise.
 */
export interface TerminalOutputSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * The output offset the watcher already has.
   */
  afterOffset?: number;
}
/**
 * One notify of a shell's output stream. The first frame opens with the `scrollback` change, and
 * the frames that continue the window follow it. A watcher that fell behind stops receiving
 * output, and once it has caught up its next frame carries the drop mark and a fresh `scrollback`
 * change, so it redraws from the scrollback window and no byte reaches it twice; one still behind
 * when the shell exits gets the drop mark, a fresh `scrollback` change and the `exited` change.
 */
export interface TerminalOutputFrame {
  /**
   * The changes, oldest first.
   *
   * @minItems 1
   * @maxItems 50
   */
  changes: [TerminalOutputChange, ...TerminalOutputChange[]];
  /**
   * Present on the frame after a drop.
   */
  dropped?: true;
}
/**
 * `terminal.resize`: a shell's new size in character cells. Only a connection holding it sets it;
 * watchers follow.
 */
export interface TerminalResizeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * Columns.
   */
  columns: number;
  /**
   * Rows.
   */
  rows: number;
}
/**
 * The colors a terminal draws with, which a program asking its terminal for them is answered.
 */
export interface TerminalColors {
  /**
   * The text color.
   */
  foreground: HexColor;
  /**
   * The background.
   */
  background: HexColor;
  /**
   * The cursor.
   */
  cursor: HexColor;
  /**
   * The sixteen ANSI colors in their numbered order, black first and bright white last.
   *
   * @minItems 16
   * @maxItems 16
   */
  palette: [
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
    HexColor,
  ];
}
/**
 * One character cell of a pane's grid, in CSS pixels.
 */
export interface TerminalCellSize {
  /**
   * Width.
   */
  width: number;
  /**
   * Height.
   */
  height: number;
}
/**
 * `terminal.flowControl.update`: the state this connection declares for one shell, `paused`
 * while it is behind, false once it has caught up. The daemon stops reading the shell only while
 * every live watcher is behind, and a connection's state clears when it disconnects. Not gated by
 * the lease: it moves no bytes toward the shell. A call naming a shell its session does not have
 * changes nothing and is not refused.
 */
export interface TerminalFlowControlUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * Whether the connection is behind.
   */
  paused: boolean;
}
/**
 * The declared state was taken; nothing is read back.
 */
export interface TerminalFlowControlUpdateResponse {
  /**
   * Always true.
   */
  accepted: true;
}
/**
 * `terminal.control.take`: takes one shell's lease for the calling connection, bound to
 * `outputSubscriptionId`, the taking pane's own output feed (`terminal.output.subscribe`) of that
 * shell, whose end gives the hold back. `force` moves it off another of the person's devices; a
 * take never moves it off a run.
 */
export interface TerminalControlTakeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * The taking pane's output subscription.
   */
  outputSubscriptionId: SubscriptionId;
  /**
   * Whether to move the shell off another device.
   */
  force?: boolean;
}
/**
 * The shell and the calling device, which now holds it.
 */
export interface TerminalControlTakeResponse {
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * The calling device.
   */
  holderDeviceId: DeviceId;
}
/**
 * The `terminal.control.heldByOther` refusal's details: the shell and who holds it, so the
 * screen can tell a run's hold, which ends with its command and which no take moves, from
 * another device's, which a forced take or close moves.
 */
export interface TerminalControlHeldByOtherDetails {
  /**
   * The shell.
   */
  terminalId: TerminalId;
  /**
   * The holding device: this machine's own while a run holds the shell.
   */
  holderDeviceId: DeviceId;
  /**
   * The holding run, whose agent the screen reads from the run.
   */
  holderRunId?: RunId;
  /**
   * The holding command, which is what stopping the hold stops.
   */
  holderCommandId?: CommandId;
}

export {
  validateTerminalAppearanceReportRequest,
  validateTerminalCellSize,
  validateTerminalCloseRequest,
  validateTerminalColors,
  validateTerminalControlChangedPayload,
  validateTerminalControlHeldByOtherDetails,
  validateTerminalControlHolder,
  validateTerminalControlTakeRequest,
  validateTerminalControlTakeResponse,
  validateTerminalFlowControlUpdateRequest,
  validateTerminalFlowControlUpdateResponse,
  validateTerminalId,
  validateTerminalListEntry,
  validateTerminalListUpdate,
  validateTerminalOpenRequest,
  validateTerminalOpenResponse,
  validateTerminalOutputChange,
  validateTerminalOutputFrame,
  validateTerminalOutputSubscribeRequest,
  validateTerminalReorderRequest,
  validateTerminalResizeRequest,
  validateTerminalShellStatus,
  validateTerminalSubscribeRequest,
  validateTerminalWriteRequest,
} from "./checks/terminal.js";

/** The methods of {@link TERMINAL_METHOD_DESCRIPTORS}, each with its checks. */
export interface TerminalMethodDescriptors {
  readonly "terminal.subscribe": {
    readonly method: "terminal.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TerminalSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<TerminalListUpdate>;
  };
  readonly "terminal.open": {
    readonly method: "terminal.open";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalOpenRequest>;
    readonly responseCheck: SchemaCheck<TerminalOpenResponse>;
  };
  readonly "terminal.close": {
    readonly method: "terminal.close";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalCloseRequest>;
    readonly responseCheck: SchemaCheck<NullPayload>;
  };
  readonly "terminal.reorder": {
    readonly method: "terminal.reorder";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalReorderRequest>;
    readonly responseCheck: SchemaCheck<NullPayload>;
  };
  readonly "terminal.output.subscribe": {
    readonly method: "terminal.output.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<TerminalOutputSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<TerminalOutputFrame>;
  };
  readonly "terminal.write": {
    readonly method: "terminal.write";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalWriteRequest>;
    readonly responseCheck: SchemaCheck<NullPayload>;
  };
  readonly "terminal.resize": {
    readonly method: "terminal.resize";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalResizeRequest>;
    readonly responseCheck: SchemaCheck<NullPayload>;
  };
  readonly "terminal.appearance.report": {
    readonly method: "terminal.appearance.report";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalAppearanceReportRequest>;
    readonly responseCheck: SchemaCheck<NullPayload>;
  };
}
/** Every `terminal.*` method. */
export const TERMINAL_METHOD_DESCRIPTORS: TerminalMethodDescriptors = /* @__PURE__ */ Object.freeze(
  {
    "terminal.subscribe": /* @__PURE__ */ Object.freeze({
      method: "terminal.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateTerminalSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateTerminalListUpdate,
    }),
    "terminal.open": /* @__PURE__ */ Object.freeze({
      method: "terminal.open",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalOpenRequest,
      responseCheck: validateTerminalOpenResponse,
    }),
    "terminal.close": /* @__PURE__ */ Object.freeze({
      method: "terminal.close",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalCloseRequest,
      responseCheck: validateNullPayload,
    }),
    "terminal.reorder": /* @__PURE__ */ Object.freeze({
      method: "terminal.reorder",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalReorderRequest,
      responseCheck: validateNullPayload,
    }),
    "terminal.output.subscribe": /* @__PURE__ */ Object.freeze({
      method: "terminal.output.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateTerminalOutputSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateTerminalOutputFrame,
    }),
    "terminal.write": /* @__PURE__ */ Object.freeze({
      method: "terminal.write",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalWriteRequest,
      responseCheck: validateNullPayload,
    }),
    "terminal.resize": /* @__PURE__ */ Object.freeze({
      method: "terminal.resize",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalResizeRequest,
      responseCheck: validateNullPayload,
    }),
    "terminal.appearance.report": /* @__PURE__ */ Object.freeze({
      method: "terminal.appearance.report",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalAppearanceReportRequest,
      responseCheck: validateNullPayload,
    }),
  },
);

/** The methods of {@link TERMINAL_CONTROL_METHOD_DESCRIPTORS}, each with its checks. */
export interface TerminalControlMethodDescriptors {
  readonly "terminal.control.take": {
    readonly method: "terminal.control.take";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalControlTakeRequest>;
    readonly responseCheck: SchemaCheck<TerminalControlTakeResponse>;
  };
  readonly "terminal.flowControl.update": {
    readonly method: "terminal.flowControl.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<TerminalFlowControlUpdateRequest>;
    readonly responseCheck: SchemaCheck<TerminalFlowControlUpdateResponse>;
  };
}
/** The two `terminal.*` methods that act on one shell: the lease take and flow control. */
export const TERMINAL_CONTROL_METHOD_DESCRIPTORS: TerminalControlMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "terminal.control.take": /* @__PURE__ */ Object.freeze({
      method: "terminal.control.take",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalControlTakeRequest,
      responseCheck: validateTerminalControlTakeResponse,
    }),
    "terminal.flowControl.update": /* @__PURE__ */ Object.freeze({
      method: "terminal.flowControl.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateTerminalFlowControlUpdateRequest,
      responseCheck: validateTerminalFlowControlUpdateResponse,
    }),
  });
