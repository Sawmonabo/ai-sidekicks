/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's shells as a client addresses them: the live list, opening, closing and ordering, one shell's output stream, writing and resizing, terminal appearance, flow control, and the per-shell control lease.

import { type SchemaCheck, deepEqual, ucs2length } from "../schema-check.js";
import type { HexColor } from "./color.js";
import type { CommandId } from "./command.js";
import {
  type SubscribeAcknowledgmentResponse,
  type SubscriptionId,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type NullPayload, validateNullPayload } from "./method-descriptor.js";
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
      holderDeviceId: never;
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
      holderDeviceId: never;
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

// prettier-ignore
const pattern353 = new RegExp("^#[0-9a-fA-F]{6}$", "u");
// prettier-ignore
function validate2129(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2129.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.foreground === undefined) && (missing0 = "foreground")) || ((data.background === undefined) && (missing0 = "background"))) || ((data.cursor === undefined) && (missing0 = "cursor"))) || ((data.palette === undefined) && (missing0 = "palette"))){validate2129.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "foreground") || (key0 === "background")) || (key0 === "cursor")) || (key0 === "palette"))){validate2129.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.foreground !== undefined){let data0: any = data.foreground;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern353.test(data0)){validate2129.errors = [{instancePath:instancePath+"/foreground",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2129.errors = [{instancePath:instancePath+"/foreground",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.background !== undefined){let data1: any = data.background;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern353.test(data1)){validate2129.errors = [{instancePath:instancePath+"/background",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2129.errors = [{instancePath:instancePath+"/background",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){let data2: any = data.cursor;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern353.test(data2)){validate2129.errors = [{instancePath:instancePath+"/cursor",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2129.errors = [{instancePath:instancePath+"/cursor",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.palette !== undefined){let data3: any = data.palette;const _errs11: any = errors;if(errors === _errs11){if(Array.isArray(data3)){if(data3.length > 16){validate2129.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {if(data3.length < 16){validate2129.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/minItems",keyword:"minItems",params:{limit: 16}}];return false;}else {var valid4: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){let data4: any = data3[i0];const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(!pattern353.test(data4)){validate2129.errors = [{instancePath:instancePath+"/palette/" + i0,schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2129.errors = [{instancePath:instancePath+"/palette/" + i0,schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs13 === errors;if(!valid4){break;}}}}}else {validate2129.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate2129.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2129.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2129.errors = null as any[] | null;
// prettier-ignore
validate2129.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2128(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalAppearanceReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2128.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2128.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.source;if(typeof tag0 == "string"){if(tag0 === "consoleTheme"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.source === undefined) && (missing0 = "source")) || ((data.colors === undefined) && (missing0 = "colors"))){validate2128.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "source") || (key1 === "colors"))){validate2128.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.source !== undefined){let data0: any = data.source;const _errs6: any = errors;if(typeof data0 !== "string"){validate2128.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/0/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}if("consoleTheme" !== data0){validate2128.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/0/properties/source/const",keyword:"const",params:{allowedValue: "consoleTheme"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.colors !== undefined){const _errs8: any = errors;if(!(validate2129.call(this, data.colors, {instancePath:instancePath+"/colors",parentData:data,parentDataProperty:"colors",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2129.errors : vErrors.concat(validate2129.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate2128.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "holdingPane"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.source === undefined) && (missing1 = "source")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.colors === undefined) && (missing1 = "colors"))) || ((data.cellSize === undefined) && (missing1 = "cellSize"))){validate2128.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key2 in data){if(!(((((key2 === "source") || (key2 === "sessionId")) || (key2 === "terminalId")) || (key2 === "colors")) || (key2 === "cellSize"))){validate2128.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs11 === errors){if(data.source !== undefined){let data2: any = data.source;const _errs12: any = errors;if(typeof data2 !== "string"){validate2128.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/1/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}if("holdingPane" !== data2){validate2128.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/1/properties/source/const",keyword:"const",params:{allowedValue: "holdingPane"}}];return false;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){let data3: any = data.sessionId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2128.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2128.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.terminalId !== undefined){let data4: any = data.terminalId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(func1(data4) > 256){validate2128.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate2128.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2128.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.colors !== undefined){const _errs22: any = errors;if(!(validate2129.call(this, data.colors, {instancePath:instancePath+"/colors",parentData:data,parentDataProperty:"colors",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2129.errors : vErrors.concat(validate2129.errors);errors = vErrors.length;}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.cellSize !== undefined){let data6: any = data.cellSize;const _errs23: any = errors;const _errs24: any = errors;if(errors === _errs24){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing2: any;if(((data6.width === undefined) && (missing2 = "width")) || ((data6.height === undefined) && (missing2 = "height"))){validate2128.errors = [{instancePath:instancePath+"/cellSize",schemaPath:"#/$defs/TerminalCellSize/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs26: any = errors;for(const key3 in data6){if(!((key3 === "width") || (key3 === "height"))){validate2128.errors = [{instancePath:instancePath+"/cellSize",schemaPath:"#/$defs/TerminalCellSize/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs26 === errors){if(data6.width !== undefined){let data7: any = data6.width;const _errs27: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate2128.errors = [{instancePath:instancePath+"/cellSize/width",schemaPath:"#/$defs/TerminalCellSize/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs27){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate2128.errors = [{instancePath:instancePath+"/cellSize/width",schemaPath:"#/$defs/TerminalCellSize/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 1 || isNaN(data7)){validate2128.errors = [{instancePath:instancePath+"/cellSize/width",schemaPath:"#/$defs/TerminalCellSize/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid8: any = _errs27 === errors;}else {var valid8: any = true;}if(valid8){if(data6.height !== undefined){let data8: any = data6.height;const _errs29: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate2128.errors = [{instancePath:instancePath+"/cellSize/height",schemaPath:"#/$defs/TerminalCellSize/properties/height/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs29){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validate2128.errors = [{instancePath:instancePath+"/cellSize/height",schemaPath:"#/$defs/TerminalCellSize/properties/height/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 1 || isNaN(data8)){validate2128.errors = [{instancePath:instancePath+"/cellSize/height",schemaPath:"#/$defs/TerminalCellSize/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid8: any = _errs29 === errors;}else {var valid8: any = true;}}}}}else {validate2128.errors = [{instancePath:instancePath+"/cellSize",schemaPath:"#/$defs/TerminalCellSize/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs23 === errors;}else {var valid4: any = true;}}}}}}}}else {validate2128.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2128.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "source", tagValue: tag0}}];return false;}}else {validate2128.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "source", tagValue: tag0}}];return false;}}}else {validate2128.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2128.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2128.errors = null as any[] | null;
// prettier-ignore
validate2128.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2132(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalCellSize {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2132.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.width === undefined) && (missing0 = "width")) || ((data.height === undefined) && (missing0 = "height"))){validate2132.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "width") || (key0 === "height"))){validate2132.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.width !== undefined){let data0: any = data.width;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate2132.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate2132.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate2132.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.height !== undefined){let data1: any = data.height;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2132.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate2132.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate2132.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate2132.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2132.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2132.errors = null as any[] | null;
// prettier-ignore
validate2132.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2133(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalCloseRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2133.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))){validate2133.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "force"))){validate2133.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2133.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2133.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){let data1: any = data.terminalId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2133.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2133.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2133.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.force !== undefined){const _errs10: any = errors;if(typeof data.force !== "boolean"){validate2133.errors = [{instancePath:instancePath+"/force",schemaPath:"#/properties/force/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2133.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2133.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2133.errors = null as any[] | null;
// prettier-ignore
validate2133.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2134(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalColors {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2134.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.foreground === undefined) && (missing0 = "foreground")) || ((data.background === undefined) && (missing0 = "background"))) || ((data.cursor === undefined) && (missing0 = "cursor"))) || ((data.palette === undefined) && (missing0 = "palette"))){validate2134.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "foreground") || (key0 === "background")) || (key0 === "cursor")) || (key0 === "palette"))){validate2134.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.foreground !== undefined){let data0: any = data.foreground;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern353.test(data0)){validate2134.errors = [{instancePath:instancePath+"/foreground",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2134.errors = [{instancePath:instancePath+"/foreground",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.background !== undefined){let data1: any = data.background;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern353.test(data1)){validate2134.errors = [{instancePath:instancePath+"/background",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2134.errors = [{instancePath:instancePath+"/background",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){let data2: any = data.cursor;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern353.test(data2)){validate2134.errors = [{instancePath:instancePath+"/cursor",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2134.errors = [{instancePath:instancePath+"/cursor",schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.palette !== undefined){let data3: any = data.palette;const _errs11: any = errors;if(errors === _errs11){if(Array.isArray(data3)){if(data3.length > 16){validate2134.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {if(data3.length < 16){validate2134.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/minItems",keyword:"minItems",params:{limit: 16}}];return false;}else {var valid4: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){let data4: any = data3[i0];const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(!pattern353.test(data4)){validate2134.errors = [{instancePath:instancePath+"/palette/" + i0,schemaPath:"sidekicks-contracts:color#/$defs/HexColor/pattern",keyword:"pattern",params:{pattern: "^#[0-9a-fA-F]{6}$"}}];return false;}}else {validate2134.errors = [{instancePath:instancePath+"/palette/" + i0,schemaPath:"sidekicks-contracts:color#/$defs/HexColor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs13 === errors;if(!valid4){break;}}}}}else {validate2134.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate2134.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2134.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2134.errors = null as any[] | null;
// prettier-ignore
validate2134.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate2135(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlChangedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2135.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(data.holderRunId !== undefined && ((data.holderCommandId === undefined) && (missing0 = "holderCommandId"))){validate2135.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderRunId",
    missingProperty: missing0,
    depsCount: 1,
    deps: "holderCommandId"}}];return false;}else {if(data.holderCommandId !== undefined && ((data.holderRunId === undefined) && (missing0 = "holderRunId"))){validate2135.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderCommandId",
    missingProperty: missing0,
    depsCount: 1,
    deps: "holderRunId"}}];return false;}else {const _errs2: any = errors;for(const key0 in data){validate2135.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.reason;if(typeof tag0 == "string"){if(tag0 === "taken"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.reason === undefined) && (missing1 = "reason")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing1 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing1 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing1 = "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((((((key1 === "reason") || (key1 === "sessionId")) || (key1 === "terminalId")) || (key1 === "leaseVersion")) || (key1 === "holderDeviceId")) || (key1 === "holderRunId")) || (key1 === "holderCommandId")) || (key1 === "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.reason !== undefined){let data0: any = data.reason;const _errs6: any = errors;if(typeof data0 !== "string"){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("taken" !== data0){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/const",keyword:"const",params:{allowedValue: "taken"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.terminalId !== undefined){let data2: any = data.terminalId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(func1(data2) > 256){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.leaseVersion !== undefined){let data3: any = data.leaseVersion;const _errs16: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.holderDeviceId !== undefined){let data4: any = data.holderDeviceId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(func1(data4) > 256){validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data4)){validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.holderRunId !== undefined){let data5: any = data.holderRunId;const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.holderCommandId !== undefined){let data6: any = data.holderCommandId;const _errs26: any = errors;const _errs27: any = errors;if(errors === _errs27){if(typeof data6 === "string"){if(func1(data6) > 256){validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs26 === errors;}else {var valid2: any = true;}if(valid2){if(data.previousHolderDeviceId !== undefined){let data7: any = data.previousHolderDeviceId;const _errs30: any = errors;const _errs31: any = errors;let valid8: any = false;const _errs32: any = errors;const _errs33: any = errors;if(errors === _errs33){if(typeof data7 === "string"){if(func1(data7) > 256){const err0: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(!pattern6.test(data7)){const err1: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}else {const err2: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs32 === errors;valid8 = valid8 || _valid0;const _errs36: any = errors;if(data7 !== null){const err3: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"#/oneOf/0/properties/previousHolderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs36 === errors;valid8 = valid8 || _valid0;if(!valid8){const err4: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"#/oneOf/0/properties/previousHolderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate2135.errors = vErrors;return false;}else {errors = _errs31;if(vErrors !== null){if(_errs31){vErrors.length = _errs31;}else {vErrors = null;}}}var valid2: any = _errs30 === errors;}else {var valid2: any = true;}}}}}}}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "takenByForce"){const _errs38: any = errors;if(errors === _errs38){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.reason === undefined) && (missing2 = "reason")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.terminalId === undefined) && (missing2 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing2 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing2 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing2 = "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs40: any = errors;for(const key2 in data){if(!((((((((key2 === "reason") || (key2 === "sessionId")) || (key2 === "terminalId")) || (key2 === "leaseVersion")) || (key2 === "holderDeviceId")) || (key2 === "holderRunId")) || (key2 === "holderCommandId")) || (key2 === "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs40 === errors){if(data.reason !== undefined){let data8: any = data.reason;const _errs41: any = errors;if(typeof data8 !== "string"){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("takenByForce" !== data8){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/const",keyword:"const",params:{allowedValue: "takenByForce"}}];return false;}var valid11: any = _errs41 === errors;}else {var valid11: any = true;}if(valid11){if(data.sessionId !== undefined){let data9: any = data.sessionId;const _errs43: any = errors;const _errs44: any = errors;if(errors === _errs44){if(typeof data9 === "string"){if(!pattern4.test(data9)){validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs43 === errors;}else {var valid11: any = true;}if(valid11){if(data.terminalId !== undefined){let data10: any = data.terminalId;const _errs47: any = errors;const _errs48: any = errors;if(errors === _errs48){if(typeof data10 === "string"){if(func1(data10) > 256){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data10) < 1){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs47 === errors;}else {var valid11: any = true;}if(valid11){if(data.leaseVersion !== undefined){let data11: any = data.leaseVersion;const _errs51: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/1/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs51){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/1/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 1 || isNaN(data11)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/1/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid11: any = _errs51 === errors;}else {var valid11: any = true;}if(valid11){if(data.holderDeviceId !== undefined){let data12: any = data.holderDeviceId;const _errs53: any = errors;const _errs54: any = errors;if(errors === _errs54){if(typeof data12 === "string"){if(func1(data12) > 256){validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data12)){validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs53 === errors;}else {var valid11: any = true;}if(valid11){if(data.holderRunId !== undefined){const _errs57: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/1/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid11: any = _errs57 === errors;}else {var valid11: any = true;}if(valid11){if(data.holderCommandId !== undefined){const _errs60: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/1/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid11: any = _errs60 === errors;}else {var valid11: any = true;}if(valid11){if(data.previousHolderDeviceId !== undefined){let data15: any = data.previousHolderDeviceId;const _errs63: any = errors;const _errs64: any = errors;if(errors === _errs64){if(typeof data15 === "string"){if(func1(data15) > 256){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data15)){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs63 === errors;}else {var valid11: any = true;}}}}}}}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "autoReleasedDisconnect"){const _errs67: any = errors;if(errors === _errs67){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((((data.reason === undefined) && (missing3 = "reason")) || ((data.sessionId === undefined) && (missing3 = "sessionId"))) || ((data.terminalId === undefined) && (missing3 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing3 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing3 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing3 = "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs69: any = errors;for(const key3 in data){if(!((((((((key3 === "reason") || (key3 === "sessionId")) || (key3 === "terminalId")) || (key3 === "leaseVersion")) || (key3 === "holderDeviceId")) || (key3 === "holderRunId")) || (key3 === "holderCommandId")) || (key3 === "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs69 === errors){if(data.reason !== undefined){let data16: any = data.reason;const _errs70: any = errors;if(typeof data16 !== "string"){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedDisconnect" !== data16){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedDisconnect"}}];return false;}var valid17: any = _errs70 === errors;}else {var valid17: any = true;}if(valid17){if(data.sessionId !== undefined){let data17: any = data.sessionId;const _errs72: any = errors;const _errs73: any = errors;if(errors === _errs73){if(typeof data17 === "string"){if(!pattern4.test(data17)){validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs72 === errors;}else {var valid17: any = true;}if(valid17){if(data.terminalId !== undefined){let data18: any = data.terminalId;const _errs76: any = errors;const _errs77: any = errors;if(errors === _errs77){if(typeof data18 === "string"){if(func1(data18) > 256){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data18) < 1){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs76 === errors;}else {var valid17: any = true;}if(valid17){if(data.leaseVersion !== undefined){let data19: any = data.leaseVersion;const _errs80: any = errors;if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/2/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs80){if((typeof data19 == "number") && (isFinite(data19))){if(data19 > 9007199254740991 || isNaN(data19)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/2/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data19 < 1 || isNaN(data19)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/2/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid17: any = _errs80 === errors;}else {var valid17: any = true;}if(valid17){if(data.holderDeviceId !== undefined){const _errs82: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/2/properties/holderDeviceId/not",keyword:"not",params:{}}];return false;var valid17: any = _errs82 === errors;}else {var valid17: any = true;}if(valid17){if(data.holderRunId !== undefined){const _errs85: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/2/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid17: any = _errs85 === errors;}else {var valid17: any = true;}if(valid17){if(data.holderCommandId !== undefined){const _errs88: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/2/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid17: any = _errs88 === errors;}else {var valid17: any = true;}if(valid17){if(data.previousHolderDeviceId !== undefined){let data23: any = data.previousHolderDeviceId;const _errs91: any = errors;const _errs92: any = errors;if(errors === _errs92){if(typeof data23 === "string"){if(func1(data23) > 256){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data23)){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid17: any = _errs91 === errors;}else {var valid17: any = true;}}}}}}}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "autoReleasedPaneClosed"){const _errs95: any = errors;if(errors === _errs95){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((((data.reason === undefined) && (missing4 = "reason")) || ((data.sessionId === undefined) && (missing4 = "sessionId"))) || ((data.terminalId === undefined) && (missing4 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing4 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing4 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing4 = "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs97: any = errors;for(const key4 in data){if(!((((((((key4 === "reason") || (key4 === "sessionId")) || (key4 === "terminalId")) || (key4 === "leaseVersion")) || (key4 === "holderDeviceId")) || (key4 === "holderRunId")) || (key4 === "holderCommandId")) || (key4 === "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs97 === errors){if(data.reason !== undefined){let data24: any = data.reason;const _errs98: any = errors;if(typeof data24 !== "string"){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedPaneClosed" !== data24){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedPaneClosed"}}];return false;}var valid22: any = _errs98 === errors;}else {var valid22: any = true;}if(valid22){if(data.sessionId !== undefined){let data25: any = data.sessionId;const _errs100: any = errors;const _errs101: any = errors;if(errors === _errs101){if(typeof data25 === "string"){if(!pattern4.test(data25)){validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid22: any = _errs100 === errors;}else {var valid22: any = true;}if(valid22){if(data.terminalId !== undefined){let data26: any = data.terminalId;const _errs104: any = errors;const _errs105: any = errors;if(errors === _errs105){if(typeof data26 === "string"){if(func1(data26) > 256){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data26) < 1){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid22: any = _errs104 === errors;}else {var valid22: any = true;}if(valid22){if(data.leaseVersion !== undefined){let data27: any = data.leaseVersion;const _errs108: any = errors;if(!(((typeof data27 == "number") && (!(data27 % 1) && !isNaN(data27))) && (isFinite(data27)))){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/3/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs108){if((typeof data27 == "number") && (isFinite(data27))){if(data27 > 9007199254740991 || isNaN(data27)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/3/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data27 < 1 || isNaN(data27)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/3/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid22: any = _errs108 === errors;}else {var valid22: any = true;}if(valid22){if(data.holderDeviceId !== undefined){const _errs110: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/3/properties/holderDeviceId/not",keyword:"not",params:{}}];return false;var valid22: any = _errs110 === errors;}else {var valid22: any = true;}if(valid22){if(data.holderRunId !== undefined){const _errs113: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/3/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid22: any = _errs113 === errors;}else {var valid22: any = true;}if(valid22){if(data.holderCommandId !== undefined){const _errs116: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/3/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid22: any = _errs116 === errors;}else {var valid22: any = true;}if(valid22){if(data.previousHolderDeviceId !== undefined){let data31: any = data.previousHolderDeviceId;const _errs119: any = errors;const _errs120: any = errors;if(errors === _errs120){if(typeof data31 === "string"){if(func1(data31) > 256){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data31)){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid22: any = _errs119 === errors;}else {var valid22: any = true;}}}}}}}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "autoReleasedCommandEnded"){const _errs123: any = errors;if(errors === _errs123){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((((data.reason === undefined) && (missing5 = "reason")) || ((data.sessionId === undefined) && (missing5 = "sessionId"))) || ((data.terminalId === undefined) && (missing5 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing5 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing5 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing5 = "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs125: any = errors;for(const key5 in data){if(!((((((((key5 === "reason") || (key5 === "sessionId")) || (key5 === "terminalId")) || (key5 === "leaseVersion")) || (key5 === "holderDeviceId")) || (key5 === "holderRunId")) || (key5 === "holderCommandId")) || (key5 === "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs125 === errors){if(data.reason !== undefined){let data32: any = data.reason;const _errs126: any = errors;if(typeof data32 !== "string"){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/4/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedCommandEnded" !== data32){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/4/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedCommandEnded"}}];return false;}var valid27: any = _errs126 === errors;}else {var valid27: any = true;}if(valid27){if(data.sessionId !== undefined){let data33: any = data.sessionId;const _errs128: any = errors;const _errs129: any = errors;if(errors === _errs129){if(typeof data33 === "string"){if(!pattern4.test(data33)){validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid27: any = _errs128 === errors;}else {var valid27: any = true;}if(valid27){if(data.terminalId !== undefined){let data34: any = data.terminalId;const _errs132: any = errors;const _errs133: any = errors;if(errors === _errs133){if(typeof data34 === "string"){if(func1(data34) > 256){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data34) < 1){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid27: any = _errs132 === errors;}else {var valid27: any = true;}if(valid27){if(data.leaseVersion !== undefined){let data35: any = data.leaseVersion;const _errs136: any = errors;if(!(((typeof data35 == "number") && (!(data35 % 1) && !isNaN(data35))) && (isFinite(data35)))){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/4/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs136){if((typeof data35 == "number") && (isFinite(data35))){if(data35 > 9007199254740991 || isNaN(data35)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/4/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data35 < 1 || isNaN(data35)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/4/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid27: any = _errs136 === errors;}else {var valid27: any = true;}if(valid27){if(data.holderDeviceId !== undefined){let data36: any = data.holderDeviceId;const _errs138: any = errors;const _errs139: any = errors;let valid30: any = false;const _errs140: any = errors;const _errs141: any = errors;if(errors === _errs141){if(typeof data36 === "string"){if(func1(data36) > 256){const err5: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {if(!pattern6.test(data36)){const err6: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}}else {const err7: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var _valid1: any = _errs140 === errors;valid30 = valid30 || _valid1;const _errs144: any = errors;if(data36 !== null){const err8: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/4/properties/holderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var _valid1: any = _errs144 === errors;valid30 = valid30 || _valid1;if(!valid30){const err9: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/4/properties/holderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validate2135.errors = vErrors;return false;}else {errors = _errs139;if(vErrors !== null){if(_errs139){vErrors.length = _errs139;}else {vErrors = null;}}}var valid27: any = _errs138 === errors;}else {var valid27: any = true;}if(valid27){if(data.holderRunId !== undefined){const _errs146: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/4/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid27: any = _errs146 === errors;}else {var valid27: any = true;}if(valid27){if(data.holderCommandId !== undefined){const _errs149: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/4/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid27: any = _errs149 === errors;}else {var valid27: any = true;}if(valid27){if(data.previousHolderDeviceId !== undefined){let data39: any = data.previousHolderDeviceId;const _errs152: any = errors;const _errs153: any = errors;if(errors === _errs153){if(typeof data39 === "string"){if(func1(data39) > 256){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data39)){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid27: any = _errs152 === errors;}else {var valid27: any = true;}}}}}}}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "autoReleasedRunIdle"){const _errs156: any = errors;if(errors === _errs156){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((((data.reason === undefined) && (missing6 = "reason")) || ((data.sessionId === undefined) && (missing6 = "sessionId"))) || ((data.terminalId === undefined) && (missing6 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing6 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing6 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing6 = "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs158: any = errors;for(const key6 in data){if(!((((((((key6 === "reason") || (key6 === "sessionId")) || (key6 === "terminalId")) || (key6 === "leaseVersion")) || (key6 === "holderDeviceId")) || (key6 === "holderRunId")) || (key6 === "holderCommandId")) || (key6 === "previousHolderDeviceId"))){validate2135.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs158 === errors){if(data.reason !== undefined){let data40: any = data.reason;const _errs159: any = errors;if(typeof data40 !== "string"){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/5/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedRunIdle" !== data40){validate2135.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/5/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedRunIdle"}}];return false;}var valid34: any = _errs159 === errors;}else {var valid34: any = true;}if(valid34){if(data.sessionId !== undefined){let data41: any = data.sessionId;const _errs161: any = errors;const _errs162: any = errors;if(errors === _errs162){if(typeof data41 === "string"){if(!pattern4.test(data41)){validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2135.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid34: any = _errs161 === errors;}else {var valid34: any = true;}if(valid34){if(data.terminalId !== undefined){let data42: any = data.terminalId;const _errs165: any = errors;const _errs166: any = errors;if(errors === _errs166){if(typeof data42 === "string"){if(func1(data42) > 256){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data42) < 1){validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid34: any = _errs165 === errors;}else {var valid34: any = true;}if(valid34){if(data.leaseVersion !== undefined){let data43: any = data.leaseVersion;const _errs169: any = errors;if(!(((typeof data43 == "number") && (!(data43 % 1) && !isNaN(data43))) && (isFinite(data43)))){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/5/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs169){if((typeof data43 == "number") && (isFinite(data43))){if(data43 > 9007199254740991 || isNaN(data43)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/5/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data43 < 1 || isNaN(data43)){validate2135.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/5/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid34: any = _errs169 === errors;}else {var valid34: any = true;}if(valid34){if(data.holderDeviceId !== undefined){let data44: any = data.holderDeviceId;const _errs171: any = errors;const _errs172: any = errors;let valid37: any = false;const _errs173: any = errors;const _errs174: any = errors;if(errors === _errs174){if(typeof data44 === "string"){if(func1(data44) > 256){const err10: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(!pattern6.test(data44)){const err11: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}}else {const err12: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}var _valid2: any = _errs173 === errors;valid37 = valid37 || _valid2;const _errs177: any = errors;if(data44 !== null){const err13: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/5/properties/holderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}var _valid2: any = _errs177 === errors;valid37 = valid37 || _valid2;if(!valid37){const err14: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/5/properties/holderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;validate2135.errors = vErrors;return false;}else {errors = _errs172;if(vErrors !== null){if(_errs172){vErrors.length = _errs172;}else {vErrors = null;}}}var valid34: any = _errs171 === errors;}else {var valid34: any = true;}if(valid34){if(data.holderRunId !== undefined){const _errs179: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/5/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid34: any = _errs179 === errors;}else {var valid34: any = true;}if(valid34){if(data.holderCommandId !== undefined){const _errs182: any = errors;validate2135.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/5/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid34: any = _errs182 === errors;}else {var valid34: any = true;}if(valid34){if(data.previousHolderDeviceId !== undefined){let data47: any = data.previousHolderDeviceId;const _errs185: any = errors;const _errs186: any = errors;if(errors === _errs186){if(typeof data47 === "string"){if(func1(data47) > 256){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data47)){validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2135.errors = [{instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid34: any = _errs185 === errors;}else {var valid34: any = true;}}}}}}}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2135.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "reason", tagValue: tag0}}];return false;}}else {validate2135.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "reason", tagValue: tag0}}];return false;}}}}}else {validate2135.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2135.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2135.errors = null as any[] | null;
// prettier-ignore
validate2135.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2136(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlHeldByOtherDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2136.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.terminalId === undefined) && (missing0 = "terminalId")) || ((data.holderDeviceId === undefined) && (missing0 = "holderDeviceId"))){validate2136.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "terminalId") || (key0 === "holderDeviceId")) || (key0 === "holderRunId")) || (key0 === "holderCommandId"))){validate2136.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){let data0: any = data.terminalId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2136.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate2136.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2136.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderDeviceId !== undefined){let data1: any = data.holderDeviceId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2136.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data1)){validate2136.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2136.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderRunId !== undefined){let data2: any = data.holderRunId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2136.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2136.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderCommandId !== undefined){let data3: any = data.holderCommandId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(func1(data3) > 256){validate2136.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate2136.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2136.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.holderRunId !== undefined && ((data.holderCommandId === undefined) && (missing1 = "holderCommandId"))){validate2136.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderRunId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderCommandId"}}];return false;}else {if(data.holderCommandId !== undefined && ((data.holderRunId === undefined) && (missing1 = "holderRunId"))){validate2136.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderCommandId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderRunId"}}];return false;}}}}}}}}}else {validate2136.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2136.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2136.errors = null as any[] | null;
// prettier-ignore
validate2136.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2137(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlHolder {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2137.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.holderDeviceId === undefined) && (missing0 = "holderDeviceId")){validate2137.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "holderDeviceId") || (key0 === "holderRunId")) || (key0 === "holderCommandId"))){validate2137.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.holderDeviceId !== undefined){let data0: any = data.holderDeviceId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2137.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate2137.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2137.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderRunId !== undefined){let data1: any = data.holderRunId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2137.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2137.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderCommandId !== undefined){let data2: any = data.holderCommandId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate2137.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate2137.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2137.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"sidekicks-contracts:command#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.holderRunId !== undefined && ((data.holderCommandId === undefined) && (missing1 = "holderCommandId"))){validate2137.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderRunId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderCommandId"}}];return false;}else {if(data.holderCommandId !== undefined && ((data.holderRunId === undefined) && (missing1 = "holderRunId"))){validate2137.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderCommandId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderRunId"}}];return false;}}}}}}}}else {validate2137.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2137.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2137.errors = null as any[] | null;
// prettier-ignore
validate2137.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2138(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlTakeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2138.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.outputSubscriptionId === undefined) && (missing0 = "outputSubscriptionId"))){validate2138.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "outputSubscriptionId")) || (key0 === "force"))){validate2138.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2138.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2138.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){let data1: any = data.terminalId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2138.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2138.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2138.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSubscriptionId !== undefined){let data2: any = data.outputSubscriptionId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2138.errors = [{instancePath:instancePath+"/outputSubscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2138.errors = [{instancePath:instancePath+"/outputSubscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.force !== undefined){const _errs14: any = errors;if(typeof data.force !== "boolean"){validate2138.errors = [{instancePath:instancePath+"/force",schemaPath:"#/properties/force/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}else {validate2138.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2138.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2138.errors = null as any[] | null;
// prettier-ignore
validate2138.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2139(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlTakeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2139.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.terminalId === undefined) && (missing0 = "terminalId")) || ((data.holderDeviceId === undefined) && (missing0 = "holderDeviceId"))){validate2139.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "terminalId") || (key0 === "holderDeviceId"))){validate2139.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){let data0: any = data.terminalId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2139.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate2139.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2139.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderDeviceId !== undefined){let data1: any = data.holderDeviceId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2139.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data1)){validate2139.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2139.errors = [{instancePath:instancePath+"/holderDeviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2139.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2139.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2139.errors = null as any[] | null;
// prettier-ignore
validate2139.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2140(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalFlowControlUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2140.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.paused === undefined) && (missing0 = "paused"))){validate2140.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "paused"))){validate2140.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2140.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2140.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){let data1: any = data.terminalId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2140.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2140.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2140.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.paused !== undefined){const _errs10: any = errors;if(typeof data.paused !== "boolean"){validate2140.errors = [{instancePath:instancePath+"/paused",schemaPath:"#/properties/paused/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2140.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2140.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2140.errors = null as any[] | null;
// prettier-ignore
validate2140.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2141(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalFlowControlUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2141.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accepted === undefined) && (missing0 = "accepted")){validate2141.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accepted")){validate2141.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accepted !== undefined){let data0: any = data.accepted;if(typeof data0 !== "boolean"){validate2141.errors = [{instancePath:instancePath+"/accepted",schemaPath:"#/properties/accepted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate2141.errors = [{instancePath:instancePath+"/accepted",schemaPath:"#/properties/accepted/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate2141.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2141.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2141.errors = null as any[] | null;
// prettier-ignore
validate2141.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2142(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2142.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate2142.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate2142.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2142.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2142.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2142.errors = null as any[] | null;
// prettier-ignore
validate2142.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2144(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2144.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.terminalId === undefined) && (missing0 = "terminalId")) || ((data.title === undefined) && (missing0 = "title"))) || ((data.status === undefined) && (missing0 = "status"))) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.leaseVersion === undefined) && (missing0 = "leaseVersion"))){validate2144.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "terminalId") || (key0 === "title")) || (key0 === "status")) || (key0 === "holder")) || (key0 === "leaseVersion"))){validate2144.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){let data0: any = data.terminalId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2144.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate2144.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2144.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){let data1: any = data.title;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate2144.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2144.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2144.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data2: any = data.status;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){const _errs12: any = errors;for(const key1 in data2){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key1}}];return false;break;}if(_errs12 === errors){const tag0: any = data2.state;if(typeof tag0 == "string"){if(tag0 === "running"){const _errs13: any = errors;if(errors === _errs13){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if((data2.state === undefined) && (missing1 = "state")){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs15: any = errors;for(const key2 in data2){if(!(key2 === "state")){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs15 === errors){if(data2.state !== undefined){let data3: any = data2.state;if(typeof data3 !== "string"){validate2144.errors = [{instancePath:instancePath+"/status/state",schemaPath:"#/$defs/TerminalShellStatus/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data3){validate2144.errors = [{instancePath:instancePath+"/status/state",schemaPath:"#/$defs/TerminalShellStatus/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "running"}}];return false;}}}}}else {validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "exited"){const _errs18: any = errors;if(errors === _errs18){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing2: any;if(((data2.state === undefined) && (missing2 = "state")) || ((data2.exitCode === undefined) && (missing2 = "exitCode"))){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs20: any = errors;for(const key3 in data2){if(!((key3 === "state") || (key3 === "exitCode"))){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs20 === errors){if(data2.state !== undefined){let data4: any = data2.state;const _errs21: any = errors;if(typeof data4 !== "string"){validate2144.errors = [{instancePath:instancePath+"/status/state",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("exited" !== data4){validate2144.errors = [{instancePath:instancePath+"/status/state",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "exited"}}];return false;}var valid7: any = _errs21 === errors;}else {var valid7: any = true;}if(valid7){if(data2.exitCode !== undefined){let data5: any = data2.exitCode;const _errs23: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate2144.errors = [{instancePath:instancePath+"/status/exitCode",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs23){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate2144.errors = [{instancePath:instancePath+"/status/exitCode",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < -9007199254740991 || isNaN(data5)){validate2144.errors = [{instancePath:instancePath+"/status/exitCode",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid7: any = _errs23 === errors;}else {var valid7: any = true;}}}}}else {validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "didNotStart"){const _errs25: any = errors;if(errors === _errs25){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing3: any;if(((data2.state === undefined) && (missing3 = "state")) || ((data2.cause === undefined) && (missing3 = "cause"))){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs27: any = errors;for(const key4 in data2){if(!((key4 === "state") || (key4 === "cause"))){validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs27 === errors){if(data2.state !== undefined){let data6: any = data2.state;const _errs28: any = errors;if(typeof data6 !== "string"){validate2144.errors = [{instancePath:instancePath+"/status/state",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("didNotStart" !== data6){validate2144.errors = [{instancePath:instancePath+"/status/state",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "didNotStart"}}];return false;}var valid9: any = _errs28 === errors;}else {var valid9: any = true;}if(valid9){if(data2.cause !== undefined){let data7: any = data2.cause;const _errs30: any = errors;if(errors === _errs30){if(typeof data7 === "string"){if(func1(data7) < 1){validate2144.errors = [{instancePath:instancePath+"/status/cause",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/properties/cause/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2144.errors = [{instancePath:instancePath+"/status/cause",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/properties/cause/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs30 === errors;}else {var valid9: any = true;}}}}}else {validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}}}else {validate2144.errors = [{instancePath:instancePath+"/status",schemaPath:"#/$defs/TerminalShellStatus/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.holder !== undefined){let data8: any = data.holder;const _errs32: any = errors;const _errs33: any = errors;let valid10: any = false;const _errs34: any = errors;if(!(validate2137.call(this, data8, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2137.errors : vErrors.concat(validate2137.errors);errors = vErrors.length;}var _valid0: any = _errs34 === errors;valid10 = valid10 || _valid0;const _errs35: any = errors;if(data8 !== null){const err0: any = {instancePath:instancePath+"/holder",schemaPath:"#/properties/holder/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs35 === errors;valid10 = valid10 || _valid0;if(!valid10){const err1: any = {instancePath:instancePath+"/holder",schemaPath:"#/properties/holder/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate2144.errors = vErrors;return false;}else {errors = _errs33;if(vErrors !== null){if(_errs33){vErrors.length = _errs33;}else {vErrors = null;}}}var valid0: any = _errs32 === errors;}else {var valid0: any = true;}if(valid0){if(data.leaseVersion !== undefined){let data9: any = data.leaseVersion;const _errs37: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate2144.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs37){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate2144.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate2144.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs37 === errors;}else {var valid0: any = true;}}}}}}}}else {validate2144.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2144.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2144.errors = null as any[] | null;
// prettier-ignore
validate2144.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
function validate2143(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalListUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2143.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminals === undefined) && (missing0 = "terminals"))){validate2143.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "terminals"))){validate2143.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2143.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2143.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminals !== undefined){let data1: any = data.terminals;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate2144.call(this, data1[i0], {instancePath:instancePath+"/terminals/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2144.errors : vErrors.concat(validate2144.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}if(valid2){let i1: any = data1.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data1[i1], data1[j0])){validate2143.errors = [{instancePath:instancePath+"/terminals",schemaPath:"#/properties/terminals/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}else {validate2143.errors = [{instancePath:instancePath+"/terminals",schemaPath:"#/properties/terminals/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2143.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2143.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2143.errors = null as any[] | null;
// prettier-ignore
validate2143.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
function validate2147(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOpenRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2147.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate2147.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "clientIdempotencyKey"))){validate2147.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2147.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2147.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data1: any = data.clientIdempotencyKey;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern222.test(data1)){validate2147.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2147.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2147.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2147.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2147.errors = null as any[] | null;
// prettier-ignore
validate2147.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2148(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOpenResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2148.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.terminalId === undefined) && (missing0 = "terminalId")){validate2148.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "terminalId")){validate2148.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){let data0: any = data.terminalId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2148.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate2148.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2148.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2148.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2148.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2148.errors = null as any[] | null;
// prettier-ignore
validate2148.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4220: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"scrollback"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"data":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","maxBytes":4194300,"tsType":"Uint8Array","description":"The window's bytes."},"columns":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The columns it was last drawn at."},"rows":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The rows it was last drawn at."},"holder":{"anyOf":[{"$ref":"#/$defs/TerminalControlHolder"},{"type":"null"}],"description":"Who holds the shell, or `null`."},"leaseVersion":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The lease version the holder was read at."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","data","columns","rows","holder","leaseVersion","cursor"],"description":"The scrollback window opens."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"scrollbackContinuation"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"data":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":4194300,"tsType":"Uint8Array","description":"The window's next bytes."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","data","cursor"],"description":"The scrollback window goes on."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"output"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"data":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":4194300,"tsType":"Uint8Array","description":"The bytes."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","data","cursor"],"description":"What the shell wrote next."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"exited"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"The program's exit code."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","exitCode","cursor"],"description":"The shell's program ended."}],"description":"One change on a shell's output stream; `cursor` is the shell's output offset once the change is\napplied, in bytes since the shell started. `scrollback` opens the scrollback window, starting at\nits first whole line, with the columns and rows it was last drawn at (so a running program's\nboxes come back unwrapped) and who holds it at which lease version; a window too large for one\nmessage goes on in `scrollbackContinuation` changes, each in a frame of its own, before any\noutput. `output` is what the shell wrote next, in order; `exited` is its program's end. Output\nand scrollback travel as raw bytes, an attachment each, with no character held back.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate2150(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2150.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2150.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "scrollback"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.data === undefined) && (missing0 = "data"))) || ((data.columns === undefined) && (missing0 = "columns"))) || ((data.rows === undefined) && (missing0 = "rows"))) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.leaseVersion === undefined) && (missing0 = "leaseVersion"))) || ((data.cursor === undefined) && (missing0 = "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(func2.call(schema4220.oneOf[0].properties, key1))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("scrollback" !== data0){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "scrollback"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.terminalId !== undefined){let data2: any = data.terminalId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(func1(data2) > 256){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.data !== undefined){let data3: any = data.data;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if((data3.$bytes === undefined) && (missing1 = "$bytes")){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs20: any = errors;for(const key2 in data3){if(!(key2 === "$bytes")){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs20 === errors){if(data3.$bytes !== undefined){let data4: any = data3.$bytes;const _errs21: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs21){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 4294967295 || isNaN(data4)){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs17 === errors;if(valid5){if(!(data3 && typeof data3 == "object" && Number.isInteger(data3.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data3.$bytes] instanceof Uint8Array && this.attachments[data3.$bytes].byteLength <= 4194300)){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.columns !== undefined){let data5: any = data.columns;const _errs24: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate2150.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/oneOf/0/properties/columns/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate2150.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/oneOf/0/properties/columns/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 1 || isNaN(data5)){validate2150.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/oneOf/0/properties/columns/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs24 === errors;}else {var valid2: any = true;}if(valid2){if(data.rows !== undefined){let data6: any = data.rows;const _errs26: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate2150.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/oneOf/0/properties/rows/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs26){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate2150.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/oneOf/0/properties/rows/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 1 || isNaN(data6)){validate2150.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/oneOf/0/properties/rows/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs26 === errors;}else {var valid2: any = true;}if(valid2){if(data.holder !== undefined){let data7: any = data.holder;const _errs28: any = errors;const _errs29: any = errors;let valid7: any = false;const _errs30: any = errors;if(!(validate2137.call(this, data7, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2137.errors : vErrors.concat(validate2137.errors);errors = vErrors.length;}var _valid0: any = _errs30 === errors;valid7 = valid7 || _valid0;const _errs31: any = errors;if(data7 !== null){const err0: any = {instancePath:instancePath+"/holder",schemaPath:"#/oneOf/0/properties/holder/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs31 === errors;valid7 = valid7 || _valid0;if(!valid7){const err1: any = {instancePath:instancePath+"/holder",schemaPath:"#/oneOf/0/properties/holder/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate2150.errors = vErrors;return false;}else {errors = _errs29;if(vErrors !== null){if(_errs29){vErrors.length = _errs29;}else {vErrors = null;}}}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}if(valid2){if(data.leaseVersion !== undefined){let data8: any = data.leaseVersion;const _errs33: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate2150.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs33){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validate2150.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validate2150.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs33 === errors;}else {var valid2: any = true;}if(valid2){if(data.cursor !== undefined){let data9: any = data.cursor;const _errs35: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/0/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs35){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/0/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/0/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs35 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validate2150.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "scrollbackContinuation"){const _errs37: any = errors;if(errors === _errs37){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.terminalId === undefined) && (missing2 = "terminalId"))) || ((data.data === undefined) && (missing2 = "data"))) || ((data.cursor === undefined) && (missing2 = "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs39: any = errors;for(const key3 in data){if(!(((((key3 === "kind") || (key3 === "sessionId")) || (key3 === "terminalId")) || (key3 === "data")) || (key3 === "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs39 === errors){if(data.kind !== undefined){let data10: any = data.kind;const _errs40: any = errors;if(typeof data10 !== "string"){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("scrollbackContinuation" !== data10){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "scrollbackContinuation"}}];return false;}var valid9: any = _errs40 === errors;}else {var valid9: any = true;}if(valid9){if(data.sessionId !== undefined){let data11: any = data.sessionId;const _errs42: any = errors;const _errs43: any = errors;if(errors === _errs43){if(typeof data11 === "string"){if(!pattern4.test(data11)){validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs42 === errors;}else {var valid9: any = true;}if(valid9){if(data.terminalId !== undefined){let data12: any = data.terminalId;const _errs46: any = errors;const _errs47: any = errors;if(errors === _errs47){if(typeof data12 === "string"){if(func1(data12) > 256){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data12) < 1){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs46 === errors;}else {var valid9: any = true;}if(valid9){if(data.data !== undefined){let data13: any = data.data;const _errs50: any = errors;const _errs51: any = errors;if(errors === _errs51){if(data13 && typeof data13 == "object" && !Array.isArray(data13)){let missing3: any;if((data13.$bytes === undefined) && (missing3 = "$bytes")){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs54: any = errors;for(const key4 in data13){if(!(key4 === "$bytes")){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs54 === errors){if(data13.$bytes !== undefined){let data14: any = data13.$bytes;const _errs55: any = errors;if(!(((typeof data14 == "number") && (!(data14 % 1) && !isNaN(data14))) && (isFinite(data14)))){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs55){if((typeof data14 == "number") && (isFinite(data14))){if(data14 > 4294967295 || isNaN(data14)){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data14 < 0 || isNaN(data14)){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid12: any = _errs51 === errors;if(valid12){if(!(data13 && typeof data13 == "object" && Number.isInteger(data13.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data13.$bytes] instanceof Uint8Array && this.attachments[data13.$bytes].byteLength >= 1)){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data13 && typeof data13 == "object" && Number.isInteger(data13.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data13.$bytes] instanceof Uint8Array && this.attachments[data13.$bytes].byteLength <= 4194300)){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid9: any = _errs50 === errors;}else {var valid9: any = true;}if(valid9){if(data.cursor !== undefined){let data15: any = data.cursor;const _errs58: any = errors;if(!(((typeof data15 == "number") && (!(data15 % 1) && !isNaN(data15))) && (isFinite(data15)))){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/1/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs58){if((typeof data15 == "number") && (isFinite(data15))){if(data15 > 9007199254740991 || isNaN(data15)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/1/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data15 < 0 || isNaN(data15)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/1/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs58 === errors;}else {var valid9: any = true;}}}}}}}}else {validate2150.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "output"){const _errs60: any = errors;if(errors === _errs60){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((data.kind === undefined) && (missing4 = "kind")) || ((data.sessionId === undefined) && (missing4 = "sessionId"))) || ((data.terminalId === undefined) && (missing4 = "terminalId"))) || ((data.data === undefined) && (missing4 = "data"))) || ((data.cursor === undefined) && (missing4 = "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs62: any = errors;for(const key5 in data){if(!(((((key5 === "kind") || (key5 === "sessionId")) || (key5 === "terminalId")) || (key5 === "data")) || (key5 === "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs62 === errors){if(data.kind !== undefined){let data16: any = data.kind;const _errs63: any = errors;if(typeof data16 !== "string"){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("output" !== data16){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "output"}}];return false;}var valid15: any = _errs63 === errors;}else {var valid15: any = true;}if(valid15){if(data.sessionId !== undefined){let data17: any = data.sessionId;const _errs65: any = errors;const _errs66: any = errors;if(errors === _errs66){if(typeof data17 === "string"){if(!pattern4.test(data17)){validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs65 === errors;}else {var valid15: any = true;}if(valid15){if(data.terminalId !== undefined){let data18: any = data.terminalId;const _errs69: any = errors;const _errs70: any = errors;if(errors === _errs70){if(typeof data18 === "string"){if(func1(data18) > 256){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data18) < 1){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs69 === errors;}else {var valid15: any = true;}if(valid15){if(data.data !== undefined){let data19: any = data.data;const _errs73: any = errors;const _errs74: any = errors;if(errors === _errs74){if(data19 && typeof data19 == "object" && !Array.isArray(data19)){let missing5: any;if((data19.$bytes === undefined) && (missing5 = "$bytes")){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs77: any = errors;for(const key6 in data19){if(!(key6 === "$bytes")){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs77 === errors){if(data19.$bytes !== undefined){let data20: any = data19.$bytes;const _errs78: any = errors;if(!(((typeof data20 == "number") && (!(data20 % 1) && !isNaN(data20))) && (isFinite(data20)))){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs78){if((typeof data20 == "number") && (isFinite(data20))){if(data20 > 4294967295 || isNaN(data20)){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data20 < 0 || isNaN(data20)){validate2150.errors = [{instancePath:instancePath+"/data/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid18: any = _errs74 === errors;if(valid18){if(!(data19 && typeof data19 == "object" && Number.isInteger(data19.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data19.$bytes] instanceof Uint8Array && this.attachments[data19.$bytes].byteLength >= 1)){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/2/properties/data/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data19 && typeof data19 == "object" && Number.isInteger(data19.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data19.$bytes] instanceof Uint8Array && this.attachments[data19.$bytes].byteLength <= 4194300)){validate2150.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/2/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid15: any = _errs73 === errors;}else {var valid15: any = true;}if(valid15){if(data.cursor !== undefined){let data21: any = data.cursor;const _errs81: any = errors;if(!(((typeof data21 == "number") && (!(data21 % 1) && !isNaN(data21))) && (isFinite(data21)))){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/2/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs81){if((typeof data21 == "number") && (isFinite(data21))){if(data21 > 9007199254740991 || isNaN(data21)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/2/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data21 < 0 || isNaN(data21)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/2/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid15: any = _errs81 === errors;}else {var valid15: any = true;}}}}}}}}else {validate2150.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "exited"){const _errs83: any = errors;if(errors === _errs83){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((((((data.kind === undefined) && (missing6 = "kind")) || ((data.sessionId === undefined) && (missing6 = "sessionId"))) || ((data.terminalId === undefined) && (missing6 = "terminalId"))) || ((data.exitCode === undefined) && (missing6 = "exitCode"))) || ((data.cursor === undefined) && (missing6 = "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs85: any = errors;for(const key7 in data){if(!(((((key7 === "kind") || (key7 === "sessionId")) || (key7 === "terminalId")) || (key7 === "exitCode")) || (key7 === "cursor"))){validate2150.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}}];return false;break;}}if(_errs85 === errors){if(data.kind !== undefined){let data22: any = data.kind;const _errs86: any = errors;if(typeof data22 !== "string"){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("exited" !== data22){validate2150.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "exited"}}];return false;}var valid21: any = _errs86 === errors;}else {var valid21: any = true;}if(valid21){if(data.sessionId !== undefined){let data23: any = data.sessionId;const _errs88: any = errors;const _errs89: any = errors;if(errors === _errs89){if(typeof data23 === "string"){if(!pattern4.test(data23)){validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2150.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs88 === errors;}else {var valid21: any = true;}if(valid21){if(data.terminalId !== undefined){let data24: any = data.terminalId;const _errs92: any = errors;const _errs93: any = errors;if(errors === _errs93){if(typeof data24 === "string"){if(func1(data24) > 256){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data24) < 1){validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2150.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs92 === errors;}else {var valid21: any = true;}if(valid21){if(data.exitCode !== undefined){let data25: any = data.exitCode;const _errs96: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validate2150.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs96){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validate2150.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < -9007199254740991 || isNaN(data25)){validate2150.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid21: any = _errs96 === errors;}else {var valid21: any = true;}if(valid21){if(data.cursor !== undefined){let data26: any = data.cursor;const _errs98: any = errors;if(!(((typeof data26 == "number") && (!(data26 % 1) && !isNaN(data26))) && (isFinite(data26)))){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/3/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs98){if((typeof data26 == "number") && (isFinite(data26))){if(data26 > 9007199254740991 || isNaN(data26)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/3/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data26 < 0 || isNaN(data26)){validate2150.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/3/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid21: any = _errs98 === errors;}else {var valid21: any = true;}}}}}}}}else {validate2150.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2150.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2150.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2150.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2150.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2150.errors = null as any[] | null;
// prettier-ignore
validate2150.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2149(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOutputFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2149.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.changes === undefined) && (missing0 = "changes")){validate2149.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "changes") || (key0 === "dropped"))){validate2149.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.changes !== undefined){let data0: any = data.changes;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length > 50){validate2149.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/maxItems",keyword:"maxItems",params:{limit: 50}}];return false;}else {if(data0.length < 1){validate2149.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2150.call(this, data0[i0], {instancePath:instancePath+"/changes/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2150.errors : vErrors.concat(validate2150.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}}else {validate2149.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.dropped !== undefined){let data2: any = data.dropped;const _errs5: any = errors;if(typeof data2 !== "boolean"){validate2149.errors = [{instancePath:instancePath+"/dropped",schemaPath:"#/properties/dropped/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data2){validate2149.errors = [{instancePath:instancePath+"/dropped",schemaPath:"#/properties/dropped/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2149.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2149.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2149.errors = null as any[] | null;
// prettier-ignore
validate2149.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2153(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOutputSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2153.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))){validate2153.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "afterOffset"))){validate2153.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2153.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2153.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){let data1: any = data.terminalId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2153.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2153.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2153.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.afterOffset !== undefined){let data2: any = data.afterOffset;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate2153.errors = [{instancePath:instancePath+"/afterOffset",schemaPath:"#/properties/afterOffset/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate2153.errors = [{instancePath:instancePath+"/afterOffset",schemaPath:"#/properties/afterOffset/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate2153.errors = [{instancePath:instancePath+"/afterOffset",schemaPath:"#/properties/afterOffset/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2153.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2153.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2153.errors = null as any[] | null;
// prettier-ignore
validate2153.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2154(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalReorderRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2154.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalIds === undefined) && (missing0 = "terminalIds"))){validate2154.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "terminalIds"))){validate2154.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2154.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2154.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalIds !== undefined){let data1: any = data.terminalIds;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){if(data1.length < 1){validate2154.errors = [{instancePath:instancePath+"/terminalIds",schemaPath:"#/properties/terminalIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 256){validate2154.errors = [{instancePath:instancePath+"/terminalIds/" + i0,schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate2154.errors = [{instancePath:instancePath+"/terminalIds/" + i0,schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2154.errors = [{instancePath:instancePath+"/terminalIds/" + i0,schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}if(valid2){let i1: any = data1.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data1[i1], data1[j0])){validate2154.errors = [{instancePath:instancePath+"/terminalIds",schemaPath:"#/properties/terminalIds/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validate2154.errors = [{instancePath:instancePath+"/terminalIds",schemaPath:"#/properties/terminalIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2154.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2154.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2154.errors = null as any[] | null;
// prettier-ignore
validate2154.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2155(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalResizeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2155.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.columns === undefined) && (missing0 = "columns"))) || ((data.rows === undefined) && (missing0 = "rows"))){validate2155.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "columns")) || (key0 === "rows"))){validate2155.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2155.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2155.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){let data1: any = data.terminalId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate2155.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate2155.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2155.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.columns !== undefined){let data2: any = data.columns;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate2155.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate2155.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validate2155.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.rows !== undefined){let data3: any = data.rows;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate2155.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate2155.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate2155.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate2155.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2155.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2155.errors = null as any[] | null;
// prettier-ignore
validate2155.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2156(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2156.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate2156.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate2156.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2156.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2156.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2156.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2156.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2156.errors = null as any[] | null;
// prettier-ignore
validate2156.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2157(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2157.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2157.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "keys"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.outputSubscriptionId === undefined) && (missing0 = "outputSubscriptionId"))) || ((data.data === undefined) && (missing0 = "data"))){validate2157.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((((key1 === "kind") || (key1 === "sessionId")) || (key1 === "terminalId")) || (key1 === "outputSubscriptionId")) || (key1 === "data"))){validate2157.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate2157.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("keys" !== data0){validate2157.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "keys"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2157.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2157.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.terminalId !== undefined){let data2: any = data.terminalId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(func1(data2) > 256){validate2157.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate2157.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2157.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.outputSubscriptionId !== undefined){let data3: any = data.outputSubscriptionId;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2157.errors = [{instancePath:instancePath+"/outputSubscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2157.errors = [{instancePath:instancePath+"/outputSubscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.data !== undefined){let data4: any = data.data;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(func1(data4) > 65536){validate2157.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/maxLength",keyword:"maxLength",params:{limit: 65536}}];return false;}else {if(new TextEncoder().encode(data4).byteLength > 65536){validate2157.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/maxUtf8Bytes",keyword:"maxUtf8Bytes",params:{}}];return false;}}}else {validate2157.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}}}}}}}}else {validate2157.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "paste"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.outputSubscriptionId === undefined) && (missing1 = "outputSubscriptionId"))) || ((data.data === undefined) && (missing1 = "data"))) || ((data.pasteId === undefined) && (missing1 = "pasteId"))) || ((data.isLastPart === undefined) && (missing1 = "isLastPart"))){validate2157.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!(((((((key2 === "kind") || (key2 === "sessionId")) || (key2 === "terminalId")) || (key2 === "outputSubscriptionId")) || (key2 === "data")) || (key2 === "pasteId")) || (key2 === "isLastPart"))){validate2157.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs25: any = errors;if(typeof data5 !== "string"){validate2157.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("paste" !== data5){validate2157.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "paste"}}];return false;}var valid7: any = _errs25 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data6: any = data.sessionId;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate2157.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2157.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.terminalId !== undefined){let data7: any = data.terminalId;const _errs31: any = errors;const _errs32: any = errors;if(errors === _errs32){if(typeof data7 === "string"){if(func1(data7) > 256){validate2157.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data7) < 1){validate2157.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate2157.errors = [{instancePath:instancePath+"/terminalId",schemaPath:"#/$defs/TerminalId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs31 === errors;}else {var valid7: any = true;}if(valid7){if(data.outputSubscriptionId !== undefined){let data8: any = data.outputSubscriptionId;const _errs35: any = errors;const _errs36: any = errors;if(errors === _errs36){if(typeof data8 === "string"){if(!pattern4.test(data8)){validate2157.errors = [{instancePath:instancePath+"/outputSubscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2157.errors = [{instancePath:instancePath+"/outputSubscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs35 === errors;}else {var valid7: any = true;}if(valid7){if(data.data !== undefined){let data9: any = data.data;const _errs39: any = errors;if(errors === _errs39){if(typeof data9 === "string"){if(func1(data9) > 65536){validate2157.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/maxLength",keyword:"maxLength",params:{limit: 65536}}];return false;}else {if(new TextEncoder().encode(data9).byteLength > 65536){validate2157.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/maxUtf8Bytes",keyword:"maxUtf8Bytes",params:{}}];return false;}}}else {validate2157.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs39 === errors;}else {var valid7: any = true;}if(valid7){if(data.pasteId !== undefined){let data10: any = data.pasteId;const _errs41: any = errors;if(errors === _errs41){if(typeof data10 === "string"){if(!pattern222.test(data10)){validate2157.errors = [{instancePath:instancePath+"/pasteId",schemaPath:"#/oneOf/1/properties/pasteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2157.errors = [{instancePath:instancePath+"/pasteId",schemaPath:"#/oneOf/1/properties/pasteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs41 === errors;}else {var valid7: any = true;}if(valid7){if(data.isLastPart !== undefined){const _errs43: any = errors;if(typeof data.isLastPart !== "boolean"){validate2157.errors = [{instancePath:instancePath+"/isLastPart",schemaPath:"#/oneOf/1/properties/isLastPart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid7: any = _errs43 === errors;}else {var valid7: any = true;}}}}}}}}}}else {validate2157.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2157.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2157.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2157.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2157.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2157.errors = null as any[] | null;
// prettier-ignore
validate2157.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalAppearanceReportRequest}. */
export const validateTerminalAppearanceReportRequest: SchemaCheck<TerminalAppearanceReportRequest> =
  validate2128;
/** Checks that a value is a {@link TerminalCellSize}. */
export const validateTerminalCellSize: SchemaCheck<TerminalCellSize> = validate2132;
/** Checks that a value is a {@link TerminalCloseRequest}. */
export const validateTerminalCloseRequest: SchemaCheck<TerminalCloseRequest> = validate2133;
/** Checks that a value is a {@link TerminalColors}. */
export const validateTerminalColors: SchemaCheck<TerminalColors> = validate2134;
/** Checks that a value is a {@link TerminalControlChangedPayload}. */
export const validateTerminalControlChangedPayload: SchemaCheck<TerminalControlChangedPayload> =
  validate2135;
/** Checks that a value is a {@link TerminalControlHeldByOtherDetails}. */
export const validateTerminalControlHeldByOtherDetails: SchemaCheck<TerminalControlHeldByOtherDetails> =
  validate2136;
/** Checks that a value is a {@link TerminalControlHolder}. */
export const validateTerminalControlHolder: SchemaCheck<TerminalControlHolder> = validate2137;
/** Checks that a value is a {@link TerminalControlTakeRequest}. */
export const validateTerminalControlTakeRequest: SchemaCheck<TerminalControlTakeRequest> =
  validate2138;
/** Checks that a value is a {@link TerminalControlTakeResponse}. */
export const validateTerminalControlTakeResponse: SchemaCheck<TerminalControlTakeResponse> =
  validate2139;
/** Checks that a value is a {@link TerminalFlowControlUpdateRequest}. */
export const validateTerminalFlowControlUpdateRequest: SchemaCheck<TerminalFlowControlUpdateRequest> =
  validate2140;
/** Checks that a value is a {@link TerminalFlowControlUpdateResponse}. */
export const validateTerminalFlowControlUpdateResponse: SchemaCheck<TerminalFlowControlUpdateResponse> =
  validate2141;
/** Checks that a value is a {@link TerminalId}. */
export const validateTerminalId: SchemaCheck<TerminalId> = validate2142;
/** Checks that a value is a {@link TerminalListUpdate}. */
export const validateTerminalListUpdate: SchemaCheck<TerminalListUpdate> = validate2143;
/** Checks that a value is a {@link TerminalOpenRequest}. */
export const validateTerminalOpenRequest: SchemaCheck<TerminalOpenRequest> = validate2147;
/** Checks that a value is a {@link TerminalOpenResponse}. */
export const validateTerminalOpenResponse: SchemaCheck<TerminalOpenResponse> = validate2148;
/** Checks that a value is a {@link TerminalOutputFrame}. */
export const validateTerminalOutputFrame: SchemaCheck<TerminalOutputFrame> = validate2149;
/** Checks that a value is a {@link TerminalOutputSubscribeRequest}. */
export const validateTerminalOutputSubscribeRequest: SchemaCheck<TerminalOutputSubscribeRequest> =
  validate2153;
/** Checks that a value is a {@link TerminalReorderRequest}. */
export const validateTerminalReorderRequest: SchemaCheck<TerminalReorderRequest> = validate2154;
/** Checks that a value is a {@link TerminalResizeRequest}. */
export const validateTerminalResizeRequest: SchemaCheck<TerminalResizeRequest> = validate2155;
/** Checks that a value is a {@link TerminalSubscribeRequest}. */
export const validateTerminalSubscribeRequest: SchemaCheck<TerminalSubscribeRequest> = validate2156;
/** Checks that a value is a {@link TerminalWriteRequest}. */
export const validateTerminalWriteRequest: SchemaCheck<TerminalWriteRequest> = validate2157;

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
export const TERMINAL_METHOD_DESCRIPTORS: TerminalMethodDescriptors = Object.freeze({
  "terminal.subscribe": Object.freeze({
    method: "terminal.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateTerminalSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateTerminalListUpdate,
  }),
  "terminal.open": Object.freeze({
    method: "terminal.open",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalOpenRequest,
    responseCheck: validateTerminalOpenResponse,
  }),
  "terminal.close": Object.freeze({
    method: "terminal.close",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalCloseRequest,
    responseCheck: validateNullPayload,
  }),
  "terminal.reorder": Object.freeze({
    method: "terminal.reorder",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalReorderRequest,
    responseCheck: validateNullPayload,
  }),
  "terminal.output.subscribe": Object.freeze({
    method: "terminal.output.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateTerminalOutputSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateTerminalOutputFrame,
  }),
  "terminal.write": Object.freeze({
    method: "terminal.write",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalWriteRequest,
    responseCheck: validateNullPayload,
  }),
  "terminal.resize": Object.freeze({
    method: "terminal.resize",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalResizeRequest,
    responseCheck: validateNullPayload,
  }),
  "terminal.appearance.report": Object.freeze({
    method: "terminal.appearance.report",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalAppearanceReportRequest,
    responseCheck: validateNullPayload,
  }),
});

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
export const TERMINAL_CONTROL_METHOD_DESCRIPTORS: TerminalControlMethodDescriptors = Object.freeze({
  "terminal.control.take": Object.freeze({
    method: "terminal.control.take",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalControlTakeRequest,
    responseCheck: validateTerminalControlTakeResponse,
  }),
  "terminal.flowControl.update": Object.freeze({
    method: "terminal.flowControl.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateTerminalFlowControlUpdateRequest,
    responseCheck: validateTerminalFlowControlUpdateResponse,
  }),
});
