// The shell commands an agent started: one live list, and the acts stop, background, write
// and end input. The provider decides how a command runs.
//
// Every list frame carries the whole running set, because a subscriber composing deltas
// could hold a command the provider has already dropped. Output arrives on the same
// subscription as it prints and is never stored; the stored `command.ended` event settles a
// row after a reload.
//
// This file imports nothing from `event/session.ts`, which imports the event payload from
// here.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { RunIdSchema, type RunId } from "./run/id.js";
import { SessionIdSchema, type SessionId } from "./session/id.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

/** The longest command id the daemon accepts. */
export const COMMAND_ID_MAX_LEN = 256;

/** The daemon's id for one running command. Opaque to every client. */
export type CommandId = string & { readonly __brand: "CommandId" };
/** Parses a {@link CommandId}: a non-empty string up to {@link COMMAND_ID_MAX_LEN}. */
export const CommandIdSchema: z.ZodType<CommandId, CommandId> = z
  .string()
  .min(1)
  .max(COMMAND_ID_MAX_LEN)
  .brand<"CommandId">() as unknown as z.ZodType<CommandId, CommandId>;

// command.list — the running set, and each command's output as it prints

/**
 * One running command. `name` is the command as the agent ran it. `waitingInForeground` is
 * true only while the provider holds the agent's turn on this command, the one state
 * `command.background` applies to; `waitingForInput` is true while it is blocked reading input.
 */
export interface RunningCommand {
  commandId: CommandId;
  runId: RunId;
  name: string;
  startedAt: string;
  waitingInForeground: boolean;
  waitingForInput: boolean;
}
const RunningCommandSchema: z.ZodType<RunningCommand> = z
  .object({
    commandId: CommandIdSchema,
    runId: RunIdSchema,
    name: z.string().min(1),
    startedAt: isoDateTimeSchema,
    waitingInForeground: z.boolean(),
    waitingForInput: z.boolean(),
  })
  .strict();

/** The session whose running commands a `command.list` subscription follows. */
export interface CommandListSubscribeRequest {
  sessionId: SessionId;
}
/** Parses a {@link CommandListSubscribeRequest}. */
export const CommandListSubscribeRequestSchema: z.ZodType<
  CommandListSubscribeRequest,
  CommandListSubscribeRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One frame of the running-commands subscription: the whole set in start order
 * (`commands`; an empty set takes the list away), or a piece of one command's
 * output as it printed (`output`).
 */
export type CommandListFrame =
  | { kind: "commands"; sessionId: SessionId; commands: RunningCommand[] }
  | { kind: "output"; sessionId: SessionId; commandId: CommandId; data: string };
/** Parses a {@link CommandListFrame}; a command appears at most once in a set. */
export const CommandListFrameSchema: z.ZodType<CommandListFrame> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("commands"),
      sessionId: SessionIdSchema,
      commands: z.array(RunningCommandSchema),
    })
    .strict()
    .refine(
      (frame) =>
        new Set(frame.commands.map((command) => command.commandId)).size === frame.commands.length,
      { message: "a command appears at most once in the set", path: ["commands"] },
    ),
  z
    .object({
      kind: z.literal("output"),
      sessionId: SessionIdSchema,
      commandId: CommandIdSchema,
      data: z.string(),
    })
    .strict(),
]);

// command.stop, command.background, command.write

/**
 * Stop one running command. The agent receives one short message naming it, never
 * a bare failure. `Stop all commands` sends this once per running command.
 */
export interface CommandStopRequest {
  sessionId: SessionId;
  commandId: CommandId;
}
/** Parses a {@link CommandStopRequest}. */
export const CommandStopRequestSchema: z.ZodType<CommandStopRequest, CommandStopRequest> = z
  .object({ sessionId: SessionIdSchema, commandId: CommandIdSchema })
  .strict();

/** The command was stopped. */
export interface CommandStopResponse {
  commandId: CommandId;
  stopped: true;
}
/** Parses a {@link CommandStopResponse}. */
export const CommandStopResponseSchema: z.ZodType<CommandStopResponse> = z
  .object({ commandId: CommandIdSchema, stopped: z.literal(true) })
  .strict();

/**
 * Move a command the agent is waiting on to the background: the agent's turn
 * continues and the command's output starts streaming into its row. Only one
 * provider has this act; on the other the control does not exist.
 */
export interface CommandBackgroundRequest {
  sessionId: SessionId;
  commandId: CommandId;
}
/** Parses a {@link CommandBackgroundRequest}. */
export const CommandBackgroundRequestSchema: z.ZodType<
  CommandBackgroundRequest,
  CommandBackgroundRequest
> = z.object({ sessionId: SessionIdSchema, commandId: CommandIdSchema }).strict();

/** The command no longer holds the agent's turn. */
export interface CommandBackgroundResponse {
  commandId: CommandId;
  waitingInForeground: false;
}
/** Parses a {@link CommandBackgroundResponse}. */
export const CommandBackgroundResponseSchema: z.ZodType<CommandBackgroundResponse> = z
  .object({ commandId: CommandIdSchema, waitingInForeground: z.literal(false) })
  .strict();

/**
 * Typed input for a command that is waiting on its input, `End input`, or both:
 * `text` is sent to the command, and `endOfInput` then ends its input, as end of
 * file does on a terminal.
 */
export interface CommandWriteRequest {
  sessionId: SessionId;
  commandId: CommandId;
  text?: string | undefined;
  endOfInput?: boolean | undefined;
}
/** Parses a {@link CommandWriteRequest}; it carries text, the end of input, or both. */
export const CommandWriteRequestSchema: z.ZodType<CommandWriteRequest, CommandWriteRequest> = z
  .object({
    sessionId: SessionIdSchema,
    commandId: CommandIdSchema,
    text: z.string().min(1).optional(),
    endOfInput: z.boolean().optional(),
  })
  .strict()
  .refine((request) => request.text !== undefined || request.endOfInput === true, {
    message: "a write carries text, the end of input, or both",
    path: ["text"],
  });

/** The answer to `command.write`, which reads nothing back. */
export type CommandWriteResponse = null;
const CommandWriteResponseSchema: z.ZodType<CommandWriteResponse> = z.null();

// command.ended — the stored ending of one command

/**
 * The event a command's ending is stored as.
 *
 * @consumedBy the daemon's command runner, which stores a command's ending
 */
export const COMMAND_ENDED_EVENT = "command.ended" as const;

/** How a command ended: it finished, it failed, or the person stopped it. */
export type CommandEnding = "finished" | "failed" | "ended_by_person";

/**
 * One command's ending. `exitCode` is the process's own when it has one;
 * `durationMs` is how long it ran, so the row reads its duration after a reload.
 */
export interface CommandEndedPayload {
  sessionId: SessionId;
  runId: RunId;
  commandId: CommandId;
  ending: CommandEnding;
  exitCode?: number | undefined;
  durationMs: number;
}
/** Parses a {@link CommandEndedPayload}. */
export const CommandEndedPayloadSchema: z.ZodType<CommandEndedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    commandId: CommandIdSchema,
    ending: z.enum(["finished", "failed", "ended_by_person"]),
    exitCode: z.number().int().optional(),
    durationMs: countSchema,
  })
  .strict();

// Method descriptors

/** The `command.*` methods, keyed by name. */
export interface CommandMethodDescriptors {
  readonly "command.list": SubscriptionMethodDescriptor<
    "command.list",
    CommandListSubscribeRequest,
    SubscribeAckResponse,
    CommandListFrame
  >;
  readonly "command.stop": MethodDescriptor<
    "command.stop",
    CommandStopRequest,
    CommandStopResponse
  >;
  readonly "command.background": MethodDescriptor<
    "command.background",
    CommandBackgroundRequest,
    CommandBackgroundResponse
  >;
  readonly "command.write": MethodDescriptor<
    "command.write",
    CommandWriteRequest,
    CommandWriteResponse
  >;
}

/**
 * The `command.*` methods' names, procedure types and shapes.
 *
 * @consumedBy the daemon's `command.*` handlers
 */
export const COMMAND_METHOD_DESCRIPTORS: CommandMethodDescriptors = defineMethodDescriptors({
  "command.list": {
    method: "command.list",
    procedureType: "subscription",
    mutating: false,
    requestSchema: CommandListSubscribeRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: CommandListFrameSchema,
  },
  "command.stop": {
    method: "command.stop",
    procedureType: "mutation",
    mutating: true,
    requestSchema: CommandStopRequestSchema,
    responseSchema: CommandStopResponseSchema,
  },
  "command.background": {
    method: "command.background",
    procedureType: "mutation",
    mutating: true,
    requestSchema: CommandBackgroundRequestSchema,
    responseSchema: CommandBackgroundResponseSchema,
  },
  "command.write": {
    method: "command.write",
    procedureType: "mutation",
    mutating: true,
    requestSchema: CommandWriteRequestSchema,
    responseSchema: CommandWriteResponseSchema,
  },
});
