// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The machine-wide service settings on Settings › Runtime, and the two package caches whose size limit is one of them.

import type { Port, WireInstant } from "../internal/wire-scalars.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { TokensPerRun, UsdMicros } from "../session/cost.js";

/**
 * `Stop a run after`'s steps, in minutes.
 */
export type RunTimeLimitMinutes = 30 | 60 | 240 | 720 | 1440;
/**
 * `Ask me after one start leads to`'s steps, in runs.
 */
export type WorkflowChainAskAfterRuns = 25 | 100 | 500 | 2000;
/**
 * `daemon.config.update`: exactly one setting, as `{"<setting>": value}`; a nullable setting's
 * `null` clears it.
 */
export type DaemonConfigUpdateRequest =
  | {
      workflowListenerPort: Port;
    }
  | {
      runTimeLimitMinutes: RunTimeLimitMinutes | null;
    }
  | {
      workflowChainAskAfterRuns: WorkflowChainAskAfterRuns | null;
    }
  | {
      maxStepsPerTurn: number | null;
    }
  | {
      spendLimitUsdMicros: UsdMicros | null;
    }
  | {
      tokensPerRun: TokensPerRun | null;
    }
  | {
      toolMemoryCapBytes: number | null;
    }
  | {
      packageCacheLimitBytes: number | null;
    }
  | {
      recordTraces: boolean;
    }
  | {
      recordProviderMessages: boolean;
    };
/**
 * Which cache a clear empties.
 */
export type PackageCacheClearTarget = "bun" | "uv" | "all";

/**
 * The settings, and the two facts the page draws beside them.
 */
export interface DaemonConfig {
  /**
   * The port a workflow started by a web request listens on.
   */
  workflowListenerPort: Port;
  /**
   * `Stop a run after`; `null` is `No limit`.
   */
  runTimeLimitMinutes: RunTimeLimitMinutes | null;
  /**
   * How many runs one start may lead to before the next asks; `null` is `Never ask`.
   */
  workflowChainAskAfterRuns: WorkflowChainAskAfterRuns | null;
  /**
   * `Max steps per turn`; `null` is `Unlimited`, each provider's own behavior.
   */
  maxStepsPerTurn: number | null;
  /**
   * `Spend limit`, what each new session starts from; `null` is `Unlimited`.
   */
  spendLimitUsdMicros: UsdMicros | null;
  /**
   * `Tokens per run`, what each new session starts from; `null` is `Unlimited`.
   */
  tokensPerRun: TokensPerRun | null;
  /**
   * `Memory cap for tool processes`, in bytes; `null` is no cap.
   */
  toolMemoryCapBytes: number | null;
  /**
   * `Cache limit`, in bytes, applied to each package cache on its own; `null` is `Unlimited`.
   */
  packageCacheLimitBytes: number | null;
  /**
   * `Record traces`.
   */
  recordTraces: boolean;
  /**
   * `Record raw provider messages`.
   */
  recordProviderMessages: boolean;
  /**
   * Whether this operating system lets the service enforce the memory cap.
   */
  toolMemoryCapEnforceable: boolean;
  /**
   * The folder raw provider messages are written to.
   */
  providerMessagesPath: string;
}
/**
 * One cache's size, read by walking its folder when asked.
 */
export interface PackageCacheReading {
  /**
   * The cache's size in bytes.
   */
  bytes: number;
  /**
   * When it was read.
   */
  readAt: WireInstant;
}
/**
 * Each cache's size and when it was read; the page adds the total.
 */
export interface DaemonPackageCacheReading {
  /**
   * The bun cache.
   */
  bun: PackageCacheReading;
  /**
   * The uv cache.
   */
  uv: PackageCacheReading;
}
/**
 * `daemon.packageCache.clear`. A clear waits for the installs using that cache, never removes a
 * step already installed, and answers with the new reading.
 */
export interface DaemonPackageCacheClearRequest {
  /**
   * The cache to empty.
   */
  cache: PackageCacheClearTarget;
}

/** The methods of {@link DAEMON_CONFIG_METHOD_DESCRIPTORS}, each with its kind. */
export interface DaemonConfigMethodDescriptors {
  readonly "daemon.config.read": {
    readonly method: "daemon.config.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "daemon.config.update": {
    readonly method: "daemon.config.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "daemon.packageCache.list": {
    readonly method: "daemon.packageCache.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "daemon.packageCache.clear": {
    readonly method: "daemon.packageCache.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link DAEMON_CONFIG_METHOD_DESCRIPTORS}. */
export interface DaemonConfigMethodTypes {
  readonly "daemon.config.read": { readonly params: EmptyPayload; readonly result: DaemonConfig };
  readonly "daemon.config.update": {
    readonly params: DaemonConfigUpdateRequest;
    readonly result: DaemonConfig;
  };
  readonly "daemon.packageCache.list": {
    readonly params: EmptyPayload;
    readonly result: DaemonPackageCacheReading;
  };
  readonly "daemon.packageCache.clear": {
    readonly params: DaemonPackageCacheClearRequest;
    readonly result: DaemonPackageCacheReading;
  };
}
/** The config and package-cache methods. */
export const DAEMON_CONFIG_METHOD_DESCRIPTORS: DaemonConfigMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "daemon.config.read": /* @__PURE__ */ Object.freeze({
      method: "daemon.config.read",
      procedureType: "query",
      mutating: false,
    }),
    "daemon.config.update": /* @__PURE__ */ Object.freeze({
      method: "daemon.config.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "daemon.packageCache.list": /* @__PURE__ */ Object.freeze({
      method: "daemon.packageCache.list",
      procedureType: "query",
      mutating: false,
    }),
    "daemon.packageCache.clear": /* @__PURE__ */ Object.freeze({
      method: "daemon.packageCache.clear",
      procedureType: "mutation",
      mutating: true,
    }),
  });
