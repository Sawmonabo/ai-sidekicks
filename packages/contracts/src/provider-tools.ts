// The arguments of the tools the daemon serves to the providers on its own tool route: the
// session-messaging pair under the `sessions` server, and the two that read and stop a tool call
// that moved to the background. A model calls these, not a client, so no method descriptor
// registers them; each schema checks the arguments where the call reaches the daemon.
import { z } from "zod";

import {
  FILE_PATH_MAX_LEN,
  SESSION_NAME_MAX_LEN,
  wireFreeFormString,
  wireUncappedFreeFormString,
} from "./session.js";

/**
 * `SendToSession`: a message to another session. `to` is that session's name as `ListSessions`
 * prints it, never an address; `files` are paths the sending session can read, staged into the
 * receiving session as its own attachments.
 */
export interface SendToSessionArguments {
  to: string;
  message: string;
  files?: string[] | undefined;
}
/** Parses {@link SendToSessionArguments}. */
export const SendToSessionArgumentsSchema: z.ZodType<SendToSessionArguments> = z
  .object({
    to: wireFreeFormString(SESSION_NAME_MAX_LEN, "SendToSession.to"),
    message: wireUncappedFreeFormString("SendToSession.message"),
    files: z.array(wireFreeFormString(FILE_PATH_MAX_LEN, "SendToSession.files")).optional(),
  })
  .strict();

/** `ListSessions` takes no arguments. */
export type ListSessionsArguments = Record<string, never>;
/** Parses {@link ListSessionsArguments}: an empty object. */
export const ListSessionsArgumentsSchema: z.ZodType<ListSessionsArguments, ListSessionsArguments> =
  z.object({}).strict();

/**
 * `task_output`: the status of a tool call that moved to the background and, once it ends, its
 * result. `wait_seconds` is how long the model asks to wait; the daemon waits at most 10 s.
 */
export interface TaskOutputArguments {
  task_id: string;
  wait_seconds?: number | undefined;
}
/** Parses {@link TaskOutputArguments}. */
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
/** Parses {@link TaskStopArguments}. */
export const TaskStopArgumentsSchema: z.ZodType<TaskStopArguments> = z
  .object({ task_id: wireUncappedFreeFormString("task_stop.task_id") })
  .strict();
