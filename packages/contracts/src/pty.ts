// A session's shells as a client addresses them: the live list, opening, closing and ordering,
// one shell's output stream, writing and resizing, flow control, and the per-shell control lease.
//
// Every request names the session and the terminal, and a take or a write names the pane's output
// subscription it comes through. A request naming a shell its session does not have is refused
// `pty.not_found`, so a terminal id alone never reaches another session's shell. The flow-control
// signal is the one exception: naming such a shell changes nothing, since it may race a closing
// shell. A take or write whose subscription is not the calling connection's open subscription to
// that shell is refused `pty.output_subscription_not_found`, so a hold is never bound to another
// connection's pane.
//
// The lease is one per shell, held by one of the user's devices or by an agent's running command on
// this machine. A run's hold carries this machine's device id, the run's id and the holding
// command's id, so a screen can tell "this device", "another device" and "a run" apart and stop
// the command. There is no release: a device's hold is bound to each connection and pane output
// subscription it was taken or written through, either one ending ends that binding, and the hold
// ends with its last or when another device takes the shell; a run's hold ends when its command
// ends or the run leaves its running state. Every change of holder raises the shell's lease version
// by one, so a client keeps whichever reading of the holder is newest.
import { z } from "zod";

import { CommandIdSchema, type CommandId } from "./command.js";
import {
  StreamFrameSchema,
  SubscribeAckResponseSchema,
  SubscriptionIdSchema,
  type StreamFrame,
  type SubscribeAckResponse,
  type SubscriptionId,
} from "./jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { DEVICE_ID_MAX_LEN } from "./trust-statement.js";
import { RunIdSchema, type RunId } from "./run/id.js";
import { wireFreeFormString } from "./free-form-string.js";
import { SessionIdSchema, type SessionId } from "./session/id.js";

/** The longest terminal id the daemon accepts. */
export const TERMINAL_ID_MAX_LEN = 256;

/**
 * The most UTF-16 code units a shell's title carries on the wire. The daemon cuts a longer title
 * the shell sets to this, on a grapheme boundary.
 */
export const SHELL_TITLE_MAX_LEN = 256;

/** The daemon-minted id of one shell in a session. Opaque to every client. */
export type TerminalId = string & { readonly __brand: "TerminalId" };
/** Parses a {@link TerminalId}: a non-empty string up to {@link TERMINAL_ID_MAX_LEN}. */
export const TerminalIdSchema: z.ZodType<TerminalId, TerminalId> = z
  .string()
  .min(1)
  .max(TERMINAL_ID_MAX_LEN)
  .brand<"TerminalId">() as unknown as z.ZodType<TerminalId, TerminalId>;

const holderDeviceIdSchema = wireFreeFormString(DEVICE_ID_MAX_LEN, "holderDeviceId");

// How many times a shell's holder has changed; a shell opens at 0.
const leaseVersionSchema = z.number().int().nonnegative();

/**
 * Who holds one shell's control lease. `holderDeviceId` is the holding device (this machine's own
 * while a run holds it), `holderRunId` names the run, whose agent the screen reads from the run,
 * and `holderCommandId` names the command, which is what stopping the hold stops.
 */
export interface TerminalControlHolder {
  holderDeviceId: string;
  holderRunId?: RunId | undefined;
  holderCommandId?: CommandId | undefined;
}

// A run holds a shell only through one of its running commands, so a hold names both or neither: a
// run without its command leaves nothing to stop, and a command without its run names no agent.
const runHoldNamesItsCommand = (holder: {
  holderRunId?: RunId | undefined;
  holderCommandId?: CommandId | undefined;
}): boolean => (holder.holderRunId === undefined) === (holder.holderCommandId === undefined);
const RUN_HOLD_NAMES_ITS_COMMAND = {
  message: "a run's hold names the run and its holding command together",
  path: ["holderCommandId"],
};

/** Parses a {@link TerminalControlHolder}; a run's hold names its command. */
export const TerminalControlHolderSchema: z.ZodType<TerminalControlHolder> = z
  .object({
    holderDeviceId: holderDeviceIdSchema,
    holderRunId: RunIdSchema.optional(),
    holderCommandId: CommandIdSchema.optional(),
  })
  .strict()
  .refine(runHoldNamesItsCommand, RUN_HOLD_NAMES_ITS_COMMAND);

/** The session whose shells a `pty.list` subscription follows. */
export interface PtyListRequest {
  sessionId: SessionId;
}
/** Parses a {@link PtyListRequest}. */
export const PtyListRequestSchema: z.ZodType<PtyListRequest, PtyListRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/**
 * Where one shell's process stands. A shell that ends keeps its entry with its exit code until it
 * is closed; a shell that could not start keeps its entry with the daemon's words for why, and
 * takes no input.
 */
export type PtyShellStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number }
  | { state: "did_not_start"; cause: string };
const PtyShellStatusSchema: z.ZodType<PtyShellStatus> = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running") }).strict(),
  z.object({ state: z.literal("exited"), exitCode: z.number().int() }).strict(),
  z.object({ state: z.literal("did_not_start"), cause: z.string().min(1) }).strict(),
]);

/**
 * One shell as the tab strip draws it. `title` is the title the shell set for itself, or its
 * program's base name until it sets one, at most {@link SHELL_TITLE_MAX_LEN} long. `holder` is
 * `null` while nobody holds the shell, and `leaseVersion` is the lease version that holder was read
 * at.
 */
export interface PtyListEntry {
  terminalId: TerminalId;
  title: string;
  status: PtyShellStatus;
  holder: TerminalControlHolder | null;
  leaseVersion: number;
}
const PtyListEntrySchema: z.ZodType<PtyListEntry> = z
  .object({
    terminalId: TerminalIdSchema,
    title: z.string().min(1).max(SHELL_TITLE_MAX_LEN),
    status: PtyShellStatusSchema,
    holder: TerminalControlHolderSchema.nullable(),
    leaseVersion: leaseVersionSchema,
  })
  .strict();

/**
 * The session's whole set of shells, sent on every change, in tab order. The order is the
 * daemon's, so every device draws the same strip. A shell gone before the list was first read is
 * not in it.
 */
export interface PtyListUpdate {
  sessionId: SessionId;
  terminals: PtyListEntry[];
}
/** Parses a {@link PtyListUpdate}; a terminal appears at most once. */
export const PtyListUpdateSchema: z.ZodType<PtyListUpdate> = z
  .object({ sessionId: SessionIdSchema, terminals: z.array(PtyListEntrySchema) })
  .strict()
  .refine(
    (update) =>
      new Set(update.terminals.map((entry) => entry.terminalId)).size === update.terminals.length,
    { message: "a terminal appears at most once in the list", path: ["terminals"] },
  );

/**
 * Open another shell for the session: the person's own login shell in the session's tree, so the
 * request carries no program, arguments or folder. The caller mints the key, and a retry with the
 * same key never opens a second shell. A chat session has no shell, so it is refused
 * `pty.chat_unsupported`.
 */
export interface PtyOpenRequest {
  sessionId: SessionId;
  clientIdempotencyKey: string;
}
/** Parses a {@link PtyOpenRequest}. */
export const PtyOpenRequestSchema: z.ZodType<PtyOpenRequest, PtyOpenRequest> = z
  .object({ sessionId: SessionIdSchema, clientIdempotencyKey: z.uuid() })
  .strict();

/**
 * The new shell's id. A shell that fails to start still has one: its tab stays and its list entry
 * reads `did_not_start` with the cause.
 */
export interface PtyOpenResponse {
  terminalId: TerminalId;
}
/** Parses a {@link PtyOpenResponse}. */
export const PtyOpenResponseSchema: z.ZodType<PtyOpenResponse> = z
  .object({ terminalId: TerminalIdSchema })
  .strict();

/**
 * Close one shell and end its process; closing several sends this once per shell. The daemon
 * refuses it while a run holds the shell, and while another device holds it unless `force` is
 * true, which the screen sends only after the person confirmed.
 */
export interface PtyCloseRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
  force?: boolean | undefined;
}
/** Parses a {@link PtyCloseRequest}. */
export const PtyCloseRequestSchema: z.ZodType<PtyCloseRequest, PtyCloseRequest> = z
  .object({
    sessionId: SessionIdSchema,
    terminalId: TerminalIdSchema,
    force: z.boolean().optional(),
  })
  .strict();

/** The session's shells in their new tab order, every one of them once. */
export interface PtyReorderRequest {
  sessionId: SessionId;
  terminalIds: TerminalId[];
}
/** Parses a {@link PtyReorderRequest}; the order names each shell at most once. */
export const PtyReorderRequestSchema: z.ZodType<PtyReorderRequest, PtyReorderRequest> = z
  .object({ sessionId: SessionIdSchema, terminalIds: z.array(TerminalIdSchema).min(1) })
  .strict()
  .refine((request) => new Set(request.terminalIds).size === request.terminalIds.length, {
    message: "a terminal appears at most once in the order",
    path: ["terminalIds"],
  });

/** The shell whose output a `pty.outputSubscribe` subscription streams. */
export interface PtyOutputSubscribeRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
}
/** Parses a {@link PtyOutputSubscribeRequest}. */
export const PtyOutputSubscribeRequestSchema: z.ZodType<
  PtyOutputSubscribeRequest,
  PtyOutputSubscribeRequest
> = z.object({ sessionId: SessionIdSchema, terminalId: TerminalIdSchema }).strict();

// How many bytes of a shell's output, its marks taken out, came before a point in its stream.
const outputOffsetSchema = z.number().int().nonnegative();

/**
 * One change on a shell's output stream; `cursor` is the shell's output offset once the change is
 * applied, in bytes since the shell started. `scrollback` opens the scrollback window, starting at
 * its first whole line, with the columns and rows it was last drawn at (so a running program's
 * boxes come back unwrapped) and who holds it at which lease version; a window too large for one
 * message goes on in `scrollback_continuation` changes, each in a frame of its own, before any
 * output. `output` is what the shell wrote next, in order; `exited` is its program's end.
 */
export type PtyOutputChange =
  | {
      kind: "scrollback";
      sessionId: SessionId;
      terminalId: TerminalId;
      data: string;
      columns: number;
      rows: number;
      holder: TerminalControlHolder | null;
      leaseVersion: number;
      cursor: number;
    }
  | {
      kind: "scrollback_continuation";
      sessionId: SessionId;
      terminalId: TerminalId;
      data: string;
      cursor: number;
    }
  | { kind: "output"; sessionId: SessionId; terminalId: TerminalId; data: string; cursor: number }
  | {
      kind: "exited";
      sessionId: SessionId;
      terminalId: TerminalId;
      exitCode: number;
      cursor: number;
    };
const PtyOutputChangeSchema: z.ZodType<PtyOutputChange> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("scrollback"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      data: z.string(),
      columns: z.number().int().positive(),
      rows: z.number().int().positive(),
      holder: TerminalControlHolderSchema.nullable(),
      leaseVersion: leaseVersionSchema,
      cursor: outputOffsetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scrollback_continuation"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      data: z.string(),
      cursor: outputOffsetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("output"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      data: z.string(),
      cursor: outputOffsetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("exited"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      exitCode: z.number().int(),
      cursor: outputOffsetSchema,
    })
    .strict(),
]);

/**
 * One notify of a shell's output stream. The first frame opens with the `scrollback` change, and
 * the frames that continue the window follow it. A watcher that fell behind stops receiving
 * output, and once it has caught up its next frame carries the drop mark and a fresh `scrollback`
 * change, so it redraws from the scrollback window and no byte reaches it twice; one still behind
 * when the shell exits gets the drop mark, a fresh `scrollback` change and the `exited` change.
 * A cursor counts only the bytes sent: a character the output ends inside is held back for the
 * output that completes it.
 */
export type PtyOutputFrame = StreamFrame<PtyOutputChange, number>;
/** Parses a {@link PtyOutputFrame}. */
export const PtyOutputFrameSchema: z.ZodType<PtyOutputFrame> = StreamFrameSchema(
  PtyOutputChangeSchema,
  outputOffsetSchema,
);

// The shell and the writing pane every write names, and the text it carries.
const ptyWriteShape = {
  sessionId: SessionIdSchema,
  terminalId: TerminalIdSchema,
  outputSubscriptionId: SubscriptionIdSchema,
  data: z.string(),
};

/**
 * Input for one shell, written as it arrives; the writer's connection must hold the shell. The
 * write is bound to `outputSubscriptionId`, the writing pane's own `pty.outputSubscribe`
 * subscription to that shell: a first write to a shell nobody holds takes it through that
 * subscription, and a holding connection's write binds it to the hold. `keys` is typed text. A
 * `paste` is pasted text sent in one or more parts, each under the wire's message cap, all naming
 * the client-minted `pasteId` and the last one `isLastPart`; when the program in the shell asked
 * for pasted text to be marked as pasted, the daemon marks the whole paste once around all its
 * parts, so several lines sit at the prompt instead of running themselves. Each pane has one
 * paste open at a time: a part naming a new `pasteId` closes the pane's earlier paste first. The
 * daemon answers a write once its bytes reach the shell's terminal, so a client that sends a
 * paste's next part after the answer to the last pastes no faster than the program reads.
 */
export type PtyWriteRequest =
  | {
      sessionId: SessionId;
      terminalId: TerminalId;
      outputSubscriptionId: SubscriptionId;
      data: string;
      kind: "keys";
    }
  | {
      sessionId: SessionId;
      terminalId: TerminalId;
      outputSubscriptionId: SubscriptionId;
      data: string;
      kind: "paste";
      pasteId: string;
      isLastPart: boolean;
    };
/** Parses a {@link PtyWriteRequest}. */
export const PtyWriteRequestSchema: z.ZodType<PtyWriteRequest, PtyWriteRequest> =
  z.discriminatedUnion("kind", [
    z.object({ ...ptyWriteShape, kind: z.literal("keys") }).strict(),
    z
      .object({
        ...ptyWriteShape,
        kind: z.literal("paste"),
        pasteId: z.uuid(),
        isLastPart: z.boolean(),
      })
      .strict(),
  ]);

/** A shell's new size in character cells. Only a connection holding it sets it; watchers follow. */
export interface PtyResizeRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
  columns: number;
  rows: number;
}
/** Parses a {@link PtyResizeRequest}; both dimensions are positive whole cells. */
export const PtyResizeRequestSchema: z.ZodType<PtyResizeRequest, PtyResizeRequest> = z
  .object({
    sessionId: SessionIdSchema,
    terminalId: TerminalIdSchema,
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();

/** The answer to a shell act that reads nothing back. */
export type PtyActResponse = null;
const PtyActResponseSchema: z.ZodType<PtyActResponse> = z.null();

/**
 * The state this connection declares for one shell: `paused` while it is behind, false once it has
 * caught up. The daemon stops reading the shell only while every live watcher is behind, and a
 * connection's state clears when it disconnects. Not gated by the lease: it moves no bytes toward
 * the shell. A call naming a shell its session does not have changes nothing and is not refused.
 */
export interface SessionSetTerminalFlowControlRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
  paused: boolean;
}
/** Parses a {@link SessionSetTerminalFlowControlRequest}. */
export const SessionSetTerminalFlowControlRequestSchema: z.ZodType<
  SessionSetTerminalFlowControlRequest,
  SessionSetTerminalFlowControlRequest
> = z
  .object({ sessionId: SessionIdSchema, terminalId: TerminalIdSchema, paused: z.boolean() })
  .strict();

/** The declared state was taken; nothing is read back. */
export interface SessionSetTerminalFlowControlResponse {
  accepted: true;
}
/** Parses a {@link SessionSetTerminalFlowControlResponse}. */
export const SessionSetTerminalFlowControlResponseSchema: z.ZodType<SessionSetTerminalFlowControlResponse> =
  z.object({ accepted: z.literal(true) }).strict();

/**
 * Take one shell's lease for the calling connection, bound to `outputSubscriptionId`, the taking
 * pane's own `pty.outputSubscribe` subscription to that shell, whose end gives the hold back.
 * `force` moves it off another of the user's devices; a take never moves it off a run.
 */
export interface SessionTakeControlRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
  outputSubscriptionId: SubscriptionId;
  force?: boolean | undefined;
}
/** Parses a {@link SessionTakeControlRequest}. */
export const SessionTakeControlRequestSchema: z.ZodType<
  SessionTakeControlRequest,
  SessionTakeControlRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    terminalId: TerminalIdSchema,
    outputSubscriptionId: SubscriptionIdSchema,
    force: z.boolean().optional(),
  })
  .strict();

/** The shell and the calling device, which now holds it. */
export interface SessionTakeControlResponse {
  terminalId: TerminalId;
  holderDeviceId: string;
}
/** Parses a {@link SessionTakeControlResponse}. */
export const SessionTakeControlResponseSchema: z.ZodType<SessionTakeControlResponse> = z
  .object({ terminalId: TerminalIdSchema, holderDeviceId: holderDeviceIdSchema })
  .strict();

/** The event every change of one shell's holder is broadcast on. */
export const PTY_CONTROL_CHANGED_EVENT = "pty.control_changed" as const;

/**
 * Why a shell's holder changed: it was taken, taken by force off another device, the holding
 * connection ended, the pane's output subscription it was taken through closed, the holding run's
 * command ended, or the holding run left its running state. A run's two releases hand the shell
 * back to the device the run took it from, while one of that device's bindings is open.
 */
export type PtyControlChangedReason =
  | "taken"
  | "taken_by_force"
  | "auto_released_disconnect"
  | "auto_released_pane_closed"
  | "auto_released_command_ended"
  | "auto_released_run_idle";
/** Every {@link PtyControlChangedReason}. */
export const PTY_CONTROL_CHANGED_REASONS: readonly PtyControlChangedReason[] = Object.freeze([
  "taken",
  "taken_by_force",
  "auto_released_disconnect",
  "auto_released_pane_closed",
  "auto_released_command_ended",
  "auto_released_run_idle",
]);

/**
 * One change of one shell's holder: the holder members name who holds it after the change,
 * `previousHolderDeviceId` who held it before, and `leaseVersion` the change's lease version. A
 * take names a holder, every release names the holder it ended, a disconnect or a closed pane names
 * nobody after it, and a run's release names the device it hands the shell back to or nobody.
 * Clients keep the newest version they have read and never infer a holder from a take they made.
 */
export interface PtyControlChangedPayload {
  sessionId: SessionId;
  terminalId: TerminalId;
  holderDeviceId: string | null;
  holderRunId?: RunId | undefined;
  holderCommandId?: CommandId | undefined;
  previousHolderDeviceId: string | null;
  reason: PtyControlChangedReason;
  leaseVersion: number;
}
/**
 * Parses a {@link PtyControlChangedPayload}, refusing one that contradicts itself: a take that
 * names no holder, a release that names no holder it ended, a disconnect or a closed pane that
 * names a holder after it, a release that names a run, a forced take by a run or off no other
 * device, or a run's hold named apart from its holding command.
 */
export const PtyControlChangedPayloadSchema: z.ZodType<PtyControlChangedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    terminalId: TerminalIdSchema,
    holderDeviceId: holderDeviceIdSchema.nullable(),
    holderRunId: RunIdSchema.optional(),
    holderCommandId: CommandIdSchema.optional(),
    previousHolderDeviceId: holderDeviceIdSchema.nullable(),
    reason: z.enum(PTY_CONTROL_CHANGED_REASONS),
    leaseVersion: leaseVersionSchema.min(1),
  })
  .strict()
  .refine(runHoldNamesItsCommand, RUN_HOLD_NAMES_ITS_COMMAND)
  .refine(
    (payload) => {
      if (payload.reason === "taken" || payload.reason === "taken_by_force") {
        return payload.holderDeviceId !== null;
      }
      if (payload.previousHolderDeviceId === null) {
        return false;
      }
      if (
        payload.reason === "auto_released_disconnect" ||
        payload.reason === "auto_released_pane_closed"
      ) {
        return payload.holderDeviceId === null && payload.holderRunId === undefined;
      }
      return payload.holderRunId === undefined;
    },
    {
      message:
        "a take names the holder after it; a release names the holder it ended, and after it " +
        "nobody for a disconnect or a closed pane, or the device a run's release hands the shell " +
        "back to, or nobody",
      path: ["holderDeviceId"],
    },
  )
  .refine(
    (payload) =>
      payload.reason !== "taken_by_force" ||
      (payload.previousHolderDeviceId !== null && payload.holderRunId === undefined),
    {
      message: "a forced take moves the shell off another device to this one",
      path: ["previousHolderDeviceId"],
    },
  );

/**
 * A take, a close or a resize refused because someone else holds the shell. The details name the
 * holder, so the screen can tell a run's hold, which ends with its command and which no take
 * moves, from another device's, which a forced take or close moves.
 */
export const PTY_CONTROL_HELD_BY_OTHER_CODE = "pty.control_held_by_other" as const;
/** Details of a `pty.control_held_by_other` refusal: the shell and who holds it. */
export interface PtyControlHeldByOtherDetails extends TerminalControlHolder {
  terminalId: TerminalId;
}
/** Parses a {@link PtyControlHeldByOtherDetails}; a run's hold names its command. */
export const PtyControlHeldByOtherDetailsSchema: z.ZodType<PtyControlHeldByOtherDetails> = z
  .object({
    terminalId: TerminalIdSchema,
    holderDeviceId: holderDeviceIdSchema,
    holderRunId: RunIdSchema.optional(),
    holderCommandId: CommandIdSchema.optional(),
  })
  .strict()
  .refine(runHoldNamesItsCommand, RUN_HOLD_NAMES_ITS_COMMAND);

/**
 * A write from a writer that does not hold the shell, or a resize from a connection that does not
 * while nobody else holds it or its own device holds it on another connection. A device's write to
 * a shell nobody holds takes it instead.
 */
export const PTY_CONTROL_NOT_HELD_CODE = "pty.control_not_held" as const;

/**
 * A request naming a shell its session does not have: no such shell, or another session's, which
 * the refusal never tells apart.
 */
export const PTY_NOT_FOUND_CODE = "pty.not_found" as const;

/**
 * A take or a write naming an output subscription that is not the calling connection's own open
 * subscription to that shell: no such subscription, another connection's, or one to another
 * shell, which the refusal never tells apart, so a hold is never bound to another pane.
 */
export const PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE = "pty.output_subscription_not_found" as const;

/**
 * `pty.open` on a chat session, which is bound to a managed workspace and no repository and has no
 * shell. The screen never offers it there, so only a caller fault reaches this refusal.
 */
export const PTY_CHAT_UNSUPPORTED_CODE = "pty.chat_unsupported" as const;

/** The `pty.*` methods, keyed by name. */
export interface PtyMethodDescriptors {
  readonly "pty.list": SubscriptionMethodDescriptor<
    "pty.list",
    PtyListRequest,
    SubscribeAckResponse,
    PtyListUpdate
  >;
  readonly "pty.open": MethodDescriptor<"pty.open", PtyOpenRequest, PtyOpenResponse>;
  readonly "pty.close": MethodDescriptor<"pty.close", PtyCloseRequest, PtyActResponse>;
  readonly "pty.reorder": MethodDescriptor<"pty.reorder", PtyReorderRequest, PtyActResponse>;
  readonly "pty.outputSubscribe": SubscriptionMethodDescriptor<
    "pty.outputSubscribe",
    PtyOutputSubscribeRequest,
    SubscribeAckResponse,
    PtyOutputFrame
  >;
  readonly "pty.write": MethodDescriptor<"pty.write", PtyWriteRequest, PtyActResponse>;
  readonly "pty.resize": MethodDescriptor<"pty.resize", PtyResizeRequest, PtyActResponse>;
}
/** Every `pty.*` method: its name, how it answers, and its shapes. */
export const PTY_METHOD_DESCRIPTORS: PtyMethodDescriptors = defineMethodDescriptors({
  "pty.list": {
    method: "pty.list",
    procedureType: "subscription",
    mutating: false,
    requestSchema: PtyListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: PtyListUpdateSchema,
  },
  "pty.open": {
    method: "pty.open",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PtyOpenRequestSchema,
    responseSchema: PtyOpenResponseSchema,
  },
  "pty.close": {
    method: "pty.close",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PtyCloseRequestSchema,
    responseSchema: PtyActResponseSchema,
  },
  "pty.reorder": {
    method: "pty.reorder",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PtyReorderRequestSchema,
    responseSchema: PtyActResponseSchema,
  },
  "pty.outputSubscribe": {
    method: "pty.outputSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: PtyOutputSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: PtyOutputFrameSchema,
  },
  "pty.write": {
    method: "pty.write",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PtyWriteRequestSchema,
    responseSchema: PtyActResponseSchema,
  },
  "pty.resize": {
    method: "pty.resize",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PtyResizeRequestSchema,
    responseSchema: PtyActResponseSchema,
  },
});

/** The two `session.*` methods that act on one shell: the lease take and flow control. */
export interface TerminalControlMethodDescriptors {
  readonly "session.takeControl": MethodDescriptor<
    "session.takeControl",
    SessionTakeControlRequest,
    SessionTakeControlResponse
  >;
  readonly "session.setTerminalFlowControl": MethodDescriptor<
    "session.setTerminalFlowControl",
    SessionSetTerminalFlowControlRequest,
    SessionSetTerminalFlowControlResponse
  >;
}
/** The lease take and flow control methods: their names, how each answers, and their shapes. */
export const TERMINAL_CONTROL_METHOD_DESCRIPTORS: TerminalControlMethodDescriptors =
  defineMethodDescriptors({
    "session.takeControl": {
      method: "session.takeControl",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionTakeControlRequestSchema,
      responseSchema: SessionTakeControlResponseSchema,
    },
    "session.setTerminalFlowControl": {
      method: "session.setTerminalFlowControl",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionSetTerminalFlowControlRequestSchema,
      responseSchema: SessionSetTerminalFlowControlResponseSchema,
    },
  });
