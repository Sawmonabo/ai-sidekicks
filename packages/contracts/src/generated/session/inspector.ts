// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The reads behind a session's inspector sections, and the `Auto memory` switch. Every figure and list is the provider's own report for this session.

import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionAddressedRequest } from "./controls/methods.js";
import type { SessionId } from "./id.js";

/**
 * How the provider marks a bucket: counted as used, deferred (dimmed and left out of the used
 * figure), the compaction buffer, or free space.
 */
export type SessionContextCategoryKind = "used" | "deferred" | "buffer" | "free";
/**
 * What fills the context, by the shape of the provider's report: named buckets with their parts,
 * or totals only, the four figures of a token-usage report.
 */
export type SessionContextBreakdown =
  | {
      kind: "buckets";
      /**
       * The buckets, in the provider's order.
       */
      categories: SessionContextCategory[];
      /**
       * Never present: only totals carry token figures.
       */
      cachedInputTokens?: never;
      /**
       * Never present: only totals carry token figures.
       */
      inputTokens?: never;
      /**
       * Never present: only totals carry token figures.
       */
      outputTokens?: never;
      /**
       * Never present: only totals carry token figures.
       */
      reasoningTokens?: never;
    }
  | {
      kind: "totals";
      /**
       * Never present: only named buckets carry categories.
       */
      categories?: never;
      /**
       * Cached input tokens.
       */
      cachedInputTokens: number;
      /**
       * Input tokens.
       */
      inputTokens: number;
      /**
       * Output tokens.
       */
      outputTokens: number;
      /**
       * Reasoning tokens.
       */
      reasoningTokens: number;
    };
/**
 * Whether a memory path is a file or a folder.
 */
export type SessionMemoryEntryKind = "file" | "folder";
/**
 * Whether the store is shared across the provider's accounts.
 */
export type SessionMemoryHomeScope = "account" | "sharedAcrossAccounts";
/**
 * When an `Auto memory` change takes effect.
 */
export type SessionAutoMemoryAppliesAt = "now" | "nextStart";
/**
 * One hook the provider loaded for a folder, tagged on what it runs. `event`, `matcher`,
 * `source` and `trustStatus` are the provider's own words, carried as sent.
 */
export type SessionProviderHook =
  | {
      handlerType: "command";
      /**
       * The provider's key for the hook.
       */
      key: string;
      /**
       * The event it runs on.
       */
      event: string;
      /**
       * Its matcher, where it has one.
       */
      matcher?: string;
      /**
       * Its time limit, in seconds.
       */
      timeoutSeconds: number;
      /**
       * The line the provider shows while it runs, where it has one.
       */
      statusMessage?: string;
      /**
       * The file it was read from.
       */
      sourcePath: string;
      /**
       * Where it came from, in the provider's words.
       */
      source: string;
      /**
       * The plugin it came with, where a plugin brought it.
       */
      pluginId?: string;
      /**
       * Whether it is enabled.
       */
      enabled: boolean;
      /**
       * Whether managed settings hold it.
       */
      managed: boolean;
      /**
       * The provider's hash of it.
       */
      hash: string;
      /**
       * Its trust status, in the provider's words.
       */
      trustStatus: string;
      /**
       * The command it runs.
       */
      command: string;
      /**
       * Whether it runs without holding up the event.
       */
      async: boolean;
      /**
       * Never present: only a tool server's hook names a server.
       */
      server?: never;
      /**
       * Never present: only a tool server's hook names a tool.
       */
      tool?: never;
    }
  | {
      handlerType: "mcpTool";
      /**
       * The provider's key for the hook.
       */
      key: string;
      /**
       * The event it runs on.
       */
      event: string;
      /**
       * Its matcher, where it has one.
       */
      matcher?: string;
      /**
       * Its time limit, in seconds.
       */
      timeoutSeconds: number;
      /**
       * The line the provider shows while it runs, where it has one.
       */
      statusMessage?: string;
      /**
       * The file it was read from.
       */
      sourcePath: string;
      /**
       * Where it came from, in the provider's words.
       */
      source: string;
      /**
       * The plugin it came with, where a plugin brought it.
       */
      pluginId?: string;
      /**
       * Whether it is enabled.
       */
      enabled: boolean;
      /**
       * Whether managed settings hold it.
       */
      managed: boolean;
      /**
       * The provider's hash of it.
       */
      hash: string;
      /**
       * Its trust status, in the provider's words.
       */
      trustStatus: string;
      /**
       * Never present: only a command hook runs a command.
       */
      command?: never;
      /**
       * Never present: only a command hook runs without holding up the event.
       */
      async?: never;
      /**
       * The tool server.
       */
      server: string;
      /**
       * The tool it calls.
       */
      tool: string;
    }
  | {
      handlerType: "prompt";
      /**
       * The provider's key for the hook.
       */
      key: string;
      /**
       * The event it runs on.
       */
      event: string;
      /**
       * Its matcher, where it has one.
       */
      matcher?: string;
      /**
       * Its time limit, in seconds.
       */
      timeoutSeconds: number;
      /**
       * The line the provider shows while it runs, where it has one.
       */
      statusMessage?: string;
      /**
       * The file it was read from.
       */
      sourcePath: string;
      /**
       * Where it came from, in the provider's words.
       */
      source: string;
      /**
       * The plugin it came with, where a plugin brought it.
       */
      pluginId?: string;
      /**
       * Whether it is enabled.
       */
      enabled: boolean;
      /**
       * Whether managed settings hold it.
       */
      managed: boolean;
      /**
       * The provider's hash of it.
       */
      hash: string;
      /**
       * Its trust status, in the provider's words.
       */
      trustStatus: string;
      /**
       * Never present: only a command hook runs a command.
       */
      command?: never;
      /**
       * Never present: only a command hook runs without holding up the event.
       */
      async?: never;
      /**
       * Never present: only a tool server's hook names a server.
       */
      server?: never;
      /**
       * Never present: only a tool server's hook names a tool.
       */
      tool?: never;
    }
  | {
      handlerType: "agent";
      /**
       * The provider's key for the hook.
       */
      key: string;
      /**
       * The event it runs on.
       */
      event: string;
      /**
       * Its matcher, where it has one.
       */
      matcher?: string;
      /**
       * Its time limit, in seconds.
       */
      timeoutSeconds: number;
      /**
       * The line the provider shows while it runs, where it has one.
       */
      statusMessage?: string;
      /**
       * The file it was read from.
       */
      sourcePath: string;
      /**
       * Where it came from, in the provider's words.
       */
      source: string;
      /**
       * The plugin it came with, where a plugin brought it.
       */
      pluginId?: string;
      /**
       * Whether it is enabled.
       */
      enabled: boolean;
      /**
       * Whether managed settings hold it.
       */
      managed: boolean;
      /**
       * The provider's hash of it.
       */
      hash: string;
      /**
       * Its trust status, in the provider's words.
       */
      trustStatus: string;
      /**
       * Never present: only a command hook runs a command.
       */
      command?: never;
      /**
       * Never present: only a command hook runs without holding up the event.
       */
      async?: never;
      /**
       * Never present: only a tool server's hook names a server.
       */
      server?: never;
      /**
       * Never present: only a tool server's hook names a tool.
       */
      tool?: never;
    };
/**
 * The inspector's `Hooks` section, by the shape of the provider's own listing: `byFolder` for
 * hooks listed per folder, `byEvent` for hooks listed by event with the provider's policy, and
 * `listedAtNextStart` for a session whose provider has listed none yet, which it lists at its
 * next start. The daemon's own hooks are never listed.
 */
export type SessionHookListResponse =
  | {
      kind: "byFolder";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The folders.
       */
      folders: ProviderHookSource[];
      /**
       * Never present: a listing by folder keeps its hooks in each folder.
       */
      hooks?: never;
      /**
       * Never present: a listing by folder keeps its errors in each folder.
       */
      errors?: never;
      /**
       * Never present: only a listing by event carries the provider's policy.
       */
      policy?: never;
    }
  | {
      kind: "byEvent";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * Never present: a listing by event names no folder.
       */
      folders?: never;
      /**
       * The hooks, in the provider's order.
       */
      hooks: SessionProviderEventHook[];
      /**
       * The settings files the provider skipped.
       */
      errors: ProviderHookSettingsError[];
      /**
       * What managed settings do to the hooks.
       */
      policy: ProviderHookPolicy;
    }
  | {
      kind: "listedAtNextStart";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * Never present: nothing is listed yet.
       */
      folders?: never;
      /**
       * Never present: nothing is listed yet.
       */
      hooks?: never;
      /**
       * Never present: nothing is listed yet.
       */
      errors?: never;
      /**
       * Never present: nothing is listed yet.
       */
      policy?: never;
    };

/**
 * Where the session compacts and the slider's range. The top stop is the provider's own compaction
 * point on this window; the bottom stop is the session's fixed start plus a tenth of the window,
 * rounded up, and is `null` where the provider reports what the session loads only with its first
 * usage report, until that report comes.
 * `sessionOverride` draws the `session` mark: the bound differs from the Settings default.
 */
export interface SessionCompactionBound {
  /**
   * The bound, in percent of the window.
   */
  boundPercent: number;
  /**
   * The slider's top stop.
   */
  topStopPercent: number;
  /**
   * The slider's bottom stop, `null` until it is known.
   */
  bottomStopPercent: number | null;
  /**
   * Whether the bound differs from the Settings default.
   */
  sessionOverride: boolean;
}
/**
 * One named part inside a bucket: a tool, a memory file, an agent or a skill.
 */
export interface SessionContextPart {
  /**
   * The part's name.
   */
  name: string;
  /**
   * Its tokens.
   */
  tokens: number;
}
/**
 * One of the provider's named buckets, in its own order, with the parts it names.
 */
export interface SessionContextCategory {
  /**
   * The bucket's name.
   */
  name: string;
  /**
   * Its tokens.
   */
  tokens: number;
  /**
   * How the provider marks it.
   */
  kind: SessionContextCategoryKind;
  /**
   * The parts it names, where it names any.
   */
  parts?: SessionContextPart[];
}
/**
 * The used tokens against the window, and what they are made of.
 */
export interface SessionContextUsage {
  /**
   * The used tokens.
   */
  usedTokens: number;
  /**
   * The used share of the window, in percent.
   */
  usedPercent: number;
  /**
   * What the used tokens are made of.
   */
  breakdown: SessionContextBreakdown;
}
/**
 * One reading of the session's context, which feeds the ring and the inspector's `Context`
 * section alike so the two never disagree. Every figure is the provider's own, read at creation,
 * on every model change and on each usage report. `usage` is `null` until the provider has
 * reported one, which on some providers is the first turn's report.
 */
export interface SessionContextReading {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The window, in tokens.
   */
  windowTokens: number;
  /**
   * Where the session compacts.
   */
  compaction: SessionCompactionBound;
  /**
   * The usage, `null` until the provider has reported one.
   */
  usage: SessionContextUsage | null;
}
/**
 * One memory file or folder the provider reported for this session.
 */
export interface SessionMemoryEntry {
  /**
   * The path.
   */
  path: string;
  /**
   * Whether it is a file or a folder.
   */
  kind: SessionMemoryEntryKind;
}
/**
 * The `Auto memory` switch, with the value waiting for the provider's next start where a change
 * waits for it.
 */
export interface SessionAutoMemory {
  /**
   * Whether it is on now.
   */
  enabled: boolean;
  /**
   * The value it takes at the next start, while a change waits for it.
   */
  enabledAtNextStart?: boolean;
}
/**
 * The inspector's `Memory` section: the home the session's conversation runs in, whether its
 * store is shared across accounts, the `Auto memory` switch and the memory paths.
 */
export interface SessionMemoryReadResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The home the session's conversation runs in, whose store holds the memory.
   */
  home: string;
  /**
   * Whether that store is shared across the provider's accounts.
   */
  homeScope: SessionMemoryHomeScope;
  /**
   * The `Auto memory` switch.
   */
  autoMemory: SessionAutoMemory;
  /**
   * The memory paths.
   */
  entries: SessionMemoryEntry[];
  /**
   * True for a session with no conversation running since the daemon started, whose provider
   * has reported no rows yet.
   */
  listedAtNextStart: boolean;
}
/**
 * Turns the session's `Auto memory` switch on or off.
 */
export interface SessionAutoMemoryUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Whether it is on.
   */
  enabled: boolean;
}
/**
 * The switch, and when it takes effect: at once, or at the provider's next start where the
 * provider reads it only then.
 */
export interface SessionAutoMemoryUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Whether it is on.
   */
  enabled: boolean;
  /**
   * When the change takes effect.
   */
  appliesAt: SessionAutoMemoryAppliesAt;
}
/**
 * An error the provider reported for a hook file.
 */
export interface ProviderHookError {
  /**
   * The file.
   */
  path: string;
  /**
   * The provider's message.
   */
  message: string;
}
/**
 * One folder's hooks, with the errors and warnings the provider reported for it.
 */
export interface ProviderHookSource {
  /**
   * The folder.
   */
  folder: string;
  /**
   * Its hooks.
   */
  hooks: SessionProviderHook[];
  /**
   * The errors reported for it.
   */
  errors: ProviderHookError[];
  /**
   * The warnings reported for it.
   */
  warnings: string[];
}
/**
 * One hook in a listing grouped by event, as the provider lists it. `event`, `matcher`, `source`,
 * `type` and `commandText` are the provider's own words, carried as sent.
 */
export interface SessionProviderEventHook {
  /**
   * The event it runs on.
   */
  event: string;
  /**
   * Its matcher, empty where it has none.
   */
  matcher: string;
  /**
   * Where it came from, in the provider's words.
   */
  source: string;
  /**
   * The plugin it came with, where a plugin brought it.
   */
  pluginName?: string;
  /**
   * What it runs, in the provider's words.
   */
  type: string;
  /**
   * The command, prompt or address it runs.
   */
  commandText: string;
  /**
   * The line the provider shows while it runs, where it has one.
   */
  statusMessage?: string;
  /**
   * Its time limit, in seconds, where it sets one; a fraction is allowed.
   */
  timeoutSeconds?: number;
  /**
   * Whether the session's mode or policy keeps it from running.
   */
  disabled: boolean;
  /**
   * The settings file it was read from, where it was read from one.
   */
  sourcePath?: string;
}
/**
 * A settings file the provider skipped, so none of its hooks are listed or run.
 */
export interface ProviderHookSettingsError {
  /**
   * The settings file, where the provider names it.
   */
  file?: string;
  /**
   * The field inside the file the error is at, empty for an error over the whole file.
   */
  path: string;
  /**
   * The provider's message.
   */
  message: string;
}
/**
 * What managed settings do to the session's hooks.
 */
export interface ProviderHookPolicy {
  /**
   * Whether managed settings turn every hook off.
   */
  disabledByPolicy: boolean;
  /**
   * Whether managed settings let only their own hooks run, which the listing then leaves out.
   */
  managedOnly: boolean;
  /**
   * Whether managed settings let only plugins change hooks.
   */
  pluginOnly: boolean;
  /**
   * Whether every hook is off, whichever settings turned them off.
   */
  allDisabled: boolean;
  /**
   * How many hooks managed settings hold.
   */
  policyHookCount: number;
  /**
   * Whether managed settings exist but could not be read.
   */
  policyUnreadable: boolean;
}

export {
  validateSessionAutoMemory,
  validateSessionMemoryEntry,
  validateSessionMemoryEntryKind,
  validateSessionMemoryHomeScope,
  validateSessionMemoryReadResponse,
} from "../checks/session/inspector.js";

/** The methods of {@link SESSION_INSPECTOR_METHOD_DESCRIPTORS}, each with its kind. */
export interface SessionInspectorMethodDescriptors {
  readonly "session.context.subscribe": {
    readonly method: "session.context.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "session.memory.read": {
    readonly method: "session.memory.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "session.autoMemory.update": {
    readonly method: "session.autoMemory.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.hook.list": {
    readonly method: "session.hook.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link SESSION_INSPECTOR_METHOD_DESCRIPTORS}. */
export interface SessionInspectorMethodTypes {
  readonly "session.context.subscribe": {
    readonly params: SessionAddressedRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: SessionContextReading;
  };
  readonly "session.memory.read": {
    readonly params: SessionAddressedRequest;
    readonly result: SessionMemoryReadResponse;
  };
  readonly "session.autoMemory.update": {
    readonly params: SessionAutoMemoryUpdateRequest;
    readonly result: SessionAutoMemoryUpdateResponse;
  };
  readonly "session.hook.list": {
    readonly params: SessionAddressedRequest;
    readonly result: SessionHookListResponse;
  };
}
/** The inspector methods' wire contract: name, procedure type and types. */
export const SESSION_INSPECTOR_METHOD_DESCRIPTORS: SessionInspectorMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.context.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.context.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "session.memory.read": /* @__PURE__ */ Object.freeze({
      method: "session.memory.read",
      procedureType: "query",
      mutating: false,
    }),
    "session.autoMemory.update": /* @__PURE__ */ Object.freeze({
      method: "session.autoMemory.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.hook.list": /* @__PURE__ */ Object.freeze({
      method: "session.hook.list",
      procedureType: "query",
      mutating: false,
    }),
  });
