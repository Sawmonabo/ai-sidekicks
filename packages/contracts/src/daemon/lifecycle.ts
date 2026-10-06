// The service's lifecycle verbs: stop, restart, the flush at quit and the ping on a quiet
// link. There is no start verb: a stopped service has no socket, so a start is the supervisor
// or the command line spawning the process. A quit flushes and leaves every run and shell
// running; only stop and restart end work.
import { z } from "zod";

import {
  defineMethodDescriptors,
  type MethodDescriptor,
  EmptyPayloadSchema,
  type EmptyPayload,
} from "../method-descriptor.js";

/**
 * The words the service's ready line starts with, written once it answers on its socket; whoever
 * started the process waits for them.
 */
export const DAEMON_READY_LINE = "The daemon is ready";

/**
 * How long a stopping service gives its terminals, all at once, to exit before it kills them, in
 * milliseconds.
 */
export const DAEMON_STOP_TERMINAL_DRAIN_MS = 2_000;

/** How long it then gives the terminal host process to exit before it kills it, in milliseconds. */
export const DAEMON_STOP_TERMINAL_HOST_DRAIN_MS = 2_000;

/**
 * The longest a stopping service's drain runs, in milliseconds. A client that saw a stop or
 * restart taken waits this long for the service to exit before it signals it, so no signal cuts
 * the drain short.
 */
export const DAEMON_STOP_DRAIN_BOUND_MS: number =
  DAEMON_STOP_TERMINAL_DRAIN_MS + DAEMON_STOP_TERMINAL_HOST_DRAIN_MS;

/** The service took the stop or restart. */
export interface DaemonLifecycleAccepted {
  accepted: true;
}
/** Parses a {@link DaemonLifecycleAccepted}. */
export const DaemonLifecycleAcceptedSchema: z.ZodType<DaemonLifecycleAccepted> = z
  .object({ accepted: z.literal(true) })
  .strict();

/** Every write pending when the flush arrived is durable. */
export interface DaemonFlushResponse {
  flushed: true;
}
/** Parses a {@link DaemonFlushResponse}. */
export const DaemonFlushResponseSchema: z.ZodType<DaemonFlushResponse> = z
  .object({ flushed: z.literal(true) })
  .strict();

/** The lifecycle verbs' descriptors. Every verb takes an empty request. */
export interface DaemonLifecycleMethodDescriptors {
  /**
   * A confirmed stop goes ahead at once, with no wait for the other connected clients, and is
   * never refused.
   */
  readonly "daemon.stop": MethodDescriptor<"daemon.stop", EmptyPayload, DaemonLifecycleAccepted>;
  /** A restart goes ahead as a stop does. */
  readonly "daemon.restart": MethodDescriptor<
    "daemon.restart",
    EmptyPayload,
    DaemonLifecycleAccepted
  >;
  /** Everything pending is made durable. */
  readonly "daemon.flush": MethodDescriptor<"daemon.flush", EmptyPayload, DaemonFlushResponse>;
  /**
   * Answers nothing: the answer arriving is the whole of it. The main process sends one only
   * after 5 s with no frame from the service, so a busy link carries none.
   */
  readonly "daemon.ping": MethodDescriptor<"daemon.ping", EmptyPayload, EmptyPayload>;
}

/** The lifecycle methods' names, procedure types and shapes. */
export const DAEMON_LIFECYCLE_METHOD_DESCRIPTORS: DaemonLifecycleMethodDescriptors =
  defineMethodDescriptors({
    "daemon.stop": {
      method: "daemon.stop",
      procedureType: "mutation",
      mutating: true,
      requestSchema: EmptyPayloadSchema,
      responseSchema: DaemonLifecycleAcceptedSchema,
    },
    "daemon.restart": {
      method: "daemon.restart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: EmptyPayloadSchema,
      responseSchema: DaemonLifecycleAcceptedSchema,
    },
    "daemon.flush": {
      method: "daemon.flush",
      procedureType: "mutation",
      mutating: true,
      requestSchema: EmptyPayloadSchema,
      responseSchema: DaemonFlushResponseSchema,
    },
    "daemon.ping": {
      method: "daemon.ping",
      procedureType: "query",
      mutating: false,
      requestSchema: EmptyPayloadSchema,
      responseSchema: EmptyPayloadSchema,
    },
  });
