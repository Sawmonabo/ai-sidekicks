// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's shells as a client addresses them: the live list, opening, closing and ordering, one shell's output stream, writing and resizing, terminal appearance, flow control, and the per-shell control lease.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  repeatsItemKey,
  ucs2length,
} from "../schema-check.js";
import { type HexColor, validateHexColor } from "./color.js";
import { type CommandId, validateCommandId } from "./command.js";
import { validateBytes } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  type SubscriptionId,
  validateSubscribeAcknowledgmentResponse,
  validateSubscriptionId,
} from "./jsonrpc/streaming.js";
import { type NullPayload, validateNullPayload } from "./method-descriptor.js";
import { type RunId, validateRunId } from "./run/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";
import { type DeviceId, validateDeviceId } from "./trust-statement.js";

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

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link TerminalId}. */
// prettier-ignore
export const validateTerminalId: CompiledSchemaCheck<TerminalId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateTerminalId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateTerminalId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateTerminalId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateTerminalId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalControlHolder}. */
// prettier-ignore
export const validateTerminalControlHolder: CompiledSchemaCheck<TerminalControlHolder> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlHolder {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalControlHolder.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.holderDeviceId === undefined) && (missing0 = "holderDeviceId")){validateTerminalControlHolder.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "holderDeviceId") || (key0 === "holderRunId")) || (key0 === "holderCommandId"))){validateTerminalControlHolder.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.holderDeviceId !== undefined){const _errs2: any = errors;if(!(validateDeviceId.call(this, data.holderDeviceId, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderRunId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.holderRunId, {instancePath:instancePath+"/holderRunId",parentData:data,parentDataProperty:"holderRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderCommandId !== undefined){const _errs4: any = errors;if(!(validateCommandId.call(this, data.holderCommandId, {instancePath:instancePath+"/holderCommandId",parentData:data,parentDataProperty:"holderCommandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.holderRunId !== undefined && ((data.holderCommandId === undefined) && (missing1 = "holderCommandId"))){validateTerminalControlHolder.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderRunId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderCommandId"}}];return false;}else {if(data.holderCommandId !== undefined && ((data.holderRunId === undefined) && (missing1 = "holderRunId"))){validateTerminalControlHolder.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderCommandId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderRunId"}}];return false;}}}}}}}}else {validateTerminalControlHolder.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalControlHolder.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalControlHolder.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalSubscribeRequest}. */
// prettier-ignore
export const validateTerminalSubscribeRequest: CompiledSchemaCheck<TerminalSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateTerminalSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateTerminalSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateTerminalSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalShellStatus}. */
// prettier-ignore
export const validateTerminalShellStatus: CompiledSchemaCheck<TerminalShellStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalShellStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalShellStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "running"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.state === undefined) && (missing0 = "state")){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "state")){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;if(typeof data0 !== "string"){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data0){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "running"}}];return false;}}}}}else {validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "exited"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.state === undefined) && (missing1 = "state")) || ((data.exitCode === undefined) && (missing1 = "exitCode"))){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!((key1 === "state") || (key1 === "exitCode"))){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.state !== undefined){let data1: any = data.state;const _errs10: any = errors;if(typeof data1 !== "string"){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("exited" !== data1){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "exited"}}];return false;}var valid4: any = _errs10 === errors;}else {var valid4: any = true;}if(valid4){if(data.exitCode !== undefined){let data2: any = data.exitCode;const _errs12: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/1/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/1/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < -9007199254740991 || isNaN(data2)){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/1/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}}}}}else {validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "didNotStart"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.state === undefined) && (missing2 = "state")) || ((data.cause === undefined) && (missing2 = "cause"))){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!((key2 === "state") || (key2 === "cause"))){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.state !== undefined){let data3: any = data.state;const _errs17: any = errors;if(typeof data3 !== "string"){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("didNotStart" !== data3){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "didNotStart"}}];return false;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data.cause !== undefined){let data4: any = data.cause;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(func1(data4) < 1){validateTerminalShellStatus.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/oneOf/2/properties/cause/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateTerminalShellStatus.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/oneOf/2/properties/cause/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}else {validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateTerminalShellStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalShellStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalShellStatus.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalListEntry}. */
// prettier-ignore
export const validateTerminalListEntry: CompiledSchemaCheck<TerminalListEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalListEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.terminalId === undefined) && (missing0 = "terminalId")) || ((data.title === undefined) && (missing0 = "title"))) || ((data.status === undefined) && (missing0 = "status"))) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.leaseVersion === undefined) && (missing0 = "leaseVersion"))){validateTerminalListEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "terminalId") || (key0 === "title")) || (key0 === "status")) || (key0 === "holder")) || (key0 === "leaseVersion"))){validateTerminalListEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){const _errs2: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){let data1: any = data.title;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateTerminalListEntry.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateTerminalListEntry.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateTerminalListEntry.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs5: any = errors;if(!(validateTerminalShellStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalShellStatus.errors : vErrors.concat(validateTerminalShellStatus.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.holder !== undefined){let data3: any = data.holder;const _errs6: any = errors;const _errs7: any = errors;let valid1: any = false;const _errs8: any = errors;if(!(validateTerminalControlHolder.call(this, data3, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalControlHolder.errors : vErrors.concat(validateTerminalControlHolder.errors);errors = vErrors.length;}var _valid0: any = _errs8 === errors;valid1 = valid1 || _valid0;const _errs9: any = errors;if(data3 !== null){const err0: any = {instancePath:instancePath+"/holder",schemaPath:"#/properties/holder/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs9 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/holder",schemaPath:"#/properties/holder/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateTerminalListEntry.errors = vErrors;return false;}else {errors = _errs7;if(vErrors !== null){if(_errs7){vErrors.length = _errs7;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.leaseVersion !== undefined){let data4: any = data.leaseVersion;const _errs11: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateTerminalListEntry.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateTerminalListEntry.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateTerminalListEntry.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}else {validateTerminalListEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalListEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalListEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link TerminalListUpdate}. */
// prettier-ignore
export const validateTerminalListUpdate: CompiledSchemaCheck<TerminalListUpdate> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalListUpdate {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalListUpdate.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminals === undefined) && (missing0 = "terminals"))){validateTerminalListUpdate.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "terminals"))){validateTerminalListUpdate.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminals !== undefined){let data1: any = data.terminals;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateTerminalListEntry.call(this, data1[i0], {instancePath:instancePath+"/terminals/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalListEntry.errors : vErrors.concat(validateTerminalListEntry.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}if(valid1){let valid2: any;let i1: any = data1.length;let j0: any;valid2 = true;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data1[i1], data1[j0])){validateTerminalListUpdate.errors = [{instancePath:instancePath+"/terminals",schemaPath:"#/properties/terminals/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;valid2 = false;break outer0;}}}}if(valid2){if(repeatsItemKey(data1, "terminalId")){validateTerminalListUpdate.errors = [{instancePath:instancePath+"/terminals",schemaPath:"#/properties/terminals/uniqueItemKey",keyword:"uniqueItemKey",params:{}}];return false;}}}}else {validateTerminalListUpdate.errors = [{instancePath:instancePath+"/terminals",schemaPath:"#/properties/terminals/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateTerminalListUpdate.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalListUpdate.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalListUpdate.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link TerminalOpenRequest}. */
// prettier-ignore
export const validateTerminalOpenRequest: CompiledSchemaCheck<TerminalOpenRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOpenRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalOpenRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateTerminalOpenRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "clientIdempotencyKey"))){validateTerminalOpenRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data1: any = data.clientIdempotencyKey;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(!pattern88.test(data1)){validateTerminalOpenRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateTerminalOpenRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateTerminalOpenRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalOpenRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalOpenRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalOpenResponse}. */
// prettier-ignore
export const validateTerminalOpenResponse: CompiledSchemaCheck<TerminalOpenResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOpenResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalOpenResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.terminalId === undefined) && (missing0 = "terminalId")){validateTerminalOpenResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "terminalId")){validateTerminalOpenResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}}}}}else {validateTerminalOpenResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalOpenResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalOpenResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalCloseRequest}. */
// prettier-ignore
export const validateTerminalCloseRequest: CompiledSchemaCheck<TerminalCloseRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalCloseRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalCloseRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))){validateTerminalCloseRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "force"))){validateTerminalCloseRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){const _errs3: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.force !== undefined){const _errs4: any = errors;if(typeof data.force !== "boolean"){validateTerminalCloseRequest.errors = [{instancePath:instancePath+"/force",schemaPath:"#/properties/force/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateTerminalCloseRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalCloseRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalCloseRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalReorderRequest}. */
// prettier-ignore
export const validateTerminalReorderRequest: CompiledSchemaCheck<TerminalReorderRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalReorderRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalReorderRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalIds === undefined) && (missing0 = "terminalIds"))){validateTerminalReorderRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "terminalIds"))){validateTerminalReorderRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalIds !== undefined){let data1: any = data.terminalIds;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){if(data1.length < 1){validateTerminalReorderRequest.errors = [{instancePath:instancePath+"/terminalIds",schemaPath:"#/properties/terminalIds/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateTerminalId.call(this, data1[i0], {instancePath:instancePath+"/terminalIds/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}if(valid1){let i1: any = data1.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data1[i1], data1[j0])){validateTerminalReorderRequest.errors = [{instancePath:instancePath+"/terminalIds",schemaPath:"#/properties/terminalIds/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validateTerminalReorderRequest.errors = [{instancePath:instancePath+"/terminalIds",schemaPath:"#/properties/terminalIds/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateTerminalReorderRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalReorderRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalReorderRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalOutputSubscribeRequest}. */
// prettier-ignore
export const validateTerminalOutputSubscribeRequest: CompiledSchemaCheck<TerminalOutputSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOutputSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalOutputSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))){validateTerminalOutputSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "afterOffset"))){validateTerminalOutputSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){const _errs3: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.afterOffset !== undefined){let data2: any = data.afterOffset;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateTerminalOutputSubscribeRequest.errors = [{instancePath:instancePath+"/afterOffset",schemaPath:"#/properties/afterOffset/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateTerminalOutputSubscribeRequest.errors = [{instancePath:instancePath+"/afterOffset",schemaPath:"#/properties/afterOffset/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateTerminalOutputSubscribeRequest.errors = [{instancePath:instancePath+"/afterOffset",schemaPath:"#/properties/afterOffset/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateTerminalOutputSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalOutputSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalOutputSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1335: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"scrollback"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"data":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","maxBytes":4194300,"tsType":"Uint8Array","description":"The window's bytes."},"columns":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The columns it was last drawn at."},"rows":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The rows it was last drawn at."},"holder":{"anyOf":[{"$ref":"#/$defs/TerminalControlHolder"},{"type":"null"}],"description":"Who holds the shell, or `null`."},"leaseVersion":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The lease version the holder was read at."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","data","columns","rows","holder","leaseVersion","cursor"],"description":"The scrollback window opens."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"scrollbackContinuation"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"data":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":4194300,"tsType":"Uint8Array","description":"The window's next bytes."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","data","cursor"],"description":"The scrollback window goes on."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"output"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"data":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes","minBytes":1,"maxBytes":4194300,"tsType":"Uint8Array","description":"The bytes."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","data","cursor"],"description":"What the shell wrote next."},{"type":"object","additionalProperties":false,"properties":{"kind":{"type":"string","const":"exited"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"terminalId":{"$ref":"#/$defs/TerminalId","description":"The shell."},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"The program's exit code."},"cursor":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The output offset after the change."}},"required":["kind","sessionId","terminalId","exitCode","cursor"],"description":"The shell's program ended."}],"description":"One change on a shell's output stream; `cursor` is the shell's output offset once the change is\napplied, in bytes since the shell started. `scrollback` opens the scrollback window, starting at\nits first whole line, with the columns and rows it was last drawn at (so a running program's\nboxes come back unwrapped) and who holds it at which lease version; a window too large for one\nmessage goes on in `scrollbackContinuation` changes, each in a frame of its own, before any\noutput. `output` is what the shell wrote next, in order; `exited` is its program's end. Output\nand scrollback travel as raw bytes, an attachment each, with no character held back.","discriminator":{"propertyName":"kind"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link TerminalOutputChange}. */
// prettier-ignore
export const validateTerminalOutputChange: CompiledSchemaCheck<TerminalOutputChange> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOutputChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalOutputChange.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "scrollback"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.data === undefined) && (missing0 = "data"))) || ((data.columns === undefined) && (missing0 = "columns"))) || ((data.rows === undefined) && (missing0 = "rows"))) || ((data.holder === undefined) && (missing0 = "holder"))) || ((data.leaseVersion === undefined) && (missing0 = "leaseVersion"))) || ((data.cursor === undefined) && (missing0 = "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema1335.oneOf[0].properties, key0))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("scrollback" !== data0){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "scrollback"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.terminalId !== undefined){const _errs8: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.data !== undefined){let data3: any = data.data;const _errs9: any = errors;if(!(validateBytes.call(this, data3, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data3 && typeof data3 == "object" && Number.isInteger(data3.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data3.$bytes] instanceof Uint8Array && this.attachments[data3.$bytes].byteLength <= 4194300)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.columns !== undefined){let data4: any = data.columns;const _errs11: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/oneOf/0/properties/columns/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/oneOf/0/properties/columns/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 1 || isNaN(data4)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/oneOf/0/properties/columns/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.rows !== undefined){let data5: any = data.rows;const _errs13: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/oneOf/0/properties/rows/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/oneOf/0/properties/rows/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 1 || isNaN(data5)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/oneOf/0/properties/rows/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.holder !== undefined){let data6: any = data.holder;const _errs15: any = errors;const _errs16: any = errors;let valid3: any = false;const _errs17: any = errors;if(!(validateTerminalControlHolder.call(this, data6, {instancePath:instancePath+"/holder",parentData:data,parentDataProperty:"holder",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalControlHolder.errors : vErrors.concat(validateTerminalControlHolder.errors);errors = vErrors.length;}var _valid0: any = _errs17 === errors;valid3 = valid3 || _valid0;const _errs18: any = errors;if(data6 !== null){const err0: any = {instancePath:instancePath+"/holder",schemaPath:"#/oneOf/0/properties/holder/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs18 === errors;valid3 = valid3 || _valid0;if(!valid3){const err1: any = {instancePath:instancePath+"/holder",schemaPath:"#/oneOf/0/properties/holder/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateTerminalOutputChange.errors = vErrors;return false;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.leaseVersion !== undefined){let data7: any = data.leaseVersion;const _errs20: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data.cursor !== undefined){let data8: any = data.cursor;const _errs22: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/0/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs22){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/0/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/0/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props1: any = true;valid0 = valid1;}else if(tag0 === "scrollbackContinuation"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.data === undefined) && (missing1 = "data"))) || ((data.cursor === undefined) && (missing1 = "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs26: any = errors;for(const key1 in data){if(!(((((key1 === "kind") || (key1 === "sessionId")) || (key1 === "terminalId")) || (key1 === "data")) || (key1 === "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs26 === errors){if(data.kind !== undefined){let data9: any = data.kind;const _errs27: any = errors;if(typeof data9 !== "string"){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("scrollbackContinuation" !== data9){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "scrollbackContinuation"}}];return false;}var valid5: any = _errs27 === errors;}else {var valid5: any = true;}if(valid5){if(data.sessionId !== undefined){const _errs29: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid5: any = _errs29 === errors;}else {var valid5: any = true;}if(valid5){if(data.terminalId !== undefined){const _errs30: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid5: any = _errs30 === errors;}else {var valid5: any = true;}if(valid5){if(data.data !== undefined){let data12: any = data.data;const _errs31: any = errors;if(!(validateBytes.call(this, data12, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data12 && typeof data12 == "object" && Number.isInteger(data12.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data12.$bytes] instanceof Uint8Array && this.attachments[data12.$bytes].byteLength >= 1)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data12 && typeof data12 == "object" && Number.isInteger(data12.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data12.$bytes] instanceof Uint8Array && this.attachments[data12.$bytes].byteLength <= 4194300)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid5: any = _errs31 === errors;}else {var valid5: any = true;}if(valid5){if(data.cursor !== undefined){let data13: any = data.cursor;const _errs33: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/1/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs33){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/1/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data13 < 0 || isNaN(data13)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/1/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs33 === errors;}else {var valid5: any = true;}}}}}}}}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs24 === errors;if(props1 !== true){props1 = true;}valid0 = valid4;}else if(tag0 === "output"){const _errs35: any = errors;if(errors === _errs35){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.terminalId === undefined) && (missing2 = "terminalId"))) || ((data.data === undefined) && (missing2 = "data"))) || ((data.cursor === undefined) && (missing2 = "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs37: any = errors;for(const key2 in data){if(!(((((key2 === "kind") || (key2 === "sessionId")) || (key2 === "terminalId")) || (key2 === "data")) || (key2 === "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs37 === errors){if(data.kind !== undefined){let data14: any = data.kind;const _errs38: any = errors;if(typeof data14 !== "string"){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("output" !== data14){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "output"}}];return false;}var valid7: any = _errs38 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){const _errs40: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid7: any = _errs40 === errors;}else {var valid7: any = true;}if(valid7){if(data.terminalId !== undefined){const _errs41: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid7: any = _errs41 === errors;}else {var valid7: any = true;}if(valid7){if(data.data !== undefined){let data17: any = data.data;const _errs42: any = errors;if(!(validateBytes.call(this, data17, {instancePath:instancePath+"/data",parentData:data,parentDataProperty:"data",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data17 && typeof data17 == "object" && Number.isInteger(data17.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data17.$bytes] instanceof Uint8Array && this.attachments[data17.$bytes].byteLength >= 1)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/2/properties/data/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data17 && typeof data17 == "object" && Number.isInteger(data17.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data17.$bytes] instanceof Uint8Array && this.attachments[data17.$bytes].byteLength <= 4194300)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/2/properties/data/maxBytes",keyword:"maxBytes",params:{}}];return false;}}}var valid7: any = _errs42 === errors;}else {var valid7: any = true;}if(valid7){if(data.cursor !== undefined){let data18: any = data.cursor;const _errs44: any = errors;if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/2/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs44){if((typeof data18 == "number") && (isFinite(data18))){if(data18 > 9007199254740991 || isNaN(data18)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/2/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data18 < 0 || isNaN(data18)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/2/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs44 === errors;}else {var valid7: any = true;}}}}}}}}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs35 === errors;if(props1 !== true){props1 = true;}valid0 = valid6;}else if(tag0 === "exited"){const _errs46: any = errors;if(errors === _errs46){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((((data.kind === undefined) && (missing3 = "kind")) || ((data.sessionId === undefined) && (missing3 = "sessionId"))) || ((data.terminalId === undefined) && (missing3 = "terminalId"))) || ((data.exitCode === undefined) && (missing3 = "exitCode"))) || ((data.cursor === undefined) && (missing3 = "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs48: any = errors;for(const key3 in data){if(!(((((key3 === "kind") || (key3 === "sessionId")) || (key3 === "terminalId")) || (key3 === "exitCode")) || (key3 === "cursor"))){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs48 === errors){if(data.kind !== undefined){let data19: any = data.kind;const _errs49: any = errors;if(typeof data19 !== "string"){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("exited" !== data19){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "exited"}}];return false;}var valid9: any = _errs49 === errors;}else {var valid9: any = true;}if(valid9){if(data.sessionId !== undefined){const _errs51: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid9: any = _errs51 === errors;}else {var valid9: any = true;}if(valid9){if(data.terminalId !== undefined){const _errs52: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid9: any = _errs52 === errors;}else {var valid9: any = true;}if(valid9){if(data.exitCode !== undefined){let data22: any = data.exitCode;const _errs53: any = errors;if(!(((typeof data22 == "number") && (!(data22 % 1) && !isNaN(data22))) && (isFinite(data22)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs53){if((typeof data22 == "number") && (isFinite(data22))){if(data22 > 9007199254740991 || isNaN(data22)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data22 < -9007199254740991 || isNaN(data22)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/oneOf/3/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid9: any = _errs53 === errors;}else {var valid9: any = true;}if(valid9){if(data.cursor !== undefined){let data23: any = data.cursor;const _errs55: any = errors;if(!(((typeof data23 == "number") && (!(data23 % 1) && !isNaN(data23))) && (isFinite(data23)))){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/3/properties/cursor/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs55){if((typeof data23 == "number") && (isFinite(data23))){if(data23 > 9007199254740991 || isNaN(data23)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/3/properties/cursor/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data23 < 0 || isNaN(data23)){validateTerminalOutputChange.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/oneOf/3/properties/cursor/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs55 === errors;}else {var valid9: any = true;}}}}}}}}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs46 === errors;if(props1 !== true){props1 = true;}valid0 = valid8;}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props1 !== true){for(const key4 in data){if(!props1 || !props1[key4]){validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validateTerminalOutputChange.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalOutputChange.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalOutputChange.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalOutputFrame}. */
// prettier-ignore
export const validateTerminalOutputFrame: CompiledSchemaCheck<TerminalOutputFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalOutputFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalOutputFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.changes === undefined) && (missing0 = "changes")){validateTerminalOutputFrame.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "changes") || (key0 === "dropped"))){validateTerminalOutputFrame.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.changes !== undefined){let data0: any = data.changes;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){if(data0.length > 50){validateTerminalOutputFrame.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/maxItems",keyword:"maxItems",params:{limit: 50}}];return false;}else {if(data0.length < 1){validateTerminalOutputFrame.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateTerminalOutputChange.call(this, data0[i0], {instancePath:instancePath+"/changes/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalOutputChange.errors : vErrors.concat(validateTerminalOutputChange.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}}}else {validateTerminalOutputFrame.errors = [{instancePath:instancePath+"/changes",schemaPath:"#/properties/changes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.dropped !== undefined){let data2: any = data.dropped;const _errs5: any = errors;if(typeof data2 !== "boolean"){validateTerminalOutputFrame.errors = [{instancePath:instancePath+"/dropped",schemaPath:"#/properties/dropped/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data2){validateTerminalOutputFrame.errors = [{instancePath:instancePath+"/dropped",schemaPath:"#/properties/dropped/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validateTerminalOutputFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalOutputFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalOutputFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalWriteRequest}. */
// prettier-ignore
export const validateTerminalWriteRequest: CompiledSchemaCheck<TerminalWriteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalWriteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "keys"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.outputSubscriptionId === undefined) && (missing0 = "outputSubscriptionId"))) || ((data.data === undefined) && (missing0 = "data"))){validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "kind") || (key0 === "sessionId")) || (key0 === "terminalId")) || (key0 === "outputSubscriptionId")) || (key0 === "data"))){validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("keys" !== data0){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "keys"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.terminalId !== undefined){const _errs8: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.outputSubscriptionId !== undefined){const _errs9: any = errors;if(!(validateSubscriptionId.call(this, data.outputSubscriptionId, {instancePath:instancePath+"/outputSubscriptionId",parentData:data,parentDataProperty:"outputSubscriptionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSubscriptionId.errors : vErrors.concat(validateSubscriptionId.errors);errors = vErrors.length;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.data !== undefined){let data4: any = data.data;const _errs10: any = errors;if(errors === _errs10){if(typeof data4 === "string"){if(func1(data4) > 65536){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/maxLength",keyword:"maxLength",params:{limit: 65536}}];return false;}else {if(new TextEncoder().encode(data4).byteLength > 65536){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/maxUtf8Bytes",keyword:"maxUtf8Bytes",params:{}}];return false;}}}else {validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/0/properties/data/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}}}}}}}}else {validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "paste"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.outputSubscriptionId === undefined) && (missing1 = "outputSubscriptionId"))) || ((data.data === undefined) && (missing1 = "data"))) || ((data.pasteId === undefined) && (missing1 = "pasteId"))) || ((data.isLastPart === undefined) && (missing1 = "isLastPart"))){validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data){if(!(((((((key1 === "kind") || (key1 === "sessionId")) || (key1 === "terminalId")) || (key1 === "outputSubscriptionId")) || (key1 === "data")) || (key1 === "pasteId")) || (key1 === "isLastPart"))){validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs15: any = errors;if(typeof data5 !== "string"){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("paste" !== data5){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "paste"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs17: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.terminalId !== undefined){const _errs18: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.outputSubscriptionId !== undefined){const _errs19: any = errors;if(!(validateSubscriptionId.call(this, data.outputSubscriptionId, {instancePath:instancePath+"/outputSubscriptionId",parentData:data,parentDataProperty:"outputSubscriptionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSubscriptionId.errors : vErrors.concat(validateSubscriptionId.errors);errors = vErrors.length;}var valid4: any = _errs19 === errors;}else {var valid4: any = true;}if(valid4){if(data.data !== undefined){let data9: any = data.data;const _errs20: any = errors;if(errors === _errs20){if(typeof data9 === "string"){if(func1(data9) > 65536){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/maxLength",keyword:"maxLength",params:{limit: 65536}}];return false;}else {if(new TextEncoder().encode(data9).byteLength > 65536){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/maxUtf8Bytes",keyword:"maxUtf8Bytes",params:{}}];return false;}}}else {validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.pasteId !== undefined){let data10: any = data.pasteId;const _errs22: any = errors;if(errors === _errs22){if(typeof data10 === "string"){if(!pattern88.test(data10)){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/pasteId",schemaPath:"#/oneOf/1/properties/pasteId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/pasteId",schemaPath:"#/oneOf/1/properties/pasteId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.isLastPart !== undefined){const _errs24: any = errors;if(typeof data.isLastPart !== "boolean"){validateTerminalWriteRequest.errors = [{instancePath:instancePath+"/isLastPart",schemaPath:"#/oneOf/1/properties/isLastPart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}}}}}}}}}}else {validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateTerminalWriteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalWriteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalWriteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalResizeRequest}. */
// prettier-ignore
export const validateTerminalResizeRequest: CompiledSchemaCheck<TerminalResizeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalResizeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalResizeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.columns === undefined) && (missing0 = "columns"))) || ((data.rows === undefined) && (missing0 = "rows"))){validateTerminalResizeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "columns")) || (key0 === "rows"))){validateTerminalResizeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){const _errs3: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.columns !== undefined){let data2: any = data.columns;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateTerminalResizeRequest.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateTerminalResizeRequest.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateTerminalResizeRequest.errors = [{instancePath:instancePath+"/columns",schemaPath:"#/properties/columns/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.rows !== undefined){let data3: any = data.rows;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateTerminalResizeRequest.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateTerminalResizeRequest.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateTerminalResizeRequest.errors = [{instancePath:instancePath+"/rows",schemaPath:"#/properties/rows/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateTerminalResizeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalResizeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalResizeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalColors}. */
// prettier-ignore
export const validateTerminalColors: CompiledSchemaCheck<TerminalColors> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalColors {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalColors.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.foreground === undefined) && (missing0 = "foreground")) || ((data.background === undefined) && (missing0 = "background"))) || ((data.cursor === undefined) && (missing0 = "cursor"))) || ((data.palette === undefined) && (missing0 = "palette"))){validateTerminalColors.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "foreground") || (key0 === "background")) || (key0 === "cursor")) || (key0 === "palette"))){validateTerminalColors.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.foreground !== undefined){const _errs2: any = errors;if(!(validateHexColor.call(this, data.foreground, {instancePath:instancePath+"/foreground",parentData:data,parentDataProperty:"foreground",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateHexColor.errors : vErrors.concat(validateHexColor.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.background !== undefined){const _errs3: any = errors;if(!(validateHexColor.call(this, data.background, {instancePath:instancePath+"/background",parentData:data,parentDataProperty:"background",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateHexColor.errors : vErrors.concat(validateHexColor.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){const _errs4: any = errors;if(!(validateHexColor.call(this, data.cursor, {instancePath:instancePath+"/cursor",parentData:data,parentDataProperty:"cursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateHexColor.errors : vErrors.concat(validateHexColor.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.palette !== undefined){let data3: any = data.palette;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data3)){if(data3.length > 16){validateTerminalColors.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/maxItems",keyword:"maxItems",params:{limit: 16}}];return false;}else {if(data3.length < 16){validateTerminalColors.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/minItems",keyword:"minItems",params:{limit: 16}}];return false;}else {var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validateHexColor.call(this, data3[i0], {instancePath:instancePath+"/palette/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateHexColor.errors : vErrors.concat(validateHexColor.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;if(!valid1){break;}}}}}else {validateTerminalColors.errors = [{instancePath:instancePath+"/palette",schemaPath:"#/properties/palette/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateTerminalColors.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalColors.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalColors.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalCellSize}. */
// prettier-ignore
export const validateTerminalCellSize: CompiledSchemaCheck<TerminalCellSize> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalCellSize {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalCellSize.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.width === undefined) && (missing0 = "width")) || ((data.height === undefined) && (missing0 = "height"))){validateTerminalCellSize.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "width") || (key0 === "height"))){validateTerminalCellSize.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.width !== undefined){let data0: any = data.width;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateTerminalCellSize.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateTerminalCellSize.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateTerminalCellSize.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.height !== undefined){let data1: any = data.height;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateTerminalCellSize.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateTerminalCellSize.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateTerminalCellSize.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateTerminalCellSize.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalCellSize.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalCellSize.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalAppearanceReportRequest}. */
// prettier-ignore
export const validateTerminalAppearanceReportRequest: CompiledSchemaCheck<TerminalAppearanceReportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalAppearanceReportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalAppearanceReportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.source;if(typeof tag0 == "string"){if(tag0 === "consoleTheme"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.source === undefined) && (missing0 = "source")) || ((data.colors === undefined) && (missing0 = "colors"))){validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "source") || (key0 === "colors"))){validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.source !== undefined){let data0: any = data.source;const _errs5: any = errors;if(typeof data0 !== "string"){validateTerminalAppearanceReportRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/0/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}if("consoleTheme" !== data0){validateTerminalAppearanceReportRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/0/properties/source/const",keyword:"const",params:{allowedValue: "consoleTheme"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.colors !== undefined){const _errs7: any = errors;if(!(validateTerminalColors.call(this, data.colors, {instancePath:instancePath+"/colors",parentData:data,parentDataProperty:"colors",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalColors.errors : vErrors.concat(validateTerminalColors.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "holdingPane"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.source === undefined) && (missing1 = "source")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.colors === undefined) && (missing1 = "colors"))) || ((data.cellSize === undefined) && (missing1 = "cellSize"))){validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!(((((key1 === "source") || (key1 === "sessionId")) || (key1 === "terminalId")) || (key1 === "colors")) || (key1 === "cellSize"))){validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.source !== undefined){let data2: any = data.source;const _errs11: any = errors;if(typeof data2 !== "string"){validateTerminalAppearanceReportRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/1/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}if("holdingPane" !== data2){validateTerminalAppearanceReportRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/oneOf/1/properties/source/const",keyword:"const",params:{allowedValue: "holdingPane"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs13: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.terminalId !== undefined){const _errs14: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.colors !== undefined){const _errs15: any = errors;if(!(validateTerminalColors.call(this, data.colors, {instancePath:instancePath+"/colors",parentData:data,parentDataProperty:"colors",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalColors.errors : vErrors.concat(validateTerminalColors.errors);errors = vErrors.length;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.cellSize !== undefined){const _errs16: any = errors;if(!(validateTerminalCellSize.call(this, data.cellSize, {instancePath:instancePath+"/cellSize",parentData:data,parentDataProperty:"cellSize",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalCellSize.errors : vErrors.concat(validateTerminalCellSize.errors);errors = vErrors.length;}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}}}}}}}}else {validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "source", tagValue: tag0}}];return false;}}else {validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "source", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateTerminalAppearanceReportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalAppearanceReportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalAppearanceReportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalFlowControlUpdateRequest}. */
// prettier-ignore
export const validateTerminalFlowControlUpdateRequest: CompiledSchemaCheck<TerminalFlowControlUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalFlowControlUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalFlowControlUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.paused === undefined) && (missing0 = "paused"))){validateTerminalFlowControlUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "paused"))){validateTerminalFlowControlUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){const _errs3: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.paused !== undefined){const _errs4: any = errors;if(typeof data.paused !== "boolean"){validateTerminalFlowControlUpdateRequest.errors = [{instancePath:instancePath+"/paused",schemaPath:"#/properties/paused/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateTerminalFlowControlUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalFlowControlUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalFlowControlUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalFlowControlUpdateResponse}. */
// prettier-ignore
export const validateTerminalFlowControlUpdateResponse: CompiledSchemaCheck<TerminalFlowControlUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalFlowControlUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalFlowControlUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accepted === undefined) && (missing0 = "accepted")){validateTerminalFlowControlUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accepted")){validateTerminalFlowControlUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accepted !== undefined){let data0: any = data.accepted;if(typeof data0 !== "boolean"){validateTerminalFlowControlUpdateResponse.errors = [{instancePath:instancePath+"/accepted",schemaPath:"#/properties/accepted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validateTerminalFlowControlUpdateResponse.errors = [{instancePath:instancePath+"/accepted",schemaPath:"#/properties/accepted/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validateTerminalFlowControlUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalFlowControlUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalFlowControlUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalControlTakeRequest}. */
// prettier-ignore
export const validateTerminalControlTakeRequest: CompiledSchemaCheck<TerminalControlTakeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlTakeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalControlTakeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.terminalId === undefined) && (missing0 = "terminalId"))) || ((data.outputSubscriptionId === undefined) && (missing0 = "outputSubscriptionId"))){validateTerminalControlTakeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "terminalId")) || (key0 === "outputSubscriptionId")) || (key0 === "force"))){validateTerminalControlTakeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.terminalId !== undefined){const _errs3: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSubscriptionId !== undefined){const _errs4: any = errors;if(!(validateSubscriptionId.call(this, data.outputSubscriptionId, {instancePath:instancePath+"/outputSubscriptionId",parentData:data,parentDataProperty:"outputSubscriptionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSubscriptionId.errors : vErrors.concat(validateSubscriptionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.force !== undefined){const _errs5: any = errors;if(typeof data.force !== "boolean"){validateTerminalControlTakeRequest.errors = [{instancePath:instancePath+"/force",schemaPath:"#/properties/force/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateTerminalControlTakeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalControlTakeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalControlTakeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalControlTakeResponse}. */
// prettier-ignore
export const validateTerminalControlTakeResponse: CompiledSchemaCheck<TerminalControlTakeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlTakeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalControlTakeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.terminalId === undefined) && (missing0 = "terminalId")) || ((data.holderDeviceId === undefined) && (missing0 = "holderDeviceId"))){validateTerminalControlTakeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "terminalId") || (key0 === "holderDeviceId"))){validateTerminalControlTakeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){const _errs2: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderDeviceId !== undefined){const _errs3: any = errors;if(!(validateDeviceId.call(this, data.holderDeviceId, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateTerminalControlTakeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalControlTakeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalControlTakeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalControlChangedPayload}. */
// prettier-ignore
export const validateTerminalControlChangedPayload: CompiledSchemaCheck<TerminalControlChangedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlChangedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalControlChangedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(data.holderRunId !== undefined && ((data.holderCommandId === undefined) && (missing0 = "holderCommandId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderRunId",
    missingProperty: missing0,
    depsCount: 1,
    deps: "holderCommandId"}}];return false;}else {if(data.holderCommandId !== undefined && ((data.holderRunId === undefined) && (missing0 = "holderRunId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderCommandId",
    missingProperty: missing0,
    depsCount: 1,
    deps: "holderRunId"}}];return false;}else {let valid0: any = false;const tag0: any = data.reason;if(typeof tag0 == "string"){if(tag0 === "taken"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.reason === undefined) && (missing1 = "reason")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.terminalId === undefined) && (missing1 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing1 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing1 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing1 = "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((((((key0 === "reason") || (key0 === "sessionId")) || (key0 === "terminalId")) || (key0 === "leaseVersion")) || (key0 === "holderDeviceId")) || (key0 === "holderRunId")) || (key0 === "holderCommandId")) || (key0 === "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.reason !== undefined){let data0: any = data.reason;const _errs5: any = errors;if(typeof data0 !== "string"){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("taken" !== data0){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/0/properties/reason/const",keyword:"const",params:{allowedValue: "taken"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.terminalId !== undefined){const _errs8: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.leaseVersion !== undefined){let data3: any = data.leaseVersion;const _errs9: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/0/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.holderDeviceId !== undefined){const _errs11: any = errors;if(!(validateDeviceId.call(this, data.holderDeviceId, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.holderRunId !== undefined){const _errs12: any = errors;if(!(validateRunId.call(this, data.holderRunId, {instancePath:instancePath+"/holderRunId",parentData:data,parentDataProperty:"holderRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.holderCommandId !== undefined){const _errs13: any = errors;if(!(validateCommandId.call(this, data.holderCommandId, {instancePath:instancePath+"/holderCommandId",parentData:data,parentDataProperty:"holderCommandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.previousHolderDeviceId !== undefined){let data7: any = data.previousHolderDeviceId;const _errs14: any = errors;const _errs15: any = errors;let valid3: any = false;const _errs16: any = errors;if(!(validateDeviceId.call(this, data7, {instancePath:instancePath+"/previousHolderDeviceId",parentData:data,parentDataProperty:"previousHolderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var _valid0: any = _errs16 === errors;valid3 = valid3 || _valid0;const _errs17: any = errors;if(data7 !== null){const err0: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"#/oneOf/0/properties/previousHolderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs17 === errors;valid3 = valid3 || _valid0;if(!valid3){const err1: any = {instancePath:instancePath+"/previousHolderDeviceId",schemaPath:"#/oneOf/0/properties/previousHolderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateTerminalControlChangedPayload.errors = vErrors;return false;}else {errors = _errs15;if(vErrors !== null){if(_errs15){vErrors.length = _errs15;}else {vErrors = null;}}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "takenByForce"){const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((data.reason === undefined) && (missing2 = "reason")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.terminalId === undefined) && (missing2 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing2 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing2 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing2 = "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs21: any = errors;for(const key1 in data){if(!((((((((key1 === "reason") || (key1 === "sessionId")) || (key1 === "terminalId")) || (key1 === "leaseVersion")) || (key1 === "holderDeviceId")) || (key1 === "holderRunId")) || (key1 === "holderCommandId")) || (key1 === "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs21 === errors){if(data.reason !== undefined){let data8: any = data.reason;const _errs22: any = errors;if(typeof data8 !== "string"){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("takenByForce" !== data8){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/1/properties/reason/const",keyword:"const",params:{allowedValue: "takenByForce"}}];return false;}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}if(valid5){if(data.sessionId !== undefined){const _errs24: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid5: any = _errs24 === errors;}else {var valid5: any = true;}if(valid5){if(data.terminalId !== undefined){const _errs25: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid5: any = _errs25 === errors;}else {var valid5: any = true;}if(valid5){if(data.leaseVersion !== undefined){let data11: any = data.leaseVersion;const _errs26: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/1/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs26){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/1/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 1 || isNaN(data11)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/1/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data.holderDeviceId !== undefined){const _errs28: any = errors;if(!(validateDeviceId.call(this, data.holderDeviceId, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid5: any = _errs28 === errors;}else {var valid5: any = true;}if(valid5){if(data.holderRunId !== undefined){const _errs29: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/1/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid5: any = _errs29 === errors;}else {var valid5: any = true;}if(valid5){if(data.holderCommandId !== undefined){const _errs32: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/1/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid5: any = _errs32 === errors;}else {var valid5: any = true;}if(valid5){if(data.previousHolderDeviceId !== undefined){const _errs35: any = errors;if(!(validateDeviceId.call(this, data.previousHolderDeviceId, {instancePath:instancePath+"/previousHolderDeviceId",parentData:data,parentDataProperty:"previousHolderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid5: any = _errs35 === errors;}else {var valid5: any = true;}}}}}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs19 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else if(tag0 === "autoReleasedDisconnect"){const _errs36: any = errors;if(errors === _errs36){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((((data.reason === undefined) && (missing3 = "reason")) || ((data.sessionId === undefined) && (missing3 = "sessionId"))) || ((data.terminalId === undefined) && (missing3 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing3 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing3 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing3 = "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs38: any = errors;for(const key2 in data){if(!((((((((key2 === "reason") || (key2 === "sessionId")) || (key2 === "terminalId")) || (key2 === "leaseVersion")) || (key2 === "holderDeviceId")) || (key2 === "holderRunId")) || (key2 === "holderCommandId")) || (key2 === "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs38 === errors){if(data.reason !== undefined){let data16: any = data.reason;const _errs39: any = errors;if(typeof data16 !== "string"){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedDisconnect" !== data16){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedDisconnect"}}];return false;}var valid7: any = _errs39 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){const _errs41: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid7: any = _errs41 === errors;}else {var valid7: any = true;}if(valid7){if(data.terminalId !== undefined){const _errs42: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid7: any = _errs42 === errors;}else {var valid7: any = true;}if(valid7){if(data.leaseVersion !== undefined){let data19: any = data.leaseVersion;const _errs43: any = errors;if(!(((typeof data19 == "number") && (!(data19 % 1) && !isNaN(data19))) && (isFinite(data19)))){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/2/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs43){if((typeof data19 == "number") && (isFinite(data19))){if(data19 > 9007199254740991 || isNaN(data19)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/2/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data19 < 1 || isNaN(data19)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/2/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid7: any = _errs43 === errors;}else {var valid7: any = true;}if(valid7){if(data.holderDeviceId !== undefined){const _errs45: any = errors;const _errs46: any = errors;let valid8: any = false;const _errs47: any = errors;const err2: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/2/properties/holderDeviceId/anyOf/0/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;var _valid1: any = _errs47 === errors;valid8 = valid8 || _valid1;const _errs50: any = errors;if(data.holderDeviceId !== null){const err3: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/2/properties/holderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid1: any = _errs50 === errors;valid8 = valid8 || _valid1;if(!valid8){const err4: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/2/properties/holderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validateTerminalControlChangedPayload.errors = vErrors;return false;}else {errors = _errs46;if(vErrors !== null){if(_errs46){vErrors.length = _errs46;}else {vErrors = null;}}}var valid7: any = _errs45 === errors;}else {var valid7: any = true;}if(valid7){if(data.holderRunId !== undefined){const _errs52: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/2/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid7: any = _errs52 === errors;}else {var valid7: any = true;}if(valid7){if(data.holderCommandId !== undefined){const _errs55: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/2/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid7: any = _errs55 === errors;}else {var valid7: any = true;}if(valid7){if(data.previousHolderDeviceId !== undefined){const _errs58: any = errors;if(!(validateDeviceId.call(this, data.previousHolderDeviceId, {instancePath:instancePath+"/previousHolderDeviceId",parentData:data,parentDataProperty:"previousHolderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid7: any = _errs58 === errors;}else {var valid7: any = true;}}}}}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs36 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else if(tag0 === "autoReleasedPaneClosed"){const _errs59: any = errors;if(errors === _errs59){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((((data.reason === undefined) && (missing4 = "reason")) || ((data.sessionId === undefined) && (missing4 = "sessionId"))) || ((data.terminalId === undefined) && (missing4 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing4 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing4 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing4 = "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs61: any = errors;for(const key3 in data){if(!((((((((key3 === "reason") || (key3 === "sessionId")) || (key3 === "terminalId")) || (key3 === "leaseVersion")) || (key3 === "holderDeviceId")) || (key3 === "holderRunId")) || (key3 === "holderCommandId")) || (key3 === "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs61 === errors){if(data.reason !== undefined){let data24: any = data.reason;const _errs62: any = errors;if(typeof data24 !== "string"){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedPaneClosed" !== data24){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedPaneClosed"}}];return false;}var valid10: any = _errs62 === errors;}else {var valid10: any = true;}if(valid10){if(data.sessionId !== undefined){const _errs64: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid10: any = _errs64 === errors;}else {var valid10: any = true;}if(valid10){if(data.terminalId !== undefined){const _errs65: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid10: any = _errs65 === errors;}else {var valid10: any = true;}if(valid10){if(data.leaseVersion !== undefined){let data27: any = data.leaseVersion;const _errs66: any = errors;if(!(((typeof data27 == "number") && (!(data27 % 1) && !isNaN(data27))) && (isFinite(data27)))){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/3/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs66){if((typeof data27 == "number") && (isFinite(data27))){if(data27 > 9007199254740991 || isNaN(data27)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/3/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data27 < 1 || isNaN(data27)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/3/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid10: any = _errs66 === errors;}else {var valid10: any = true;}if(valid10){if(data.holderDeviceId !== undefined){const _errs68: any = errors;const _errs69: any = errors;let valid11: any = false;const _errs70: any = errors;const err5: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/3/properties/holderDeviceId/anyOf/0/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;var _valid2: any = _errs70 === errors;valid11 = valid11 || _valid2;const _errs73: any = errors;if(data.holderDeviceId !== null){const err6: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/3/properties/holderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var _valid2: any = _errs73 === errors;valid11 = valid11 || _valid2;if(!valid11){const err7: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/3/properties/holderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validateTerminalControlChangedPayload.errors = vErrors;return false;}else {errors = _errs69;if(vErrors !== null){if(_errs69){vErrors.length = _errs69;}else {vErrors = null;}}}var valid10: any = _errs68 === errors;}else {var valid10: any = true;}if(valid10){if(data.holderRunId !== undefined){const _errs75: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/3/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid10: any = _errs75 === errors;}else {var valid10: any = true;}if(valid10){if(data.holderCommandId !== undefined){const _errs78: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/3/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid10: any = _errs78 === errors;}else {var valid10: any = true;}if(valid10){if(data.previousHolderDeviceId !== undefined){const _errs81: any = errors;if(!(validateDeviceId.call(this, data.previousHolderDeviceId, {instancePath:instancePath+"/previousHolderDeviceId",parentData:data,parentDataProperty:"previousHolderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid10: any = _errs81 === errors;}else {var valid10: any = true;}}}}}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs59 === errors;if(props0 !== true){props0 = true;}valid0 = valid9;}else if(tag0 === "autoReleasedCommandEnded"){const _errs82: any = errors;if(errors === _errs82){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((((data.reason === undefined) && (missing5 = "reason")) || ((data.sessionId === undefined) && (missing5 = "sessionId"))) || ((data.terminalId === undefined) && (missing5 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing5 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing5 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing5 = "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs84: any = errors;for(const key4 in data){if(!((((((((key4 === "reason") || (key4 === "sessionId")) || (key4 === "terminalId")) || (key4 === "leaseVersion")) || (key4 === "holderDeviceId")) || (key4 === "holderRunId")) || (key4 === "holderCommandId")) || (key4 === "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs84 === errors){if(data.reason !== undefined){let data32: any = data.reason;const _errs85: any = errors;if(typeof data32 !== "string"){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/4/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedCommandEnded" !== data32){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/4/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedCommandEnded"}}];return false;}var valid13: any = _errs85 === errors;}else {var valid13: any = true;}if(valid13){if(data.sessionId !== undefined){const _errs87: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid13: any = _errs87 === errors;}else {var valid13: any = true;}if(valid13){if(data.terminalId !== undefined){const _errs88: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid13: any = _errs88 === errors;}else {var valid13: any = true;}if(valid13){if(data.leaseVersion !== undefined){let data35: any = data.leaseVersion;const _errs89: any = errors;if(!(((typeof data35 == "number") && (!(data35 % 1) && !isNaN(data35))) && (isFinite(data35)))){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/4/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs89){if((typeof data35 == "number") && (isFinite(data35))){if(data35 > 9007199254740991 || isNaN(data35)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/4/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data35 < 1 || isNaN(data35)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/4/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid13: any = _errs89 === errors;}else {var valid13: any = true;}if(valid13){if(data.holderDeviceId !== undefined){let data36: any = data.holderDeviceId;const _errs91: any = errors;const _errs92: any = errors;let valid14: any = false;const _errs93: any = errors;if(!(validateDeviceId.call(this, data36, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var _valid3: any = _errs93 === errors;valid14 = valid14 || _valid3;const _errs94: any = errors;if(data36 !== null){const err8: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/4/properties/holderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var _valid3: any = _errs94 === errors;valid14 = valid14 || _valid3;if(!valid14){const err9: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/4/properties/holderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;validateTerminalControlChangedPayload.errors = vErrors;return false;}else {errors = _errs92;if(vErrors !== null){if(_errs92){vErrors.length = _errs92;}else {vErrors = null;}}}var valid13: any = _errs91 === errors;}else {var valid13: any = true;}if(valid13){if(data.holderRunId !== undefined){const _errs96: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/4/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid13: any = _errs96 === errors;}else {var valid13: any = true;}if(valid13){if(data.holderCommandId !== undefined){const _errs99: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/4/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid13: any = _errs99 === errors;}else {var valid13: any = true;}if(valid13){if(data.previousHolderDeviceId !== undefined){const _errs102: any = errors;if(!(validateDeviceId.call(this, data.previousHolderDeviceId, {instancePath:instancePath+"/previousHolderDeviceId",parentData:data,parentDataProperty:"previousHolderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid13: any = _errs102 === errors;}else {var valid13: any = true;}}}}}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid12: any = _errs82 === errors;if(props0 !== true){props0 = true;}valid0 = valid12;}else if(tag0 === "autoReleasedRunIdle"){const _errs103: any = errors;if(errors === _errs103){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((((data.reason === undefined) && (missing6 = "reason")) || ((data.sessionId === undefined) && (missing6 = "sessionId"))) || ((data.terminalId === undefined) && (missing6 = "terminalId"))) || ((data.leaseVersion === undefined) && (missing6 = "leaseVersion"))) || ((data.holderDeviceId === undefined) && (missing6 = "holderDeviceId"))) || ((data.previousHolderDeviceId === undefined) && (missing6 = "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs105: any = errors;for(const key5 in data){if(!((((((((key5 === "reason") || (key5 === "sessionId")) || (key5 === "terminalId")) || (key5 === "leaseVersion")) || (key5 === "holderDeviceId")) || (key5 === "holderRunId")) || (key5 === "holderCommandId")) || (key5 === "previousHolderDeviceId"))){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs105 === errors){if(data.reason !== undefined){let data40: any = data.reason;const _errs106: any = errors;if(typeof data40 !== "string"){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/5/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}if("autoReleasedRunIdle" !== data40){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/5/properties/reason/const",keyword:"const",params:{allowedValue: "autoReleasedRunIdle"}}];return false;}var valid16: any = _errs106 === errors;}else {var valid16: any = true;}if(valid16){if(data.sessionId !== undefined){const _errs108: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid16: any = _errs108 === errors;}else {var valid16: any = true;}if(valid16){if(data.terminalId !== undefined){const _errs109: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid16: any = _errs109 === errors;}else {var valid16: any = true;}if(valid16){if(data.leaseVersion !== undefined){let data43: any = data.leaseVersion;const _errs110: any = errors;if(!(((typeof data43 == "number") && (!(data43 % 1) && !isNaN(data43))) && (isFinite(data43)))){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/5/properties/leaseVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs110){if((typeof data43 == "number") && (isFinite(data43))){if(data43 > 9007199254740991 || isNaN(data43)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/5/properties/leaseVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data43 < 1 || isNaN(data43)){validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/leaseVersion",schemaPath:"#/oneOf/5/properties/leaseVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid16: any = _errs110 === errors;}else {var valid16: any = true;}if(valid16){if(data.holderDeviceId !== undefined){let data44: any = data.holderDeviceId;const _errs112: any = errors;const _errs113: any = errors;let valid17: any = false;const _errs114: any = errors;if(!(validateDeviceId.call(this, data44, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var _valid4: any = _errs114 === errors;valid17 = valid17 || _valid4;const _errs115: any = errors;if(data44 !== null){const err10: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/5/properties/holderDeviceId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}var _valid4: any = _errs115 === errors;valid17 = valid17 || _valid4;if(!valid17){const err11: any = {instancePath:instancePath+"/holderDeviceId",schemaPath:"#/oneOf/5/properties/holderDeviceId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validateTerminalControlChangedPayload.errors = vErrors;return false;}else {errors = _errs113;if(vErrors !== null){if(_errs113){vErrors.length = _errs113;}else {vErrors = null;}}}var valid16: any = _errs112 === errors;}else {var valid16: any = true;}if(valid16){if(data.holderRunId !== undefined){const _errs117: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderRunId",schemaPath:"#/oneOf/5/properties/holderRunId/not",keyword:"not",params:{}}];return false;var valid16: any = _errs117 === errors;}else {var valid16: any = true;}if(valid16){if(data.holderCommandId !== undefined){const _errs120: any = errors;validateTerminalControlChangedPayload.errors = [{instancePath:instancePath+"/holderCommandId",schemaPath:"#/oneOf/5/properties/holderCommandId/not",keyword:"not",params:{}}];return false;var valid16: any = _errs120 === errors;}else {var valid16: any = true;}if(valid16){if(data.previousHolderDeviceId !== undefined){const _errs123: any = errors;if(!(validateDeviceId.call(this, data.previousHolderDeviceId, {instancePath:instancePath+"/previousHolderDeviceId",parentData:data,parentDataProperty:"previousHolderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid16: any = _errs123 === errors;}else {var valid16: any = true;}}}}}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid15: any = _errs103 === errors;if(props0 !== true){props0 = true;}valid0 = valid15;}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "reason", tagValue: tag0}}];return false;}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "reason", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key6 in data){if(!props0 || !props0[key6]){validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key6}}];return false;break;}}}}}}}else {validateTerminalControlChangedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalControlChangedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalControlChangedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link TerminalControlHeldByOtherDetails}. */
// prettier-ignore
export const validateTerminalControlHeldByOtherDetails: CompiledSchemaCheck<TerminalControlHeldByOtherDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is TerminalControlHeldByOtherDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateTerminalControlHeldByOtherDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.terminalId === undefined) && (missing0 = "terminalId")) || ((data.holderDeviceId === undefined) && (missing0 = "holderDeviceId"))){validateTerminalControlHeldByOtherDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "terminalId") || (key0 === "holderDeviceId")) || (key0 === "holderRunId")) || (key0 === "holderCommandId"))){validateTerminalControlHeldByOtherDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.terminalId !== undefined){const _errs2: any = errors;if(!(validateTerminalId.call(this, data.terminalId, {instancePath:instancePath+"/terminalId",parentData:data,parentDataProperty:"terminalId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTerminalId.errors : vErrors.concat(validateTerminalId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderDeviceId !== undefined){const _errs3: any = errors;if(!(validateDeviceId.call(this, data.holderDeviceId, {instancePath:instancePath+"/holderDeviceId",parentData:data,parentDataProperty:"holderDeviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderRunId !== undefined){const _errs4: any = errors;if(!(validateRunId.call(this, data.holderRunId, {instancePath:instancePath+"/holderRunId",parentData:data,parentDataProperty:"holderRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.holderCommandId !== undefined){const _errs5: any = errors;if(!(validateCommandId.call(this, data.holderCommandId, {instancePath:instancePath+"/holderCommandId",parentData:data,parentDataProperty:"holderCommandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.holderRunId !== undefined && ((data.holderCommandId === undefined) && (missing1 = "holderCommandId"))){validateTerminalControlHeldByOtherDetails.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderRunId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderCommandId"}}];return false;}else {if(data.holderCommandId !== undefined && ((data.holderRunId === undefined) && (missing1 = "holderRunId"))){validateTerminalControlHeldByOtherDetails.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "holderCommandId",
    missingProperty: missing1,
    depsCount: 1,
    deps: "holderRunId"}}];return false;}}}}}}}}}else {validateTerminalControlHeldByOtherDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateTerminalControlHeldByOtherDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateTerminalControlHeldByOtherDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
