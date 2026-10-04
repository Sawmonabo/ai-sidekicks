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
} from "./method-descriptor.js";

/**
 * A stop or restart takes nothing: a confirmed one goes ahead at once, with no wait for the
 * other connected clients, and is never refused.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonStopRequest {}
/** Parses a {@link DaemonStopRequest}. */
export const DaemonStopRequestSchema: z.ZodType<DaemonStopRequest, DaemonStopRequest> = z
  .object({})
  .strict();

/** A restart takes nothing, as a stop does. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonRestartRequest {}
/** Parses a {@link DaemonRestartRequest}. */
export const DaemonRestartRequestSchema: z.ZodType<DaemonRestartRequest, DaemonRestartRequest> = z
  .object({})
  .strict();

/** The service took the stop or restart. */
export interface DaemonLifecycleAccepted {
  accepted: true;
}
/** Parses a {@link DaemonLifecycleAccepted}. */
export const DaemonLifecycleAcceptedSchema: z.ZodType<DaemonLifecycleAccepted> = z
  .object({ accepted: z.literal(true) })
  .strict();

/** `daemon.flush` takes nothing: everything pending is made durable. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonFlushRequest {}
/** Parses a {@link DaemonFlushRequest}. */
export const DaemonFlushRequestSchema: z.ZodType<DaemonFlushRequest, DaemonFlushRequest> = z
  .object({})
  .strict();

/** Every write pending when the flush arrived is durable. */
export interface DaemonFlushResponse {
  flushed: true;
}
/** Parses a {@link DaemonFlushResponse}. */
export const DaemonFlushResponseSchema: z.ZodType<DaemonFlushResponse> = z
  .object({ flushed: z.literal(true) })
  .strict();

/**
 * `daemon.ping` takes nothing and answers nothing: the answer arriving is the
 * whole of it. The main process sends one only after 5 s with no frame from the
 * service, so a busy link carries none.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DaemonPingRequest {}
/** Parses a {@link DaemonPingRequest}. */
export const DaemonPingRequestSchema: z.ZodType<DaemonPingRequest, DaemonPingRequest> = z
  .object({})
  .strict();

/** The lifecycle verbs' descriptors. */
export interface DaemonLifecycleMethodDescriptors {
  readonly "daemon.stop": MethodDescriptor<
    "daemon.stop",
    DaemonStopRequest,
    DaemonLifecycleAccepted
  >;
  readonly "daemon.restart": MethodDescriptor<
    "daemon.restart",
    DaemonRestartRequest,
    DaemonLifecycleAccepted
  >;
  readonly "daemon.flush": MethodDescriptor<
    "daemon.flush",
    DaemonFlushRequest,
    DaemonFlushResponse
  >;
  readonly "daemon.ping": MethodDescriptor<"daemon.ping", DaemonPingRequest, EmptyPayload>;
}

/**
 * The lifecycle methods' names, procedure types and shapes.
 *
 * @consumedBy the daemon's stop, restart and flush handlers
 */
export const DAEMON_LIFECYCLE_METHOD_DESCRIPTORS: DaemonLifecycleMethodDescriptors =
  defineMethodDescriptors({
    "daemon.stop": {
      method: "daemon.stop",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonStopRequestSchema,
      responseSchema: DaemonLifecycleAcceptedSchema,
    },
    "daemon.restart": {
      method: "daemon.restart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonRestartRequestSchema,
      responseSchema: DaemonLifecycleAcceptedSchema,
    },
    "daemon.flush": {
      method: "daemon.flush",
      procedureType: "mutation",
      mutating: true,
      requestSchema: DaemonFlushRequestSchema,
      responseSchema: DaemonFlushResponseSchema,
    },
    "daemon.ping": {
      method: "daemon.ping",
      procedureType: "query",
      mutating: false,
      requestSchema: DaemonPingRequestSchema,
      responseSchema: EmptyPayloadSchema,
    },
  });
