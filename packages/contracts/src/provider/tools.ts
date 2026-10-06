// The arguments of the tools the daemon serves to the providers on its own tool route: the
// session-messaging pair under the `sessions` server, and the two that read and stop a tool call
// that moved to the background. A model calls these, not a client, so no method descriptor
// registers them; each schema checks the arguments where the call reaches the daemon.
import { z } from "zod";

import { SESSION_NAME_MAX_LEN } from "../session/methods.js";
import {
  FILE_PATH_MAX_LEN,
  wireFreeFormString,
  wireUncappedFreeFormString,
} from "../free-form-string.js";

/**
 * `session_send`: a message to another session. `to` is that session's name as `session_list`
 * prints it, never an address; `files` are paths the sending session can read, staged into the
 * receiving session as its own attachments.
 */
export interface SessionSendArguments {
  to: string;
  message: string;
  files?: string[] | undefined;
}
/**
 * Parses {@link SessionSendArguments}.
 *
 * @consumedBy the daemon's `session_send` tool, which checks its arguments where the call arrives
 */
export const SessionSendArgumentsSchema: z.ZodType<SessionSendArguments> = z
  .object({
    to: wireFreeFormString(SESSION_NAME_MAX_LEN, "session_send.to"),
    message: wireUncappedFreeFormString("session_send.message"),
    files: z.array(wireFreeFormString(FILE_PATH_MAX_LEN, "session_send.files")).optional(),
  })
  .strict();

/** `session_list` takes no arguments. */
export type SessionListArguments = Record<string, never>;
/**
 * Parses {@link SessionListArguments}: an empty object.
 *
 * @consumedBy the daemon's `session_list` tool, which checks its arguments where the call arrives
 */
export const SessionListArgumentsSchema: z.ZodType<SessionListArguments, SessionListArguments> = z
  .object({})
  .strict();

/**
 * `task_output`: the status of a tool call that moved to the background and, once it ends, its
 * result. `wait_seconds` is how long the model asks to wait; the daemon waits at most 10 s.
 */
export interface TaskOutputArguments {
  task_id: string;
  wait_seconds?: number | undefined;
}
/**
 * Parses {@link TaskOutputArguments}.
 *
 * @consumedBy the daemon's `task_output` tool, which checks its arguments where the call arrives
 */
export const TaskOutputArgumentsSchema: z.ZodType<TaskOutputArguments> = z
  .object({
    task_id: wireUncappedFreeFormString("task_output.task_id"),
    wait_seconds: z.number().nonnegative().optional(),
  })
  .strict();

/** `task_stop`: cancels a tool call that moved to the background. */
export interface TaskStopArguments {
  task_id: string;
}
/**
 * Parses {@link TaskStopArguments}.
 *
 * @consumedBy the daemon's `task_stop` tool, which checks its arguments where the call arrives
 */
export const TaskStopArgumentsSchema: z.ZodType<TaskStopArguments> = z
  .object({ task_id: wireUncappedFreeFormString("task_stop.task_id") })
  .strict();
