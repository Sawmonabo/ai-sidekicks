// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `mcp.*` method table, the sign-in event payload, the status notice, the refusal codes, a write conflict's reason, the binding store's cause and a config file refusal's details.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { KeychainRefusalCause } from "../keychain.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { RuntimeBindingId } from "../provider/driver/runtime-binding.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "../session/id.js";
import type {
  McpBindingScope,
  McpRegistrySearchRequest,
  McpRegistrySearchResponse,
  McpServerBindingId,
  McpServerBindingRef,
  McpServerDeleteRequest,
  McpServerDeleteResponse,
  McpServerEnabledUpdateRequest,
  McpServerListRequest,
  McpServerListResponse,
  McpServerMutationResponse,
  McpServerReadResponse,
  McpServerReconnectRequest,
  McpServerReconnectResponse,
  McpServerSignInRequest,
  McpServerSignInResponse,
  McpServerSignOutRequest,
  McpServerStatus,
  McpServerUpsertRequest,
  McpToolOverrideClearRequest,
  McpToolOverrideMutationResponse,
  McpToolOverrideUpdateRequest,
} from "./server.js";

/** No binding with the requested provider, scope, folder and name exists. */
export const MCP_SERVER_NOT_FOUND_CODE = "mcp.server.notFound" as const;

/** The submitted configuration failed validation before anything was written. */
export const MCP_SERVER_CONFIG_INVALID_CODE = "mcp.server.configInvalid" as const;

/**
 * The provider's config file changed under the write: the provider's own version check
 * failed, a project file no longer hashes to what the daemon last read, or another writer
 * changed the binding's entry since the daemon read it.
 */
export const MCP_SERVER_CONFIG_WRITE_CONFLICT_CODE = "mcp.server.configWriteConflict" as const;

/**
 * The change reused a key with another request; the screen sends the change again under a
 * new key.
 */
export const MCP_SERVER_IDEMPOTENCY_CONFLICT_CODE = "mcp.server.idempotencyConflict" as const;

/**
 * The provider's own config does not load, so nothing was written; the screen names the
 * files.
 */
export const MCP_SERVER_CONFIG_FILE_INVALID_CODE = "mcp.server.configFileInvalid" as const;

/**
 * The sign-in could not be started for a passing reason; retry under a new key. A failure
 * after it started arrives as an event.
 */
export const MCP_SERVER_SIGN_IN_FAILED_CODE = "mcp.server.signInFailed" as const;

/**
 * The keychain refused to delete the sign-in, so the server stays signed in; the refusal
 * carries the keychain's cause.
 */
export const MCP_SERVER_SIGN_OUT_FAILED_CODE = "mcp.server.signOutFailed" as const;

/**
 * `mcp.server.status.changed`, the live notice of a status change on `mcp.subscribe`,
 * written to no log, tagged on `origin`, placed on its row by `serverBindingId`: a
 * `sessionFeed` notice names the session and the live leg whose own status changed, its two
 * statuses that leg's, so a page updates that leg's line; a `sessionEnded` notice names the
 * session whose leg left, its `status` the aggregate over the legs that remain; a
 * `machineProbe` notice carries the probe's own readings and names neither.
 */
export type McpServerStatusChangedNotice =
  | {
      origin: "sessionFeed";
      /**
       * Always `mcp.server.status.changed`.
       */
      type: "mcp.server.status.changed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The binding's scope.
       */
      scope: McpBindingScope;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, the same as on its `mcp.server.list` entry, which places
       * every notice on that row; the audit ref names the binding to a person.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The status before.
       */
      previousStatus: McpServerStatus;
      /**
       * The status now.
       */
      status: McpServerStatus;
      /**
       * Why it failed, where the provider said.
       */
      failureReason?: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The live leg.
       */
      bindingId: RuntimeBindingId;
      /**
       * When the leg's reading that changed its status was observed.
       */
      observedAt: WireInstant;
    }
  | {
      origin: "sessionEnded";
      /**
       * Always `mcp.server.status.changed`.
       */
      type: "mcp.server.status.changed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The binding's scope.
       */
      scope: McpBindingScope;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, the same as on its `mcp.server.list` entry, which places
       * every notice on that row; the audit ref names the binding to a person.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The status before.
       */
      previousStatus: McpServerStatus;
      /**
       * The status now.
       */
      status: McpServerStatus;
      /**
       * Why it failed, where the provider said.
       */
      failureReason?: string;
      /**
       * The session whose leg left.
       */
      sessionId: SessionId;
      /**
       * The leg that left.
       */
      bindingId: RuntimeBindingId;
    }
  | {
      origin: "machineProbe";
      /**
       * Always `mcp.server.status.changed`.
       */
      type: "mcp.server.status.changed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The binding's scope.
       */
      scope: McpBindingScope;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, the same as on its `mcp.server.list` entry, which places
       * every notice on that row; the audit ref names the binding to a person.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The status before.
       */
      previousStatus: McpServerStatus;
      /**
       * The status now.
       */
      status: McpServerStatus;
      /**
       * Why it failed, where the provider said.
       */
      failureReason?: string;
      /**
       * Never present: no session saw it.
       */
      sessionId?: never;
      /**
       * Never present: no live leg saw it.
       */
      bindingId?: never;
    };
/**
 * How a sign-in ended.
 */
export type McpServerSignInOutcome = "success" | "failure";
/**
 * Why a write to a provider's own config lost to a concurrent edit: the
 * `mcp.server.configWriteConflict` refusal's `data.fields.reason`.
 */
export type McpServerConfigWriteConflictReason =
  | "staleVersion"
  | "configFileChanged"
  | "entryChanged";
/**
 * Why the daemon's receipt key could not be used: one `mcp.bindingStoreUnavailable` cause.
 */
export type McpReceiptKeyCause = "receiptKeyLost";
/**
 * The `mcp.bindingStoreUnavailable` refusal's `data.fields.cause`: the receipt key's cause, or
 * the keychain's when it could not be read.
 */
export type McpBindingStoreUnavailableCause = McpReceiptKeyCause | KeychainRefusalCause;

/**
 * The payload of `mcp.server.signIn.completed`: how a sign-in ended. A sign-in that fails after
 * `mcp.server.signIn` has answered arrives here as `failure`, never as a late error.
 */
export interface McpServerSignInCompletedPayload {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The binding's scope.
   */
  scope: McpBindingScope;
  /**
   * The server's name.
   */
  serverName: string;
  /**
   * How it ended.
   */
  outcome: McpServerSignInOutcome;
  /**
   * Why it failed.
   */
  failureReason?: string;
  /**
   * The session the sign-in was started from.
   */
  initiatingSessionId?: SessionId;
}
/**
 * The `mcp.server.configFileInvalid` refusal's `data.fields`: the binding the write was for and
 * the provider's config files. It is the one MCP refusal detail that names a path on this machine.
 */
export interface McpServerConfigFileInvalidDetails {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The binding's scope.
   */
  scope: McpBindingScope;
  /**
   * The server's name.
   */
  serverName: string;
  /**
   * The paths of the config's layers the provider reported on the read before the write; a
   * layer with no file is named by its kind. A path read from the provider's words never goes
   * in.
   */
  configFiles: string[];
}

export {
  validateMcpServerSignInCompletedPayload,
  validateMcpServerSignInOutcome,
} from "../checks/mcp/governance.js";

/** The methods of {@link MCP_METHOD_DESCRIPTORS}, each with its kind. */
export interface McpMethodDescriptors {
  readonly "mcp.server.list": {
    readonly method: "mcp.server.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "mcp.server.read": {
    readonly method: "mcp.server.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "mcp.registry.search": {
    readonly method: "mcp.registry.search";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "mcp.server.upsert": {
    readonly method: "mcp.server.upsert";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.server.delete": {
    readonly method: "mcp.server.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.server.enabled.update": {
    readonly method: "mcp.server.enabled.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.toolOverride.update": {
    readonly method: "mcp.toolOverride.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.toolOverride.clear": {
    readonly method: "mcp.toolOverride.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.server.signIn": {
    readonly method: "mcp.server.signIn";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.server.signOut": {
    readonly method: "mcp.server.signOut";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "mcp.server.reconnect": {
    readonly method: "mcp.server.reconnect";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link MCP_METHOD_DESCRIPTORS}. */
export interface McpMethodTypes {
  readonly "mcp.server.list": {
    readonly params: McpServerListRequest;
    readonly result: McpServerListResponse;
  };
  readonly "mcp.server.read": {
    readonly params: McpServerBindingRef;
    readonly result: McpServerReadResponse;
  };
  readonly "mcp.registry.search": {
    readonly params: McpRegistrySearchRequest;
    readonly result: McpRegistrySearchResponse;
  };
  readonly "mcp.server.upsert": {
    readonly params: McpServerUpsertRequest;
    readonly result: McpServerMutationResponse;
  };
  readonly "mcp.server.delete": {
    readonly params: McpServerDeleteRequest;
    readonly result: McpServerDeleteResponse;
  };
  readonly "mcp.server.enabled.update": {
    readonly params: McpServerEnabledUpdateRequest;
    readonly result: McpServerMutationResponse;
  };
  readonly "mcp.toolOverride.update": {
    readonly params: McpToolOverrideUpdateRequest;
    readonly result: McpToolOverrideMutationResponse;
  };
  readonly "mcp.toolOverride.clear": {
    readonly params: McpToolOverrideClearRequest;
    readonly result: McpToolOverrideMutationResponse;
  };
  readonly "mcp.server.signIn": {
    readonly params: McpServerSignInRequest;
    readonly result: McpServerSignInResponse;
  };
  readonly "mcp.server.signOut": {
    readonly params: McpServerSignOutRequest;
    readonly result: EmptyPayload;
  };
  readonly "mcp.server.reconnect": {
    readonly params: McpServerReconnectRequest;
    readonly result: McpServerReconnectResponse;
  };
}
/**
 * Every `mcp.*` method but `mcp.subscribe`, whose emissions are session events and live
 * notices.
 */
export const MCP_METHOD_DESCRIPTORS: McpMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "mcp.server.list": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.list",
    procedureType: "query",
    mutating: false,
  }),
  "mcp.server.read": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.read",
    procedureType: "query",
    mutating: false,
  }),
  "mcp.registry.search": /* @__PURE__ */ Object.freeze({
    method: "mcp.registry.search",
    procedureType: "query",
    mutating: false,
  }),
  "mcp.server.upsert": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.upsert",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.server.delete": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.delete",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.server.enabled.update": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.enabled.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.toolOverride.update": /* @__PURE__ */ Object.freeze({
    method: "mcp.toolOverride.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.toolOverride.clear": /* @__PURE__ */ Object.freeze({
    method: "mcp.toolOverride.clear",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.server.signIn": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.signIn",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.server.signOut": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.signOut",
    procedureType: "mutation",
    mutating: true,
  }),
  "mcp.server.reconnect": /* @__PURE__ */ Object.freeze({
    method: "mcp.server.reconnect",
    procedureType: "mutation",
    mutating: true,
  }),
});
