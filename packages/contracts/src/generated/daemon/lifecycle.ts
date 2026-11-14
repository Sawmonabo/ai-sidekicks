// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The service's lifecycle verbs: stop, restart, the flush at quit and the ping on a quiet link.

import type { SchemaCheck } from "../../schema-check.js";
import {
  validateDaemonFlushResponse,
  validateDaemonLifecycleAccepted,
} from "../checks/daemon/lifecycle.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import type { EmptyPayload } from "../method-descriptor.js";

/**
 * The words the service's ready line carries, written once it answers on its socket;
 * whoever started the process waits for a line that holds them.
 */
export const DAEMON_READY_LINE = "The daemon is ready" as const;

/**
 * The longest a stopping service's drain runs, in milliseconds: its terminals' drain and
 * time beside it for a write still running to finish rather than roll back. A client that saw
 * a stop or restart taken waits this long for the service to exit before it signals it, so no
 * signal cuts the drain short.
 */
export const DAEMON_STOP_DRAIN_BOUND_MS = 4000 as const;

/**
 * The service took the stop or restart.
 */
export interface DaemonLifecycleAccepted {
  /**
   * Always `true`.
   */
  accepted: true;
}
/**
 * Every write pending when the flush arrived is durable.
 */
export interface DaemonFlushResponse {
  /**
   * Always `true`.
   */
  flushed: true;
}

export {
  validateDaemonFlushResponse,
  validateDaemonLifecycleAccepted,
} from "../checks/daemon/lifecycle.js";

/** The methods of {@link DAEMON_LIFECYCLE_METHOD_DESCRIPTORS}, each with its checks. */
export interface DaemonLifecycleMethodDescriptors {
  readonly "daemon.stop": {
    readonly method: "daemon.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonLifecycleAccepted>;
  };
  readonly "daemon.restart": {
    readonly method: "daemon.restart";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonLifecycleAccepted>;
  };
  readonly "daemon.flush": {
    readonly method: "daemon.flush";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonFlushResponse>;
  };
  readonly "daemon.ping": {
    readonly method: "daemon.ping";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/**
 * The lifecycle verbs. Every verb takes an empty request; none is ever refused, so the
 * service can always be stopped, restarted or flushed.
 */
export const DAEMON_LIFECYCLE_METHOD_DESCRIPTORS: DaemonLifecycleMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.stop": /* @__PURE__ */ Object.freeze({
      method: "daemon.stop",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDaemonLifecycleAccepted,
    }),
    "daemon.restart": /* @__PURE__ */ Object.freeze({
      method: "daemon.restart",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDaemonLifecycleAccepted,
    }),
    "daemon.flush": /* @__PURE__ */ Object.freeze({
      method: "daemon.flush",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateEmptyPayload,
      responseCheck: validateDaemonFlushResponse,
    }),
    "daemon.ping": /* @__PURE__ */ Object.freeze({
      method: "daemon.ping",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateEmptyPayload,
    }),
  });
