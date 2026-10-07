// A session's shells as a client addresses them: the live list, opening, closing and ordering,
// one shell's output stream, writing and resizing, flow control, and the per-shell control lease.
//
// Every request names the session and the terminal; a request whose terminal is not that session's
// is refused, so a terminal id alone never reaches another session's shell.
//
// The lease is one per shell, held by one of the user's devices or by an agent's running command on
// this machine. A run's hold carries this machine's device id, the run's id and the holding
// command's id, so a screen can tell "this device", "another device" and "a run" apart and stop
// the command. There is no release: a hold ends when another device takes the shell, the holding
// connection ends, or the holding run leaves its running state.
import { z } from "zod";

import { CommandIdSchema, type CommandId } from "./command.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc/streaming.js";
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

/** The daemon-minted id of one shell in a session. Opaque to every client. */
export type TerminalId = string & { readonly __brand: "TerminalId" };
/** Parses a {@link TerminalId}: a non-empty string up to {@link TERMINAL_ID_MAX_LEN}. */
export const TerminalIdSchema: z.ZodType<TerminalId, TerminalId> = z
  .string()
  .min(1)
  .max(TERMINAL_ID_MAX_LEN)
  .brand<"TerminalId">() as unknown as z.ZodType<TerminalId, TerminalId>;

const holderDeviceIdSchema = wireFreeFormString(DEVICE_ID_MAX_LEN, "holderDeviceId");

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
 * program's base name until it sets one. `holder` is `null` while nobody holds the shell.
 */
export interface PtyListEntry {
  terminalId: TerminalId;
  title: string;
  status: PtyShellStatus;
  holder: TerminalControlHolder | null;
}
const PtyListEntrySchema: z.ZodType<PtyListEntry> = z
  .object({
    terminalId: TerminalIdSchema,
    title: z.string().min(1),
    status: PtyShellStatusSchema,
    holder: TerminalControlHolderSchema.nullable(),
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
 * same key never opens a second shell.
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

/**
 * One frame of a shell's output stream. The first is always `scrollback`: the scrollback window
 * starting at its first whole line, the columns and rows it was last drawn at (so a running
 * program's boxes come back unwrapped), and who holds it. Then `output` in the order the shell
 * wrote it, and `exited` once its program ends.
 */
export type PtyOutputFrame =
  | {
      kind: "scrollback";
      sessionId: SessionId;
      terminalId: TerminalId;
      data: string;
      columns: number;
      rows: number;
      holder: TerminalControlHolder | null;
    }
  | { kind: "output"; sessionId: SessionId; terminalId: TerminalId; data: string }
  | { kind: "exited"; sessionId: SessionId; terminalId: TerminalId; exitCode: number };
/** Parses a {@link PtyOutputFrame}. */
export const PtyOutputFrameSchema: z.ZodType<PtyOutputFrame> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("scrollback"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      data: z.string(),
      columns: z.number().int().positive(),
      rows: z.number().int().positive(),
      holder: TerminalControlHolderSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("output"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      data: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("exited"),
      sessionId: SessionIdSchema,
      terminalId: TerminalIdSchema,
      exitCode: z.number().int(),
    })
    .strict(),
]);

/**
 * How written text arrived. A `paste` is wrapped as pasted text when the program in the shell asked
 * for that, so several lines sit at the prompt instead of running themselves.
 */
export type PtyWriteKind = "keys" | "paste";

/** Input for one shell, written as it arrives; the writer must hold the shell. */
export interface PtyWriteRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
  data: string;
  kind: PtyWriteKind;
}
/** Parses a {@link PtyWriteRequest}. */
export const PtyWriteRequestSchema: z.ZodType<PtyWriteRequest, PtyWriteRequest> = z
  .object({
    sessionId: SessionIdSchema,
    terminalId: TerminalIdSchema,
    data: z.string(),
    kind: z.enum(["keys", "paste"]),
  })
  .strict();

/** A shell's new size in character cells. Only the holding device sets it; watchers follow it. */
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
 * the shell.
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
 * Take one shell's lease for the calling device. `force` moves it off another of the user's
 * devices; a take never moves it off a run.
 */
export interface SessionTakeControlRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
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
 * connection ended, the holding run's command ended, or the holding run left its running state.
 * A run's two releases hand the shell back to the device the run took it from, while one of that
 * device's connections is open.
 */
export type PtyControlChangedReason =
  | "taken"
  | "taken_by_force"
  | "auto_released_disconnect"
  | "auto_released_command_ended"
  | "auto_released_run_idle";
/** Every {@link PtyControlChangedReason}. */
export const PTY_CONTROL_CHANGED_REASONS: readonly PtyControlChangedReason[] = Object.freeze([
  "taken",
  "taken_by_force",
  "auto_released_disconnect",
  "auto_released_command_ended",
  "auto_released_run_idle",
]);

/**
 * One change of one shell's holder. The holder members say who holds it after the change, so a take
 * names a holder, a disconnect names nobody, and a run's release names the device it hands the
 * shell back to or nobody; the device it moved off is `previousHolderDeviceId`. Clients fold these
 * and never infer a holder from a take they made.
 */
export interface PtyControlChangedPayload {
  sessionId: SessionId;
  terminalId: TerminalId;
  holderDeviceId: string | null;
  holderRunId?: RunId | undefined;
  holderCommandId?: CommandId | undefined;
  previousHolderDeviceId: string | null;
  reason: PtyControlChangedReason;
}
/**
 * Parses a {@link PtyControlChangedPayload}. A take that names no holder, a disconnect that names
 * one, or a release that names a run contradicts itself and is refused. A forced take is a
 * device's, never a run's, and always moves the shell off another device. A run's take names its
 * holding command.
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
  })
  .strict()
  .refine(runHoldNamesItsCommand, RUN_HOLD_NAMES_ITS_COMMAND)
  .refine(
    (payload) => {
      if (payload.reason === "taken" || payload.reason === "taken_by_force") {
        return payload.holderDeviceId !== null;
      }
      if (payload.reason === "auto_released_disconnect") {
        return payload.holderDeviceId === null && payload.holderRunId === undefined;
      }
      return payload.holderRunId === undefined;
    },
    {
      message:
        "a take names the holder after it, a disconnect names nobody, and a run's release " +
        "names the device it hands the shell back to or nobody",
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
/**
 * Type of {@link PTY_CONTROL_HELD_BY_OTHER_CODE}.
 *
 * @consumedBy the handler that returns the `pty.control_held_by_other` error
 */
export type PtyControlHeldByOtherCode = typeof PTY_CONTROL_HELD_BY_OTHER_CODE;
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
 * A write to a shell someone else holds, a run's write to a shell it does not hold, or a resize of
 * a shell nobody holds. A device's write to a shell nobody holds takes it instead.
 */
export const PTY_CONTROL_NOT_HELD_CODE = "pty.control_not_held" as const;
/**
 * Type of {@link PTY_CONTROL_NOT_HELD_CODE}.
 *
 * @consumedBy the handler that returns the `pty.control_not_held` error
 */
export type PtyControlNotHeldCode = typeof PTY_CONTROL_NOT_HELD_CODE;

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
/**
 * Every `pty.*` method: its name, how it answers, and its shapes.
 *
 * @consumedBy the daemon's `pty.*` handlers
 */
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
