// A session's shells as a client addresses them: the terminal id, and the
// requests that stream a shell's output, write to it and resize it.
//
// Every request names the session and the terminal. A terminal belongs to one
// session, and a request whose terminal is not that session's is refused, so a
// terminal id alone never reaches another session's shell.
import { z } from "zod";

import { SessionIdSchema, type SessionId } from "./session.js";

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

/** One piece of a shell's output, in the order the shell wrote it. */
export interface PtyOutputChunk {
  sessionId: SessionId;
  terminalId: TerminalId;
  data: string;
}

/** Input for one shell, written as it arrives. */
export interface PtyWriteRequest {
  sessionId: SessionId;
  terminalId: TerminalId;
  data: string;
}
/** Parses a {@link PtyWriteRequest}. */
export const PtyWriteRequestSchema: z.ZodType<PtyWriteRequest, PtyWriteRequest> = z
  .object({ sessionId: SessionIdSchema, terminalId: TerminalIdSchema, data: z.string() })
  .strict();

/** A shell's new size, in character cells. */
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
