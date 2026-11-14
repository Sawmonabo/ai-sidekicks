// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The two retention bounds on Settings › Runtime, and `Delete old data`.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { EmptyPayload } from "../method-descriptor.js";

/** `Keep diagnostic logs for` as the app starts out, seven days, in milliseconds. */
export const DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS = 604800000 as const;

/**
 * `daemon.retention.update`: exactly one bound, as `{"<bound>": days}`. Setting a bound deletes
 * nothing.
 */
export type DaemonRetentionUpdateRequest =
  | {
      keepDiagnosticLogsDays: number;
    }
  | {
      keepSessionsDays: number;
    };

/**
 * The two bounds, each in whole days.
 */
export interface DaemonRetentionBounds {
  /**
   * The service's own logs and, in each account home, what the provider writes and never reads
   * back for a session. Any period is taken as set.
   */
  keepDiagnosticLogsDays: number;
  /**
   * How long a finished session stays before it can be deleted.
   */
  keepSessionsDays: number;
}
/**
 * What `Delete old data` would remove if it ran now.
 */
export interface DaemonRetentionPurgePreview {
  /**
   * How many sessions the purge would remove: those archived or closed before the cutoff, and
   * every one a failed purge left marked.
   */
  archivedSessionCount: number;
  /**
   * Sessions archived or closed before this moment are the ones counted.
   */
  cutoffAt: WireInstant;
}
/**
 * The bounds, and the count the purge's confirm names.
 */
export interface DaemonRetentionReadResponse {
  /**
   * `Keep diagnostic logs for`, in whole days.
   */
  keepDiagnosticLogsDays: number;
  /**
   * How long a finished session stays before it can be deleted, in whole days.
   */
  keepSessionsDays: number;
  /**
   * What the purge would remove now.
   */
  purge: DaemonRetentionPurgePreview;
}
/**
 * `daemon.retention.purge`: the cutoff the confirm was read against, so the purge removes exactly
 * what the confirm named and a second press removes nothing more.
 */
export interface DaemonRetentionPurgeRequest {
  /**
   * The cutoff the confirm named.
   */
  cutoffAt: WireInstant;
}
/**
 * How many sessions the purge removed.
 */
export interface DaemonRetentionPurgeResponse {
  /**
   * The sessions removed.
   */
  deletedSessionCount: number;
}

/** The methods of {@link DAEMON_RETENTION_METHOD_DESCRIPTORS}, each with its kind. */
export interface DaemonRetentionMethodDescriptors {
  readonly "daemon.retention.read": {
    readonly method: "daemon.retention.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "daemon.retention.update": {
    readonly method: "daemon.retention.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "daemon.retention.purge": {
    readonly method: "daemon.retention.purge";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "daemon.retention.subscribe": {
    readonly method: "daemon.retention.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link DAEMON_RETENTION_METHOD_DESCRIPTORS}. */
export interface DaemonRetentionMethodTypes {
  readonly "daemon.retention.read": {
    readonly params: EmptyPayload;
    readonly result: DaemonRetentionReadResponse;
  };
  readonly "daemon.retention.update": {
    readonly params: DaemonRetentionUpdateRequest;
    readonly result: DaemonRetentionBounds;
  };
  readonly "daemon.retention.purge": {
    readonly params: DaemonRetentionPurgeRequest;
    readonly result: DaemonRetentionPurgeResponse;
  };
  readonly "daemon.retention.subscribe": {
    readonly params: EmptyPayload;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: DaemonRetentionBounds;
  };
}
/** The retention methods. */
export const DAEMON_RETENTION_METHOD_DESCRIPTORS: DaemonRetentionMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.retention.read": /* @__PURE__ */ Object.freeze({
      method: "daemon.retention.read",
      procedureType: "query",
      mutating: false,
    }),
    "daemon.retention.update": /* @__PURE__ */ Object.freeze({
      method: "daemon.retention.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "daemon.retention.purge": /* @__PURE__ */ Object.freeze({
      method: "daemon.retention.purge",
      procedureType: "mutation",
      mutating: true,
    }),
    "daemon.retention.subscribe": /* @__PURE__ */ Object.freeze({
      method: "daemon.retention.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
  });
