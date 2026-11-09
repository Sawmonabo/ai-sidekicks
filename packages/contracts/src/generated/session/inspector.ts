/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The reads behind a session's inspector sections, and the `Auto memory` switch. Every figure and list is the provider's own report for this session.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import type { ProviderId } from "../provider/id.js";
import {
  type SessionAddressedRequest,
  validateSessionAddressedRequest,
} from "./controls/methods.js";
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

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1972(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAutoMemoryUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1972.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.enabled === undefined) && (missing0 = "enabled"))){validate1972.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "enabled"))){validate1972.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1972.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1972.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs6: any = errors;if(typeof data.enabled !== "boolean"){validate1972.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1972.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1972.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1972.errors = null as any[] | null;
// prettier-ignore
validate1972.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3918: any = {"description":"When an `Auto memory` change takes effect.","type":"string","enum":["now","nextStart"]};
// prettier-ignore
function validate1973(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAutoMemoryUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1973.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.enabled === undefined) && (missing0 = "enabled"))) || ((data.appliesAt === undefined) && (missing0 = "appliesAt"))){validate1973.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "enabled")) || (key0 === "appliesAt"))){validate1973.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1973.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1973.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs6: any = errors;if(typeof data.enabled !== "boolean"){validate1973.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.appliesAt !== undefined){let data2: any = data.appliesAt;const _errs8: any = errors;if(typeof data2 !== "string"){validate1973.errors = [{instancePath:instancePath+"/appliesAt",schemaPath:"#/$defs/SessionAutoMemoryAppliesAt/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "now") || (data2 === "nextStart"))){validate1973.errors = [{instancePath:instancePath+"/appliesAt",schemaPath:"#/$defs/SessionAutoMemoryAppliesAt/enum",keyword:"enum",params:{allowedValues: schema3918.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1973.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1973.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1973.errors = null as any[] | null;
// prettier-ignore
validate1973.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3921: any = {"type":"object","additionalProperties":false,"properties":{"boundPercent":{"type":"number","minimum":0,"maximum":100,"description":"The bound, in percent of the window."},"topStopPercent":{"type":"number","minimum":0,"maximum":100,"description":"The slider's top stop."},"bottomStopPercent":{"type":["number","null"],"minimum":0,"maximum":100,"description":"The slider's bottom stop, `null` until it is known."},"sessionOverride":{"type":"boolean","description":"Whether the bound differs from the Settings default."}},"required":["boundPercent","topStopPercent","bottomStopPercent","sessionOverride"],"description":"Where the session compacts and the slider's range. The top stop is the provider's own compaction\npoint on this window; the bottom stop is the session's fixed start plus a tenth of the window,\nrounded up, and is `null` where the provider reports what the session loads only with its first\nusage report, until that report comes.\n`sessionOverride` draws the `session` mark: the bound differs from the Settings default."};
// prettier-ignore
const schema3925: any = {"description":"How the provider marks a bucket: counted as used, deferred (dimmed and left out of the used\nfigure), the compaction buffer, or free space.","type":"string","enum":["used","deferred","buffer","free"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1977(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1977.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.name === undefined) && (missing0 = "name")) || ((data.tokens === undefined) && (missing0 = "tokens"))) || ((data.kind === undefined) && (missing0 = "kind"))){validate1977.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "name") || (key0 === "tokens")) || (key0 === "kind")) || (key0 === "parts"))){validate1977.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate1977.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1977.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tokens !== undefined){let data1: any = data.tokens;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1977.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1977.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1977.errors = [{instancePath:instancePath+"/tokens",schemaPath:"#/properties/tokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){let data2: any = data.kind;const _errs6: any = errors;if(typeof data2 !== "string"){validate1977.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionContextCategoryKind/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data2 === "used") || (data2 === "deferred")) || (data2 === "buffer")) || (data2 === "free"))){validate1977.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionContextCategoryKind/enum",keyword:"enum",params:{allowedValues: schema3925.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.parts !== undefined){let data3: any = data.parts;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data3)){var valid2: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){let data4: any = data3[i0];const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){let missing1: any;if(((data4.name === undefined) && (missing1 = "name")) || ((data4.tokens === undefined) && (missing1 = "tokens"))){validate1977.errors = [{instancePath:instancePath+"/parts/" + i0,schemaPath:"#/$defs/SessionContextPart/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data4){if(!((key1 === "name") || (key1 === "tokens"))){validate1977.errors = [{instancePath:instancePath+"/parts/" + i0,schemaPath:"#/$defs/SessionContextPart/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data4.name !== undefined){let data5: any = data4.name;const _errs15: any = errors;if(errors === _errs15){if(typeof data5 === "string"){if(func1(data5) < 1){validate1977.errors = [{instancePath:instancePath+"/parts/" + i0+"/name",schemaPath:"#/$defs/SessionContextPart/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1977.errors = [{instancePath:instancePath+"/parts/" + i0+"/name",schemaPath:"#/$defs/SessionContextPart/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data4.tokens !== undefined){let data6: any = data4.tokens;const _errs17: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1977.errors = [{instancePath:instancePath+"/parts/" + i0+"/tokens",schemaPath:"#/$defs/SessionContextPart/properties/tokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate1977.errors = [{instancePath:instancePath+"/parts/" + i0+"/tokens",schemaPath:"#/$defs/SessionContextPart/properties/tokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate1977.errors = [{instancePath:instancePath+"/parts/" + i0+"/tokens",schemaPath:"#/$defs/SessionContextPart/properties/tokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}}}}}else {validate1977.errors = [{instancePath:instancePath+"/parts/" + i0,schemaPath:"#/$defs/SessionContextPart/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs11 === errors;if(!valid2){break;}}}else {validate1977.errors = [{instancePath:instancePath+"/parts",schemaPath:"#/properties/parts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}else {validate1977.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1977.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1977.errors = null as any[] | null;
// prettier-ignore
validate1977.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1976(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1976.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1976.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "buckets"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.categories === undefined) && (missing0 = "categories"))){validate1976.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((((key1 === "kind") || (key1 === "categories")) || (key1 === "cachedInputTokens")) || (key1 === "inputTokens")) || (key1 === "outputTokens")) || (key1 === "reasoningTokens"))){validate1976.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate1976.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("buckets" !== data0){validate1976.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "buckets"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.categories !== undefined){let data1: any = data.categories;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data1)){var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs10: any = errors;if(!(validate1977.call(this, data1[i0], {instancePath:instancePath+"/categories/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1977.errors : vErrors.concat(validate1977.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;if(!valid3){break;}}}else {validate1976.errors = [{instancePath:instancePath+"/categories",schemaPath:"#/oneOf/0/properties/categories/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.cachedInputTokens !== undefined){const _errs11: any = errors;validate1976.errors = [{instancePath:instancePath+"/cachedInputTokens",schemaPath:"#/oneOf/0/properties/cachedInputTokens/not",keyword:"not",params:{}}];return false;var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.inputTokens !== undefined){const _errs14: any = errors;validate1976.errors = [{instancePath:instancePath+"/inputTokens",schemaPath:"#/oneOf/0/properties/inputTokens/not",keyword:"not",params:{}}];return false;var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.outputTokens !== undefined){const _errs17: any = errors;validate1976.errors = [{instancePath:instancePath+"/outputTokens",schemaPath:"#/oneOf/0/properties/outputTokens/not",keyword:"not",params:{}}];return false;var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.reasoningTokens !== undefined){const _errs20: any = errors;validate1976.errors = [{instancePath:instancePath+"/reasoningTokens",schemaPath:"#/oneOf/0/properties/reasoningTokens/not",keyword:"not",params:{}}];return false;var valid2: any = _errs20 === errors;}else {var valid2: any = true;}}}}}}}}}else {validate1976.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "totals"){const _errs23: any = errors;if(errors === _errs23){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.kind === undefined) && (missing1 = "kind")) || ((data.cachedInputTokens === undefined) && (missing1 = "cachedInputTokens"))) || ((data.inputTokens === undefined) && (missing1 = "inputTokens"))) || ((data.outputTokens === undefined) && (missing1 = "outputTokens"))) || ((data.reasoningTokens === undefined) && (missing1 = "reasoningTokens"))){validate1976.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs25: any = errors;for(const key2 in data){if(!((((((key2 === "kind") || (key2 === "categories")) || (key2 === "cachedInputTokens")) || (key2 === "inputTokens")) || (key2 === "outputTokens")) || (key2 === "reasoningTokens"))){validate1976.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs25 === errors){if(data.kind !== undefined){let data7: any = data.kind;const _errs26: any = errors;if(typeof data7 !== "string"){validate1976.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("totals" !== data7){validate1976.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "totals"}}];return false;}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data.categories !== undefined){const _errs28: any = errors;validate1976.errors = [{instancePath:instancePath+"/categories",schemaPath:"#/oneOf/1/properties/categories/not",keyword:"not",params:{}}];return false;var valid5: any = _errs28 === errors;}else {var valid5: any = true;}if(valid5){if(data.cachedInputTokens !== undefined){let data9: any = data.cachedInputTokens;const _errs31: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate1976.errors = [{instancePath:instancePath+"/cachedInputTokens",schemaPath:"#/oneOf/1/properties/cachedInputTokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs31){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate1976.errors = [{instancePath:instancePath+"/cachedInputTokens",schemaPath:"#/oneOf/1/properties/cachedInputTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate1976.errors = [{instancePath:instancePath+"/cachedInputTokens",schemaPath:"#/oneOf/1/properties/cachedInputTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs31 === errors;}else {var valid5: any = true;}if(valid5){if(data.inputTokens !== undefined){let data10: any = data.inputTokens;const _errs33: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate1976.errors = [{instancePath:instancePath+"/inputTokens",schemaPath:"#/oneOf/1/properties/inputTokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs33){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate1976.errors = [{instancePath:instancePath+"/inputTokens",schemaPath:"#/oneOf/1/properties/inputTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate1976.errors = [{instancePath:instancePath+"/inputTokens",schemaPath:"#/oneOf/1/properties/inputTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs33 === errors;}else {var valid5: any = true;}if(valid5){if(data.outputTokens !== undefined){let data11: any = data.outputTokens;const _errs35: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate1976.errors = [{instancePath:instancePath+"/outputTokens",schemaPath:"#/oneOf/1/properties/outputTokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs35){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate1976.errors = [{instancePath:instancePath+"/outputTokens",schemaPath:"#/oneOf/1/properties/outputTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validate1976.errors = [{instancePath:instancePath+"/outputTokens",schemaPath:"#/oneOf/1/properties/outputTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs35 === errors;}else {var valid5: any = true;}if(valid5){if(data.reasoningTokens !== undefined){let data12: any = data.reasoningTokens;const _errs37: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){validate1976.errors = [{instancePath:instancePath+"/reasoningTokens",schemaPath:"#/oneOf/1/properties/reasoningTokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs37){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 9007199254740991 || isNaN(data12)){validate1976.errors = [{instancePath:instancePath+"/reasoningTokens",schemaPath:"#/oneOf/1/properties/reasoningTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data12 < 0 || isNaN(data12)){validate1976.errors = [{instancePath:instancePath+"/reasoningTokens",schemaPath:"#/oneOf/1/properties/reasoningTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs37 === errors;}else {var valid5: any = true;}}}}}}}}}else {validate1976.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1976.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1976.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate1976.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1976.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1976.errors = null as any[] | null;
// prettier-ignore
validate1976.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1975(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1975.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.usedTokens === undefined) && (missing0 = "usedTokens")) || ((data.usedPercent === undefined) && (missing0 = "usedPercent"))) || ((data.breakdown === undefined) && (missing0 = "breakdown"))){validate1975.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "usedTokens") || (key0 === "usedPercent")) || (key0 === "breakdown"))){validate1975.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.usedTokens !== undefined){let data0: any = data.usedTokens;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1975.errors = [{instancePath:instancePath+"/usedTokens",schemaPath:"#/properties/usedTokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1975.errors = [{instancePath:instancePath+"/usedTokens",schemaPath:"#/properties/usedTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1975.errors = [{instancePath:instancePath+"/usedTokens",schemaPath:"#/properties/usedTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.usedPercent !== undefined){let data1: any = data.usedPercent;const _errs4: any = errors;if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 100 || isNaN(data1)){validate1975.errors = [{instancePath:instancePath+"/usedPercent",schemaPath:"#/properties/usedPercent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate1975.errors = [{instancePath:instancePath+"/usedPercent",schemaPath:"#/properties/usedPercent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}else {validate1975.errors = [{instancePath:instancePath+"/usedPercent",schemaPath:"#/properties/usedPercent/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.breakdown !== undefined){const _errs6: any = errors;if(!(validate1976.call(this, data.breakdown, {instancePath:instancePath+"/breakdown",parentData:data,parentDataProperty:"breakdown",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1976.errors : vErrors.concat(validate1976.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1975.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1975.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1975.errors = null as any[] | null;
// prettier-ignore
validate1975.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1974(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionContextReading {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1974.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.windowTokens === undefined) && (missing0 = "windowTokens"))) || ((data.compaction === undefined) && (missing0 = "compaction"))) || ((data.usage === undefined) && (missing0 = "usage"))){validate1974.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "windowTokens")) || (key0 === "compaction")) || (key0 === "usage"))){validate1974.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1974.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1974.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.windowTokens !== undefined){let data1: any = data.windowTokens;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate1974.errors = [{instancePath:instancePath+"/windowTokens",schemaPath:"#/properties/windowTokens/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate1974.errors = [{instancePath:instancePath+"/windowTokens",schemaPath:"#/properties/windowTokens/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate1974.errors = [{instancePath:instancePath+"/windowTokens",schemaPath:"#/properties/windowTokens/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.compaction !== undefined){let data2: any = data.compaction;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((((data2.boundPercent === undefined) && (missing1 = "boundPercent")) || ((data2.topStopPercent === undefined) && (missing1 = "topStopPercent"))) || ((data2.bottomStopPercent === undefined) && (missing1 = "bottomStopPercent"))) || ((data2.sessionOverride === undefined) && (missing1 = "sessionOverride"))){validate1974.errors = [{instancePath:instancePath+"/compaction",schemaPath:"#/$defs/SessionCompactionBound/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data2){if(!((((key1 === "boundPercent") || (key1 === "topStopPercent")) || (key1 === "bottomStopPercent")) || (key1 === "sessionOverride"))){validate1974.errors = [{instancePath:instancePath+"/compaction",schemaPath:"#/$defs/SessionCompactionBound/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data2.boundPercent !== undefined){let data3: any = data2.boundPercent;const _errs12: any = errors;if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 100 || isNaN(data3)){validate1974.errors = [{instancePath:instancePath+"/compaction/boundPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/boundPercent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1974.errors = [{instancePath:instancePath+"/compaction/boundPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/boundPercent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}else {validate1974.errors = [{instancePath:instancePath+"/compaction/boundPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/boundPercent/type",keyword:"type",params:{type: "number"}}];return false;}}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data2.topStopPercent !== undefined){let data4: any = data2.topStopPercent;const _errs14: any = errors;if(errors === _errs14){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 100 || isNaN(data4)){validate1974.errors = [{instancePath:instancePath+"/compaction/topStopPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/topStopPercent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate1974.errors = [{instancePath:instancePath+"/compaction/topStopPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/topStopPercent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}else {validate1974.errors = [{instancePath:instancePath+"/compaction/topStopPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/topStopPercent/type",keyword:"type",params:{type: "number"}}];return false;}}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data2.bottomStopPercent !== undefined){let data5: any = data2.bottomStopPercent;const _errs16: any = errors;if((!((typeof data5 == "number") && (isFinite(data5)))) && (data5 !== null)){validate1974.errors = [{instancePath:instancePath+"/compaction/bottomStopPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/bottomStopPercent/type",keyword:"type",params:{type: schema3921.properties.bottomStopPercent.type}}];return false;}if(errors === _errs16){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 100 || isNaN(data5)){validate1974.errors = [{instancePath:instancePath+"/compaction/bottomStopPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/bottomStopPercent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate1974.errors = [{instancePath:instancePath+"/compaction/bottomStopPercent",schemaPath:"#/$defs/SessionCompactionBound/properties/bottomStopPercent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}if(valid3){if(data2.sessionOverride !== undefined){const _errs18: any = errors;if(typeof data2.sessionOverride !== "boolean"){validate1974.errors = [{instancePath:instancePath+"/compaction/sessionOverride",schemaPath:"#/$defs/SessionCompactionBound/properties/sessionOverride/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid3: any = _errs18 === errors;}else {var valid3: any = true;}}}}}}}else {validate1974.errors = [{instancePath:instancePath+"/compaction",schemaPath:"#/$defs/SessionCompactionBound/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.usage !== undefined){let data7: any = data.usage;const _errs20: any = errors;const _errs21: any = errors;let valid4: any = false;const _errs22: any = errors;if(!(validate1975.call(this, data7, {instancePath:instancePath+"/usage",parentData:data,parentDataProperty:"usage",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1975.errors : vErrors.concat(validate1975.errors);errors = vErrors.length;}var _valid0: any = _errs22 === errors;valid4 = valid4 || _valid0;const _errs23: any = errors;if(data7 !== null){const err0: any = {instancePath:instancePath+"/usage",schemaPath:"#/properties/usage/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs23 === errors;valid4 = valid4 || _valid0;if(!valid4){const err1: any = {instancePath:instancePath+"/usage",schemaPath:"#/properties/usage/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate1974.errors = vErrors;return false;}else {errors = _errs21;if(vErrors !== null){if(_errs21){vErrors.length = _errs21;}else {vErrors = null;}}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}}}}}}}else {validate1974.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1974.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1974.errors = null as any[] | null;
// prettier-ignore
validate1974.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3935: any = {"type":"object","additionalProperties":false,"properties":{"event":{"type":"string","minLength":1,"description":"The event it runs on."},"matcher":{"type":"string","pattern":"^[^\\x00]*$","description":"Its matcher, empty where it has none."},"source":{"type":"string","minLength":1,"description":"Where it came from, in the provider's words."},"pluginName":{"type":"string","minLength":1,"description":"The plugin it came with, where a plugin brought it."},"type":{"type":"string","minLength":1,"description":"What it runs, in the provider's words."},"commandText":{"type":"string","minLength":1,"description":"The command, prompt or address it runs."},"statusMessage":{"type":"string","minLength":1,"description":"The line the provider shows while it runs, where it has one."},"timeoutSeconds":{"type":"number","exclusiveMinimum":0,"description":"Its time limit, in seconds, where it sets one; a fraction is allowed."},"disabled":{"type":"boolean","description":"Whether the session's mode or policy keeps it from running."},"sourcePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The settings file it was read from, where it was read from one."}},"required":["event","matcher","source","type","commandText","disabled"],"description":"One hook in a listing grouped by event, as the provider lists it. `event`, `matcher`, `source`,\n`type` and `commandText` are the provider's own words, carried as sent."};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const schema3931: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"handlerType":{"type":"string","const":"command"},"key":{"type":"string","minLength":1,"description":"The provider's key for the hook."},"event":{"type":"string","minLength":1,"description":"The event it runs on."},"matcher":{"type":"string","pattern":"^[^\\x00]*$","description":"Its matcher, where it has one."},"timeoutSeconds":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Its time limit, in seconds."},"statusMessage":{"type":"string","minLength":1,"description":"The line the provider shows while it runs, where it has one."},"sourcePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file it was read from."},"source":{"type":"string","minLength":1,"description":"Where it came from, in the provider's words."},"pluginId":{"type":"string","minLength":1,"description":"The plugin it came with, where a plugin brought it."},"enabled":{"type":"boolean","description":"Whether it is enabled."},"managed":{"type":"boolean","description":"Whether managed settings hold it."},"hash":{"type":"string","minLength":1,"description":"The provider's hash of it."},"trustStatus":{"type":"string","minLength":1,"description":"Its trust status, in the provider's words."},"command":{"type":"string","minLength":1,"description":"The command it runs."},"async":{"type":"boolean","description":"Whether it runs without holding up the event."},"server":{"not":{},"tsType":"never","description":"Never present: only a tool server's hook names a server."},"tool":{"not":{},"tsType":"never","description":"Never present: only a tool server's hook names a tool."}},"required":["handlerType","key","event","timeoutSeconds","sourcePath","source","enabled","managed","hash","trustStatus","command","async"],"description":"A command."},{"type":"object","additionalProperties":false,"properties":{"handlerType":{"type":"string","const":"mcpTool"},"key":{"type":"string","minLength":1,"description":"The provider's key for the hook."},"event":{"type":"string","minLength":1,"description":"The event it runs on."},"matcher":{"type":"string","pattern":"^[^\\x00]*$","description":"Its matcher, where it has one."},"timeoutSeconds":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Its time limit, in seconds."},"statusMessage":{"type":"string","minLength":1,"description":"The line the provider shows while it runs, where it has one."},"sourcePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file it was read from."},"source":{"type":"string","minLength":1,"description":"Where it came from, in the provider's words."},"pluginId":{"type":"string","minLength":1,"description":"The plugin it came with, where a plugin brought it."},"enabled":{"type":"boolean","description":"Whether it is enabled."},"managed":{"type":"boolean","description":"Whether managed settings hold it."},"hash":{"type":"string","minLength":1,"description":"The provider's hash of it."},"trustStatus":{"type":"string","minLength":1,"description":"Its trust status, in the provider's words."},"command":{"not":{},"tsType":"never","description":"Never present: only a command hook runs a command."},"async":{"not":{},"tsType":"never","description":"Never present: only a command hook runs without holding up the event."},"server":{"type":"string","minLength":1,"description":"The tool server."},"tool":{"type":"string","minLength":1,"description":"The tool it calls."}},"required":["handlerType","key","event","timeoutSeconds","sourcePath","source","enabled","managed","hash","trustStatus","server","tool"],"description":"A tool server's tool."},{"type":"object","additionalProperties":false,"properties":{"handlerType":{"type":"string","const":"prompt"},"key":{"type":"string","minLength":1,"description":"The provider's key for the hook."},"event":{"type":"string","minLength":1,"description":"The event it runs on."},"matcher":{"type":"string","pattern":"^[^\\x00]*$","description":"Its matcher, where it has one."},"timeoutSeconds":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Its time limit, in seconds."},"statusMessage":{"type":"string","minLength":1,"description":"The line the provider shows while it runs, where it has one."},"sourcePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file it was read from."},"source":{"type":"string","minLength":1,"description":"Where it came from, in the provider's words."},"pluginId":{"type":"string","minLength":1,"description":"The plugin it came with, where a plugin brought it."},"enabled":{"type":"boolean","description":"Whether it is enabled."},"managed":{"type":"boolean","description":"Whether managed settings hold it."},"hash":{"type":"string","minLength":1,"description":"The provider's hash of it."},"trustStatus":{"type":"string","minLength":1,"description":"Its trust status, in the provider's words."},"command":{"not":{},"tsType":"never","description":"Never present: only a command hook runs a command."},"async":{"not":{},"tsType":"never","description":"Never present: only a command hook runs without holding up the event."},"server":{"not":{},"tsType":"never","description":"Never present: only a tool server's hook names a server."},"tool":{"not":{},"tsType":"never","description":"Never present: only a tool server's hook names a tool."}},"required":["handlerType","key","event","timeoutSeconds","sourcePath","source","enabled","managed","hash","trustStatus"],"description":"A prompt."},{"type":"object","additionalProperties":false,"properties":{"handlerType":{"type":"string","const":"agent"},"key":{"type":"string","minLength":1,"description":"The provider's key for the hook."},"event":{"type":"string","minLength":1,"description":"The event it runs on."},"matcher":{"type":"string","pattern":"^[^\\x00]*$","description":"Its matcher, where it has one."},"timeoutSeconds":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Its time limit, in seconds."},"statusMessage":{"type":"string","minLength":1,"description":"The line the provider shows while it runs, where it has one."},"sourcePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file it was read from."},"source":{"type":"string","minLength":1,"description":"Where it came from, in the provider's words."},"pluginId":{"type":"string","minLength":1,"description":"The plugin it came with, where a plugin brought it."},"enabled":{"type":"boolean","description":"Whether it is enabled."},"managed":{"type":"boolean","description":"Whether managed settings hold it."},"hash":{"type":"string","minLength":1,"description":"The provider's hash of it."},"trustStatus":{"type":"string","minLength":1,"description":"Its trust status, in the provider's words."},"command":{"not":{},"tsType":"never","description":"Never present: only a command hook runs a command."},"async":{"not":{},"tsType":"never","description":"Never present: only a command hook runs without holding up the event."},"server":{"not":{},"tsType":"never","description":"Never present: only a tool server's hook names a server."},"tool":{"not":{},"tsType":"never","description":"Never present: only a tool server's hook names a tool."}},"required":["handlerType","key","event","timeoutSeconds","sourcePath","source","enabled","managed","hash","trustStatus"],"description":"An agent."}],"description":"One hook the provider loaded for a folder, tagged on what it runs. `event`, `matcher`,\n`source` and `trustStatus` are the provider's own words, carried as sent.","discriminator":{"propertyName":"handlerType"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate1982(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1982.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.folder === undefined) && (missing0 = "folder")) || ((data.hooks === undefined) && (missing0 = "hooks"))) || ((data.errors === undefined) && (missing0 = "errors"))) || ((data.warnings === undefined) && (missing0 = "warnings"))){validate1982.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "folder") || (key0 === "hooks")) || (key0 === "errors")) || (key0 === "warnings"))){validate1982.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1982.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1982.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1982.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1982.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.hooks !== undefined){let data1: any = data.hooks;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){const _errs10: any = errors;for(const key1 in data2){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key1}}];return false;break;}if(_errs10 === errors){const tag0: any = data2.handlerType;if(typeof tag0 == "string"){if(tag0 === "command"){const _errs11: any = errors;if(errors === _errs11){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((((((((((((data2.handlerType === undefined) && (missing1 = "handlerType")) || ((data2.key === undefined) && (missing1 = "key"))) || ((data2.event === undefined) && (missing1 = "event"))) || ((data2.timeoutSeconds === undefined) && (missing1 = "timeoutSeconds"))) || ((data2.sourcePath === undefined) && (missing1 = "sourcePath"))) || ((data2.source === undefined) && (missing1 = "source"))) || ((data2.enabled === undefined) && (missing1 = "enabled"))) || ((data2.managed === undefined) && (missing1 = "managed"))) || ((data2.hash === undefined) && (missing1 = "hash"))) || ((data2.trustStatus === undefined) && (missing1 = "trustStatus"))) || ((data2.command === undefined) && (missing1 = "command"))) || ((data2.async === undefined) && (missing1 = "async"))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key2 in data2){if(!(func2.call(schema3931.oneOf[0].properties, key2))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs13 === errors){if(data2.handlerType !== undefined){let data3: any = data2.handlerType;const _errs14: any = errors;if(typeof data3 !== "string"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/handlerType/type",keyword:"type",params:{type: "string"}}];return false;}if("command" !== data3){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/handlerType/const",keyword:"const",params:{allowedValue: "command"}}];return false;}var valid5: any = _errs14 === errors;}else {var valid5: any = true;}if(valid5){if(data2.key !== undefined){let data4: any = data2.key;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/key/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/key/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs16 === errors;}else {var valid5: any = true;}if(valid5){if(data2.event !== undefined){let data5: any = data2.event;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/event/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/event/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data2.matcher !== undefined){let data6: any = data2.matcher;const _errs20: any = errors;if(errors === _errs20){if(typeof data6 === "string"){if(!pattern43.test(data6)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/matcher/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/matcher/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}if(valid5){if(data2.timeoutSeconds !== undefined){let data7: any = data2.timeoutSeconds;const _errs22: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/timeoutSeconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs22){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/timeoutSeconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/timeoutSeconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}if(valid5){if(data2.statusMessage !== undefined){let data8: any = data2.statusMessage;const _errs24: any = errors;if(errors === _errs24){if(typeof data8 === "string"){if(func1(data8) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/statusMessage/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/statusMessage/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs24 === errors;}else {var valid5: any = true;}if(valid5){if(data2.sourcePath !== undefined){let data9: any = data2.sourcePath;const _errs26: any = errors;if(errors === _errs26){if(typeof data9 === "string"){if(func1(data9) > 4096){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/sourcePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data9) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/sourcePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data9)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/sourcePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/sourcePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data2.source !== undefined){let data10: any = data2.source;const _errs28: any = errors;if(errors === _errs28){if(typeof data10 === "string"){if(func1(data10) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs28 === errors;}else {var valid5: any = true;}if(valid5){if(data2.pluginId !== undefined){let data11: any = data2.pluginId;const _errs30: any = errors;if(errors === _errs30){if(typeof data11 === "string"){if(func1(data11) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/pluginId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/pluginId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs30 === errors;}else {var valid5: any = true;}if(valid5){if(data2.enabled !== undefined){const _errs32: any = errors;if(typeof data2.enabled !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/enabled",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid5: any = _errs32 === errors;}else {var valid5: any = true;}if(valid5){if(data2.managed !== undefined){const _errs34: any = errors;if(typeof data2.managed !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/managed",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/managed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid5: any = _errs34 === errors;}else {var valid5: any = true;}if(valid5){if(data2.hash !== undefined){let data14: any = data2.hash;const _errs36: any = errors;if(errors === _errs36){if(typeof data14 === "string"){if(func1(data14) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/hash/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/hash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs36 === errors;}else {var valid5: any = true;}if(valid5){if(data2.trustStatus !== undefined){let data15: any = data2.trustStatus;const _errs38: any = errors;if(errors === _errs38){if(typeof data15 === "string"){if(func1(data15) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/trustStatus/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/trustStatus/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs38 === errors;}else {var valid5: any = true;}if(valid5){if(data2.command !== undefined){let data16: any = data2.command;const _errs40: any = errors;if(errors === _errs40){if(typeof data16 === "string"){if(func1(data16) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/command",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/command/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/command",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/command/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs40 === errors;}else {var valid5: any = true;}if(valid5){if(data2.async !== undefined){const _errs42: any = errors;if(typeof data2.async !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/async",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/async/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid5: any = _errs42 === errors;}else {var valid5: any = true;}if(valid5){if(data2.server !== undefined){const _errs44: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/server",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/server/not",keyword:"not",params:{}}];return false;var valid5: any = _errs44 === errors;}else {var valid5: any = true;}if(valid5){if(data2.tool !== undefined){const _errs47: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/tool",schemaPath:"#/$defs/SessionProviderHook/oneOf/0/properties/tool/not",keyword:"not",params:{}}];return false;var valid5: any = _errs47 === errors;}else {var valid5: any = true;}}}}}}}}}}}}}}}}}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "mcpTool"){const _errs50: any = errors;if(errors === _errs50){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing2: any;if(((((((((((((data2.handlerType === undefined) && (missing2 = "handlerType")) || ((data2.key === undefined) && (missing2 = "key"))) || ((data2.event === undefined) && (missing2 = "event"))) || ((data2.timeoutSeconds === undefined) && (missing2 = "timeoutSeconds"))) || ((data2.sourcePath === undefined) && (missing2 = "sourcePath"))) || ((data2.source === undefined) && (missing2 = "source"))) || ((data2.enabled === undefined) && (missing2 = "enabled"))) || ((data2.managed === undefined) && (missing2 = "managed"))) || ((data2.hash === undefined) && (missing2 = "hash"))) || ((data2.trustStatus === undefined) && (missing2 = "trustStatus"))) || ((data2.server === undefined) && (missing2 = "server"))) || ((data2.tool === undefined) && (missing2 = "tool"))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs52: any = errors;for(const key3 in data2){if(!(func2.call(schema3931.oneOf[1].properties, key3))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs52 === errors){if(data2.handlerType !== undefined){let data20: any = data2.handlerType;const _errs53: any = errors;if(typeof data20 !== "string"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/handlerType/type",keyword:"type",params:{type: "string"}}];return false;}if("mcpTool" !== data20){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/handlerType/const",keyword:"const",params:{allowedValue: "mcpTool"}}];return false;}var valid7: any = _errs53 === errors;}else {var valid7: any = true;}if(valid7){if(data2.key !== undefined){let data21: any = data2.key;const _errs55: any = errors;if(errors === _errs55){if(typeof data21 === "string"){if(func1(data21) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/key/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/key/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs55 === errors;}else {var valid7: any = true;}if(valid7){if(data2.event !== undefined){let data22: any = data2.event;const _errs57: any = errors;if(errors === _errs57){if(typeof data22 === "string"){if(func1(data22) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/event/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/event/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs57 === errors;}else {var valid7: any = true;}if(valid7){if(data2.matcher !== undefined){let data23: any = data2.matcher;const _errs59: any = errors;if(errors === _errs59){if(typeof data23 === "string"){if(!pattern43.test(data23)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/matcher/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/matcher/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs59 === errors;}else {var valid7: any = true;}if(valid7){if(data2.timeoutSeconds !== undefined){let data24: any = data2.timeoutSeconds;const _errs61: any = errors;if(!(((typeof data24 == "number") && (!(data24 % 1) && !isNaN(data24))) && (isFinite(data24)))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/timeoutSeconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs61){if((typeof data24 == "number") && (isFinite(data24))){if(data24 > 9007199254740991 || isNaN(data24)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/timeoutSeconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data24 < 0 || isNaN(data24)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/timeoutSeconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs61 === errors;}else {var valid7: any = true;}if(valid7){if(data2.statusMessage !== undefined){let data25: any = data2.statusMessage;const _errs63: any = errors;if(errors === _errs63){if(typeof data25 === "string"){if(func1(data25) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/statusMessage/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/statusMessage/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs63 === errors;}else {var valid7: any = true;}if(valid7){if(data2.sourcePath !== undefined){let data26: any = data2.sourcePath;const _errs65: any = errors;if(errors === _errs65){if(typeof data26 === "string"){if(func1(data26) > 4096){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/sourcePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data26) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/sourcePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data26)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/sourcePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/sourcePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs65 === errors;}else {var valid7: any = true;}if(valid7){if(data2.source !== undefined){let data27: any = data2.source;const _errs67: any = errors;if(errors === _errs67){if(typeof data27 === "string"){if(func1(data27) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs67 === errors;}else {var valid7: any = true;}if(valid7){if(data2.pluginId !== undefined){let data28: any = data2.pluginId;const _errs69: any = errors;if(errors === _errs69){if(typeof data28 === "string"){if(func1(data28) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/pluginId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/pluginId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs69 === errors;}else {var valid7: any = true;}if(valid7){if(data2.enabled !== undefined){const _errs71: any = errors;if(typeof data2.enabled !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/enabled",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid7: any = _errs71 === errors;}else {var valid7: any = true;}if(valid7){if(data2.managed !== undefined){const _errs73: any = errors;if(typeof data2.managed !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/managed",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/managed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid7: any = _errs73 === errors;}else {var valid7: any = true;}if(valid7){if(data2.hash !== undefined){let data31: any = data2.hash;const _errs75: any = errors;if(errors === _errs75){if(typeof data31 === "string"){if(func1(data31) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/hash/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/hash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs75 === errors;}else {var valid7: any = true;}if(valid7){if(data2.trustStatus !== undefined){let data32: any = data2.trustStatus;const _errs77: any = errors;if(errors === _errs77){if(typeof data32 === "string"){if(func1(data32) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/trustStatus/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/trustStatus/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs77 === errors;}else {var valid7: any = true;}if(valid7){if(data2.command !== undefined){const _errs79: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/command",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/command/not",keyword:"not",params:{}}];return false;var valid7: any = _errs79 === errors;}else {var valid7: any = true;}if(valid7){if(data2.async !== undefined){const _errs82: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/async",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/async/not",keyword:"not",params:{}}];return false;var valid7: any = _errs82 === errors;}else {var valid7: any = true;}if(valid7){if(data2.server !== undefined){let data35: any = data2.server;const _errs85: any = errors;if(errors === _errs85){if(typeof data35 === "string"){if(func1(data35) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/server",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/server/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/server",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/server/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs85 === errors;}else {var valid7: any = true;}if(valid7){if(data2.tool !== undefined){let data36: any = data2.tool;const _errs87: any = errors;if(errors === _errs87){if(typeof data36 === "string"){if(func1(data36) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/tool",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/tool/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/tool",schemaPath:"#/$defs/SessionProviderHook/oneOf/1/properties/tool/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs87 === errors;}else {var valid7: any = true;}}}}}}}}}}}}}}}}}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "prompt"){const _errs89: any = errors;if(errors === _errs89){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing3: any;if(((((((((((data2.handlerType === undefined) && (missing3 = "handlerType")) || ((data2.key === undefined) && (missing3 = "key"))) || ((data2.event === undefined) && (missing3 = "event"))) || ((data2.timeoutSeconds === undefined) && (missing3 = "timeoutSeconds"))) || ((data2.sourcePath === undefined) && (missing3 = "sourcePath"))) || ((data2.source === undefined) && (missing3 = "source"))) || ((data2.enabled === undefined) && (missing3 = "enabled"))) || ((data2.managed === undefined) && (missing3 = "managed"))) || ((data2.hash === undefined) && (missing3 = "hash"))) || ((data2.trustStatus === undefined) && (missing3 = "trustStatus"))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs91: any = errors;for(const key4 in data2){if(!(func2.call(schema3931.oneOf[2].properties, key4))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs91 === errors){if(data2.handlerType !== undefined){let data37: any = data2.handlerType;const _errs92: any = errors;if(typeof data37 !== "string"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/handlerType/type",keyword:"type",params:{type: "string"}}];return false;}if("prompt" !== data37){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/handlerType/const",keyword:"const",params:{allowedValue: "prompt"}}];return false;}var valid9: any = _errs92 === errors;}else {var valid9: any = true;}if(valid9){if(data2.key !== undefined){let data38: any = data2.key;const _errs94: any = errors;if(errors === _errs94){if(typeof data38 === "string"){if(func1(data38) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/key/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/key/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs94 === errors;}else {var valid9: any = true;}if(valid9){if(data2.event !== undefined){let data39: any = data2.event;const _errs96: any = errors;if(errors === _errs96){if(typeof data39 === "string"){if(func1(data39) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/event/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/event/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs96 === errors;}else {var valid9: any = true;}if(valid9){if(data2.matcher !== undefined){let data40: any = data2.matcher;const _errs98: any = errors;if(errors === _errs98){if(typeof data40 === "string"){if(!pattern43.test(data40)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/matcher/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/matcher/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs98 === errors;}else {var valid9: any = true;}if(valid9){if(data2.timeoutSeconds !== undefined){let data41: any = data2.timeoutSeconds;const _errs100: any = errors;if(!(((typeof data41 == "number") && (!(data41 % 1) && !isNaN(data41))) && (isFinite(data41)))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/timeoutSeconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs100){if((typeof data41 == "number") && (isFinite(data41))){if(data41 > 9007199254740991 || isNaN(data41)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/timeoutSeconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data41 < 0 || isNaN(data41)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/timeoutSeconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid9: any = _errs100 === errors;}else {var valid9: any = true;}if(valid9){if(data2.statusMessage !== undefined){let data42: any = data2.statusMessage;const _errs102: any = errors;if(errors === _errs102){if(typeof data42 === "string"){if(func1(data42) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/statusMessage/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/statusMessage/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs102 === errors;}else {var valid9: any = true;}if(valid9){if(data2.sourcePath !== undefined){let data43: any = data2.sourcePath;const _errs104: any = errors;if(errors === _errs104){if(typeof data43 === "string"){if(func1(data43) > 4096){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/sourcePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data43) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/sourcePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data43)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/sourcePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/sourcePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs104 === errors;}else {var valid9: any = true;}if(valid9){if(data2.source !== undefined){let data44: any = data2.source;const _errs106: any = errors;if(errors === _errs106){if(typeof data44 === "string"){if(func1(data44) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs106 === errors;}else {var valid9: any = true;}if(valid9){if(data2.pluginId !== undefined){let data45: any = data2.pluginId;const _errs108: any = errors;if(errors === _errs108){if(typeof data45 === "string"){if(func1(data45) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/pluginId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/pluginId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs108 === errors;}else {var valid9: any = true;}if(valid9){if(data2.enabled !== undefined){const _errs110: any = errors;if(typeof data2.enabled !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/enabled",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid9: any = _errs110 === errors;}else {var valid9: any = true;}if(valid9){if(data2.managed !== undefined){const _errs112: any = errors;if(typeof data2.managed !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/managed",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/managed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid9: any = _errs112 === errors;}else {var valid9: any = true;}if(valid9){if(data2.hash !== undefined){let data48: any = data2.hash;const _errs114: any = errors;if(errors === _errs114){if(typeof data48 === "string"){if(func1(data48) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/hash/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/hash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs114 === errors;}else {var valid9: any = true;}if(valid9){if(data2.trustStatus !== undefined){let data49: any = data2.trustStatus;const _errs116: any = errors;if(errors === _errs116){if(typeof data49 === "string"){if(func1(data49) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/trustStatus/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/trustStatus/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs116 === errors;}else {var valid9: any = true;}if(valid9){if(data2.command !== undefined){const _errs118: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/command",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/command/not",keyword:"not",params:{}}];return false;var valid9: any = _errs118 === errors;}else {var valid9: any = true;}if(valid9){if(data2.async !== undefined){const _errs121: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/async",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/async/not",keyword:"not",params:{}}];return false;var valid9: any = _errs121 === errors;}else {var valid9: any = true;}if(valid9){if(data2.server !== undefined){const _errs124: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/server",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/server/not",keyword:"not",params:{}}];return false;var valid9: any = _errs124 === errors;}else {var valid9: any = true;}if(valid9){if(data2.tool !== undefined){const _errs127: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/tool",schemaPath:"#/$defs/SessionProviderHook/oneOf/2/properties/tool/not",keyword:"not",params:{}}];return false;var valid9: any = _errs127 === errors;}else {var valid9: any = true;}}}}}}}}}}}}}}}}}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "agent"){const _errs130: any = errors;if(errors === _errs130){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing4: any;if(((((((((((data2.handlerType === undefined) && (missing4 = "handlerType")) || ((data2.key === undefined) && (missing4 = "key"))) || ((data2.event === undefined) && (missing4 = "event"))) || ((data2.timeoutSeconds === undefined) && (missing4 = "timeoutSeconds"))) || ((data2.sourcePath === undefined) && (missing4 = "sourcePath"))) || ((data2.source === undefined) && (missing4 = "source"))) || ((data2.enabled === undefined) && (missing4 = "enabled"))) || ((data2.managed === undefined) && (missing4 = "managed"))) || ((data2.hash === undefined) && (missing4 = "hash"))) || ((data2.trustStatus === undefined) && (missing4 = "trustStatus"))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs132: any = errors;for(const key5 in data2){if(!(func2.call(schema3931.oneOf[3].properties, key5))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs132 === errors){if(data2.handlerType !== undefined){let data54: any = data2.handlerType;const _errs133: any = errors;if(typeof data54 !== "string"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/handlerType/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data54){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/handlerType",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/handlerType/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid11: any = _errs133 === errors;}else {var valid11: any = true;}if(valid11){if(data2.key !== undefined){let data55: any = data2.key;const _errs135: any = errors;if(errors === _errs135){if(typeof data55 === "string"){if(func1(data55) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/key/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/key",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/key/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs135 === errors;}else {var valid11: any = true;}if(valid11){if(data2.event !== undefined){let data56: any = data2.event;const _errs137: any = errors;if(errors === _errs137){if(typeof data56 === "string"){if(func1(data56) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/event/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/event",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/event/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs137 === errors;}else {var valid11: any = true;}if(valid11){if(data2.matcher !== undefined){let data57: any = data2.matcher;const _errs139: any = errors;if(errors === _errs139){if(typeof data57 === "string"){if(!pattern43.test(data57)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/matcher/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/matcher",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/matcher/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs139 === errors;}else {var valid11: any = true;}if(valid11){if(data2.timeoutSeconds !== undefined){let data58: any = data2.timeoutSeconds;const _errs141: any = errors;if(!(((typeof data58 == "number") && (!(data58 % 1) && !isNaN(data58))) && (isFinite(data58)))){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/timeoutSeconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs141){if((typeof data58 == "number") && (isFinite(data58))){if(data58 > 9007199254740991 || isNaN(data58)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/timeoutSeconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data58 < 0 || isNaN(data58)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/timeoutSeconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid11: any = _errs141 === errors;}else {var valid11: any = true;}if(valid11){if(data2.statusMessage !== undefined){let data59: any = data2.statusMessage;const _errs143: any = errors;if(errors === _errs143){if(typeof data59 === "string"){if(func1(data59) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/statusMessage/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/statusMessage",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/statusMessage/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs143 === errors;}else {var valid11: any = true;}if(valid11){if(data2.sourcePath !== undefined){let data60: any = data2.sourcePath;const _errs145: any = errors;if(errors === _errs145){if(typeof data60 === "string"){if(func1(data60) > 4096){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/sourcePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data60) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/sourcePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data60)){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/sourcePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/sourcePath",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/sourcePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs145 === errors;}else {var valid11: any = true;}if(valid11){if(data2.source !== undefined){let data61: any = data2.source;const _errs147: any = errors;if(errors === _errs147){if(typeof data61 === "string"){if(func1(data61) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/source",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs147 === errors;}else {var valid11: any = true;}if(valid11){if(data2.pluginId !== undefined){let data62: any = data2.pluginId;const _errs149: any = errors;if(errors === _errs149){if(typeof data62 === "string"){if(func1(data62) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/pluginId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/pluginId",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/pluginId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs149 === errors;}else {var valid11: any = true;}if(valid11){if(data2.enabled !== undefined){const _errs151: any = errors;if(typeof data2.enabled !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/enabled",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid11: any = _errs151 === errors;}else {var valid11: any = true;}if(valid11){if(data2.managed !== undefined){const _errs153: any = errors;if(typeof data2.managed !== "boolean"){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/managed",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/managed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid11: any = _errs153 === errors;}else {var valid11: any = true;}if(valid11){if(data2.hash !== undefined){let data65: any = data2.hash;const _errs155: any = errors;if(errors === _errs155){if(typeof data65 === "string"){if(func1(data65) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/hash/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/hash",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/hash/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs155 === errors;}else {var valid11: any = true;}if(valid11){if(data2.trustStatus !== undefined){let data66: any = data2.trustStatus;const _errs157: any = errors;if(errors === _errs157){if(typeof data66 === "string"){if(func1(data66) < 1){validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/trustStatus/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/trustStatus",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/trustStatus/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs157 === errors;}else {var valid11: any = true;}if(valid11){if(data2.command !== undefined){const _errs159: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/command",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/command/not",keyword:"not",params:{}}];return false;var valid11: any = _errs159 === errors;}else {var valid11: any = true;}if(valid11){if(data2.async !== undefined){const _errs162: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/async",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/async/not",keyword:"not",params:{}}];return false;var valid11: any = _errs162 === errors;}else {var valid11: any = true;}if(valid11){if(data2.server !== undefined){const _errs165: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/server",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/server/not",keyword:"not",params:{}}];return false;var valid11: any = _errs165 === errors;}else {var valid11: any = true;}if(valid11){if(data2.tool !== undefined){const _errs168: any = errors;validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0+"/tool",schemaPath:"#/$defs/SessionProviderHook/oneOf/3/properties/tool/not",keyword:"not",params:{}}];return false;var valid11: any = _errs168 === errors;}else {var valid11: any = true;}}}}}}}}}}}}}}}}}}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "handlerType", tagValue: tag0}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/discriminator",keyword:"discriminator",params:{error: "tag", tag: "handlerType", tagValue: tag0}}];return false;}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks/" + i0,schemaPath:"#/$defs/SessionProviderHook/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validate1982.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/properties/hooks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.errors !== undefined){let data71: any = data.errors;const _errs171: any = errors;if(errors === _errs171){if(Array.isArray(data71)){var valid12: any = true;const len1: any = data71.length;for(let i1=0; i1<len1; i1++){let data72: any = data71[i1];const _errs173: any = errors;const _errs174: any = errors;if(errors === _errs174){if(data72 && typeof data72 == "object" && !Array.isArray(data72)){let missing5: any;if(((data72.path === undefined) && (missing5 = "path")) || ((data72.message === undefined) && (missing5 = "message"))){validate1982.errors = [{instancePath:instancePath+"/errors/" + i1,schemaPath:"#/$defs/ProviderHookError/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs176: any = errors;for(const key6 in data72){if(!((key6 === "path") || (key6 === "message"))){validate1982.errors = [{instancePath:instancePath+"/errors/" + i1,schemaPath:"#/$defs/ProviderHookError/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs176 === errors){if(data72.path !== undefined){let data73: any = data72.path;const _errs177: any = errors;if(errors === _errs177){if(typeof data73 === "string"){if(func1(data73) > 4096){validate1982.errors = [{instancePath:instancePath+"/errors/" + i1+"/path",schemaPath:"#/$defs/ProviderHookError/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data73) < 1){validate1982.errors = [{instancePath:instancePath+"/errors/" + i1+"/path",schemaPath:"#/$defs/ProviderHookError/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data73)){validate1982.errors = [{instancePath:instancePath+"/errors/" + i1+"/path",schemaPath:"#/$defs/ProviderHookError/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1982.errors = [{instancePath:instancePath+"/errors/" + i1+"/path",schemaPath:"#/$defs/ProviderHookError/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs177 === errors;}else {var valid14: any = true;}if(valid14){if(data72.message !== undefined){let data74: any = data72.message;const _errs179: any = errors;if(errors === _errs179){if(typeof data74 === "string"){if(func1(data74) < 1){validate1982.errors = [{instancePath:instancePath+"/errors/" + i1+"/message",schemaPath:"#/$defs/ProviderHookError/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/errors/" + i1+"/message",schemaPath:"#/$defs/ProviderHookError/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs179 === errors;}else {var valid14: any = true;}}}}}else {validate1982.errors = [{instancePath:instancePath+"/errors/" + i1,schemaPath:"#/$defs/ProviderHookError/type",keyword:"type",params:{type: "object"}}];return false;}}var valid12: any = _errs173 === errors;if(!valid12){break;}}}else {validate1982.errors = [{instancePath:instancePath+"/errors",schemaPath:"#/properties/errors/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs171 === errors;}else {var valid0: any = true;}if(valid0){if(data.warnings !== undefined){let data75: any = data.warnings;const _errs181: any = errors;if(errors === _errs181){if(Array.isArray(data75)){var valid15: any = true;const len2: any = data75.length;for(let i2=0; i2<len2; i2++){let data76: any = data75[i2];const _errs183: any = errors;if(errors === _errs183){if(typeof data76 === "string"){if(func1(data76) < 1){validate1982.errors = [{instancePath:instancePath+"/warnings/" + i2,schemaPath:"#/properties/warnings/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1982.errors = [{instancePath:instancePath+"/warnings/" + i2,schemaPath:"#/properties/warnings/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs183 === errors;if(!valid15){break;}}}else {validate1982.errors = [{instancePath:instancePath+"/warnings",schemaPath:"#/properties/warnings/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs181 === errors;}else {var valid0: any = true;}}}}}}}else {validate1982.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1982.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1982.errors = null as any[] | null;
// prettier-ignore
validate1982.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1981(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionHookListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1981.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1981.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "byFolder"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.folders === undefined) && (missing0 = "folders"))){validate1981.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((((((key1 === "kind") || (key1 === "sessionId")) || (key1 === "provider")) || (key1 === "folders")) || (key1 === "hooks")) || (key1 === "errors")) || (key1 === "policy"))){validate1981.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate1981.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("byFolder" !== data0){validate1981.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "byFolder"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1981.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.provider !== undefined){let data2: any = data.provider;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(!pattern16.test(data2)){validate1981.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.folders !== undefined){let data3: any = data.folders;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data3)){var valid5: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs18: any = errors;if(!(validate1982.call(this, data3[i0], {instancePath:instancePath+"/folders/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1982.errors : vErrors.concat(validate1982.errors);errors = vErrors.length;}var valid5: any = _errs18 === errors;if(!valid5){break;}}}else {validate1981.errors = [{instancePath:instancePath+"/folders",schemaPath:"#/oneOf/0/properties/folders/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.hooks !== undefined){const _errs19: any = errors;validate1981.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/oneOf/0/properties/hooks/not",keyword:"not",params:{}}];return false;var valid2: any = _errs19 === errors;}else {var valid2: any = true;}if(valid2){if(data.errors !== undefined){const _errs22: any = errors;validate1981.errors = [{instancePath:instancePath+"/errors",schemaPath:"#/oneOf/0/properties/errors/not",keyword:"not",params:{}}];return false;var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.policy !== undefined){const _errs25: any = errors;validate1981.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/oneOf/0/properties/policy/not",keyword:"not",params:{}}];return false;var valid2: any = _errs25 === errors;}else {var valid2: any = true;}}}}}}}}}}else {validate1981.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "byEvent"){const _errs28: any = errors;if(errors === _errs28){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.provider === undefined) && (missing1 = "provider"))) || ((data.hooks === undefined) && (missing1 = "hooks"))) || ((data.errors === undefined) && (missing1 = "errors"))) || ((data.policy === undefined) && (missing1 = "policy"))){validate1981.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs30: any = errors;for(const key2 in data){if(!(((((((key2 === "kind") || (key2 === "sessionId")) || (key2 === "provider")) || (key2 === "folders")) || (key2 === "hooks")) || (key2 === "errors")) || (key2 === "policy"))){validate1981.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs30 === errors){if(data.kind !== undefined){let data8: any = data.kind;const _errs31: any = errors;if(typeof data8 !== "string"){validate1981.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("byEvent" !== data8){validate1981.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "byEvent"}}];return false;}var valid7: any = _errs31 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data9: any = data.sessionId;const _errs33: any = errors;const _errs34: any = errors;if(errors === _errs34){if(typeof data9 === "string"){if(!pattern4.test(data9)){validate1981.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs33 === errors;}else {var valid7: any = true;}if(valid7){if(data.provider !== undefined){let data10: any = data.provider;const _errs37: any = errors;const _errs38: any = errors;if(errors === _errs38){if(typeof data10 === "string"){if(!pattern16.test(data10)){validate1981.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs37 === errors;}else {var valid7: any = true;}if(valid7){if(data.folders !== undefined){const _errs41: any = errors;validate1981.errors = [{instancePath:instancePath+"/folders",schemaPath:"#/oneOf/1/properties/folders/not",keyword:"not",params:{}}];return false;var valid7: any = _errs41 === errors;}else {var valid7: any = true;}if(valid7){if(data.hooks !== undefined){let data12: any = data.hooks;const _errs44: any = errors;if(errors === _errs44){if(Array.isArray(data12)){var valid10: any = true;const len1: any = data12.length;for(let i1=0; i1<len1; i1++){let data13: any = data12[i1];const _errs46: any = errors;const _errs47: any = errors;if(errors === _errs47){if(data13 && typeof data13 == "object" && !Array.isArray(data13)){let missing2: any;if(((((((data13.event === undefined) && (missing2 = "event")) || ((data13.matcher === undefined) && (missing2 = "matcher"))) || ((data13.source === undefined) && (missing2 = "source"))) || ((data13.type === undefined) && (missing2 = "type"))) || ((data13.commandText === undefined) && (missing2 = "commandText"))) || ((data13.disabled === undefined) && (missing2 = "disabled"))){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1,schemaPath:"#/$defs/SessionProviderEventHook/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs49: any = errors;for(const key3 in data13){if(!(func2.call(schema3935.properties, key3))){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1,schemaPath:"#/$defs/SessionProviderEventHook/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs49 === errors){if(data13.event !== undefined){let data14: any = data13.event;const _errs50: any = errors;if(errors === _errs50){if(typeof data14 === "string"){if(func1(data14) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/event",schemaPath:"#/$defs/SessionProviderEventHook/properties/event/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/event",schemaPath:"#/$defs/SessionProviderEventHook/properties/event/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs50 === errors;}else {var valid12: any = true;}if(valid12){if(data13.matcher !== undefined){let data15: any = data13.matcher;const _errs52: any = errors;if(errors === _errs52){if(typeof data15 === "string"){if(!pattern43.test(data15)){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/matcher",schemaPath:"#/$defs/SessionProviderEventHook/properties/matcher/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/matcher",schemaPath:"#/$defs/SessionProviderEventHook/properties/matcher/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs52 === errors;}else {var valid12: any = true;}if(valid12){if(data13.source !== undefined){let data16: any = data13.source;const _errs54: any = errors;if(errors === _errs54){if(typeof data16 === "string"){if(func1(data16) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/source",schemaPath:"#/$defs/SessionProviderEventHook/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/source",schemaPath:"#/$defs/SessionProviderEventHook/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs54 === errors;}else {var valid12: any = true;}if(valid12){if(data13.pluginName !== undefined){let data17: any = data13.pluginName;const _errs56: any = errors;if(errors === _errs56){if(typeof data17 === "string"){if(func1(data17) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/pluginName",schemaPath:"#/$defs/SessionProviderEventHook/properties/pluginName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/pluginName",schemaPath:"#/$defs/SessionProviderEventHook/properties/pluginName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs56 === errors;}else {var valid12: any = true;}if(valid12){if(data13.type !== undefined){let data18: any = data13.type;const _errs58: any = errors;if(errors === _errs58){if(typeof data18 === "string"){if(func1(data18) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/type",schemaPath:"#/$defs/SessionProviderEventHook/properties/type/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/type",schemaPath:"#/$defs/SessionProviderEventHook/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs58 === errors;}else {var valid12: any = true;}if(valid12){if(data13.commandText !== undefined){let data19: any = data13.commandText;const _errs60: any = errors;if(errors === _errs60){if(typeof data19 === "string"){if(func1(data19) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/commandText",schemaPath:"#/$defs/SessionProviderEventHook/properties/commandText/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/commandText",schemaPath:"#/$defs/SessionProviderEventHook/properties/commandText/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs60 === errors;}else {var valid12: any = true;}if(valid12){if(data13.statusMessage !== undefined){let data20: any = data13.statusMessage;const _errs62: any = errors;if(errors === _errs62){if(typeof data20 === "string"){if(func1(data20) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/statusMessage",schemaPath:"#/$defs/SessionProviderEventHook/properties/statusMessage/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/statusMessage",schemaPath:"#/$defs/SessionProviderEventHook/properties/statusMessage/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs62 === errors;}else {var valid12: any = true;}if(valid12){if(data13.timeoutSeconds !== undefined){let data21: any = data13.timeoutSeconds;const _errs64: any = errors;if(errors === _errs64){if((typeof data21 == "number") && (isFinite(data21))){if(data21 <= 0 || isNaN(data21)){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderEventHook/properties/timeoutSeconds/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/timeoutSeconds",schemaPath:"#/$defs/SessionProviderEventHook/properties/timeoutSeconds/type",keyword:"type",params:{type: "number"}}];return false;}}var valid12: any = _errs64 === errors;}else {var valid12: any = true;}if(valid12){if(data13.disabled !== undefined){const _errs66: any = errors;if(typeof data13.disabled !== "boolean"){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/disabled",schemaPath:"#/$defs/SessionProviderEventHook/properties/disabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid12: any = _errs66 === errors;}else {var valid12: any = true;}if(valid12){if(data13.sourcePath !== undefined){let data23: any = data13.sourcePath;const _errs68: any = errors;if(errors === _errs68){if(typeof data23 === "string"){if(func1(data23) > 4096){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/sourcePath",schemaPath:"#/$defs/SessionProviderEventHook/properties/sourcePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data23) < 1){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/sourcePath",schemaPath:"#/$defs/SessionProviderEventHook/properties/sourcePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data23)){validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/sourcePath",schemaPath:"#/$defs/SessionProviderEventHook/properties/sourcePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1+"/sourcePath",schemaPath:"#/$defs/SessionProviderEventHook/properties/sourcePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs68 === errors;}else {var valid12: any = true;}}}}}}}}}}}}}else {validate1981.errors = [{instancePath:instancePath+"/hooks/" + i1,schemaPath:"#/$defs/SessionProviderEventHook/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs46 === errors;if(!valid10){break;}}}else {validate1981.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/oneOf/1/properties/hooks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid7: any = _errs44 === errors;}else {var valid7: any = true;}if(valid7){if(data.errors !== undefined){let data24: any = data.errors;const _errs70: any = errors;if(errors === _errs70){if(Array.isArray(data24)){var valid13: any = true;const len2: any = data24.length;for(let i2=0; i2<len2; i2++){let data25: any = data24[i2];const _errs72: any = errors;const _errs73: any = errors;if(errors === _errs73){if(data25 && typeof data25 == "object" && !Array.isArray(data25)){let missing3: any;if(((data25.path === undefined) && (missing3 = "path")) || ((data25.message === undefined) && (missing3 = "message"))){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2,schemaPath:"#/$defs/ProviderHookSettingsError/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs75: any = errors;for(const key4 in data25){if(!(((key4 === "file") || (key4 === "path")) || (key4 === "message"))){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2,schemaPath:"#/$defs/ProviderHookSettingsError/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs75 === errors){if(data25.file !== undefined){let data26: any = data25.file;const _errs76: any = errors;if(errors === _errs76){if(typeof data26 === "string"){if(func1(data26) > 4096){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/file",schemaPath:"#/$defs/ProviderHookSettingsError/properties/file/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data26) < 1){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/file",schemaPath:"#/$defs/ProviderHookSettingsError/properties/file/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data26)){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/file",schemaPath:"#/$defs/ProviderHookSettingsError/properties/file/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/file",schemaPath:"#/$defs/ProviderHookSettingsError/properties/file/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs76 === errors;}else {var valid15: any = true;}if(valid15){if(data25.path !== undefined){let data27: any = data25.path;const _errs78: any = errors;if(errors === _errs78){if(typeof data27 === "string"){if(!pattern43.test(data27)){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/path",schemaPath:"#/$defs/ProviderHookSettingsError/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/path",schemaPath:"#/$defs/ProviderHookSettingsError/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs78 === errors;}else {var valid15: any = true;}if(valid15){if(data25.message !== undefined){let data28: any = data25.message;const _errs80: any = errors;if(errors === _errs80){if(typeof data28 === "string"){if(func1(data28) < 1){validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/message",schemaPath:"#/$defs/ProviderHookSettingsError/properties/message/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/errors/" + i2+"/message",schemaPath:"#/$defs/ProviderHookSettingsError/properties/message/type",keyword:"type",params:{type: "string"}}];return false;}}var valid15: any = _errs80 === errors;}else {var valid15: any = true;}}}}}}else {validate1981.errors = [{instancePath:instancePath+"/errors/" + i2,schemaPath:"#/$defs/ProviderHookSettingsError/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs72 === errors;if(!valid13){break;}}}else {validate1981.errors = [{instancePath:instancePath+"/errors",schemaPath:"#/oneOf/1/properties/errors/type",keyword:"type",params:{type: "array"}}];return false;}}var valid7: any = _errs70 === errors;}else {var valid7: any = true;}if(valid7){if(data.policy !== undefined){let data29: any = data.policy;const _errs82: any = errors;const _errs83: any = errors;if(errors === _errs83){if(data29 && typeof data29 == "object" && !Array.isArray(data29)){let missing4: any;if(((((((data29.disabledByPolicy === undefined) && (missing4 = "disabledByPolicy")) || ((data29.managedOnly === undefined) && (missing4 = "managedOnly"))) || ((data29.pluginOnly === undefined) && (missing4 = "pluginOnly"))) || ((data29.allDisabled === undefined) && (missing4 = "allDisabled"))) || ((data29.policyHookCount === undefined) && (missing4 = "policyHookCount"))) || ((data29.policyUnreadable === undefined) && (missing4 = "policyUnreadable"))){validate1981.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ProviderHookPolicy/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs85: any = errors;for(const key5 in data29){if(!((((((key5 === "disabledByPolicy") || (key5 === "managedOnly")) || (key5 === "pluginOnly")) || (key5 === "allDisabled")) || (key5 === "policyHookCount")) || (key5 === "policyUnreadable"))){validate1981.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ProviderHookPolicy/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs85 === errors){if(data29.disabledByPolicy !== undefined){const _errs86: any = errors;if(typeof data29.disabledByPolicy !== "boolean"){validate1981.errors = [{instancePath:instancePath+"/policy/disabledByPolicy",schemaPath:"#/$defs/ProviderHookPolicy/properties/disabledByPolicy/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs86 === errors;}else {var valid17: any = true;}if(valid17){if(data29.managedOnly !== undefined){const _errs88: any = errors;if(typeof data29.managedOnly !== "boolean"){validate1981.errors = [{instancePath:instancePath+"/policy/managedOnly",schemaPath:"#/$defs/ProviderHookPolicy/properties/managedOnly/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs88 === errors;}else {var valid17: any = true;}if(valid17){if(data29.pluginOnly !== undefined){const _errs90: any = errors;if(typeof data29.pluginOnly !== "boolean"){validate1981.errors = [{instancePath:instancePath+"/policy/pluginOnly",schemaPath:"#/$defs/ProviderHookPolicy/properties/pluginOnly/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs90 === errors;}else {var valid17: any = true;}if(valid17){if(data29.allDisabled !== undefined){const _errs92: any = errors;if(typeof data29.allDisabled !== "boolean"){validate1981.errors = [{instancePath:instancePath+"/policy/allDisabled",schemaPath:"#/$defs/ProviderHookPolicy/properties/allDisabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs92 === errors;}else {var valid17: any = true;}if(valid17){if(data29.policyHookCount !== undefined){let data34: any = data29.policyHookCount;const _errs94: any = errors;if(!(((typeof data34 == "number") && (!(data34 % 1) && !isNaN(data34))) && (isFinite(data34)))){validate1981.errors = [{instancePath:instancePath+"/policy/policyHookCount",schemaPath:"#/$defs/ProviderHookPolicy/properties/policyHookCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs94){if((typeof data34 == "number") && (isFinite(data34))){if(data34 > 9007199254740991 || isNaN(data34)){validate1981.errors = [{instancePath:instancePath+"/policy/policyHookCount",schemaPath:"#/$defs/ProviderHookPolicy/properties/policyHookCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data34 < 0 || isNaN(data34)){validate1981.errors = [{instancePath:instancePath+"/policy/policyHookCount",schemaPath:"#/$defs/ProviderHookPolicy/properties/policyHookCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid17: any = _errs94 === errors;}else {var valid17: any = true;}if(valid17){if(data29.policyUnreadable !== undefined){const _errs96: any = errors;if(typeof data29.policyUnreadable !== "boolean"){validate1981.errors = [{instancePath:instancePath+"/policy/policyUnreadable",schemaPath:"#/$defs/ProviderHookPolicy/properties/policyUnreadable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid17: any = _errs96 === errors;}else {var valid17: any = true;}}}}}}}}}else {validate1981.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ProviderHookPolicy/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs82 === errors;}else {var valid7: any = true;}}}}}}}}}}else {validate1981.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "listedAtNextStart"){const _errs98: any = errors;if(errors === _errs98){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((((data.kind === undefined) && (missing5 = "kind")) || ((data.sessionId === undefined) && (missing5 = "sessionId"))) || ((data.provider === undefined) && (missing5 = "provider"))){validate1981.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs100: any = errors;for(const key6 in data){if(!(((((((key6 === "kind") || (key6 === "sessionId")) || (key6 === "provider")) || (key6 === "folders")) || (key6 === "hooks")) || (key6 === "errors")) || (key6 === "policy"))){validate1981.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs100 === errors){if(data.kind !== undefined){let data36: any = data.kind;const _errs101: any = errors;if(typeof data36 !== "string"){validate1981.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("listedAtNextStart" !== data36){validate1981.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "listedAtNextStart"}}];return false;}var valid19: any = _errs101 === errors;}else {var valid19: any = true;}if(valid19){if(data.sessionId !== undefined){let data37: any = data.sessionId;const _errs103: any = errors;const _errs104: any = errors;if(errors === _errs104){if(typeof data37 === "string"){if(!pattern4.test(data37)){validate1981.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid19: any = _errs103 === errors;}else {var valid19: any = true;}if(valid19){if(data.provider !== undefined){let data38: any = data.provider;const _errs107: any = errors;const _errs108: any = errors;if(errors === _errs108){if(typeof data38 === "string"){if(!pattern16.test(data38)){validate1981.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1981.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid19: any = _errs107 === errors;}else {var valid19: any = true;}if(valid19){if(data.folders !== undefined){const _errs111: any = errors;validate1981.errors = [{instancePath:instancePath+"/folders",schemaPath:"#/oneOf/2/properties/folders/not",keyword:"not",params:{}}];return false;var valid19: any = _errs111 === errors;}else {var valid19: any = true;}if(valid19){if(data.hooks !== undefined){const _errs114: any = errors;validate1981.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/oneOf/2/properties/hooks/not",keyword:"not",params:{}}];return false;var valid19: any = _errs114 === errors;}else {var valid19: any = true;}if(valid19){if(data.errors !== undefined){const _errs117: any = errors;validate1981.errors = [{instancePath:instancePath+"/errors",schemaPath:"#/oneOf/2/properties/errors/not",keyword:"not",params:{}}];return false;var valid19: any = _errs117 === errors;}else {var valid19: any = true;}if(valid19){if(data.policy !== undefined){const _errs120: any = errors;validate1981.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/oneOf/2/properties/policy/not",keyword:"not",params:{}}];return false;var valid19: any = _errs120 === errors;}else {var valid19: any = true;}}}}}}}}}}else {validate1981.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1981.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1981.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate1981.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1981.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1981.errors = null as any[] | null;
// prettier-ignore
validate1981.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3942: any = {"description":"Whether the store is shared across the provider's accounts.","type":"string","enum":["account","sharedAcrossAccounts"]};
// prettier-ignore
const schema3945: any = {"description":"Whether a memory path is a file or a folder.","type":"string","enum":["file","folder"]};
// prettier-ignore
function validate1985(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1985.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.kind === undefined) && (missing0 = "kind"))){validate1985.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "kind"))){validate1985.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1985.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1985.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1985.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1985.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){let data1: any = data.kind;const _errs4: any = errors;if(typeof data1 !== "string"){validate1985.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionMemoryEntryKind/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "file") || (data1 === "folder"))){validate1985.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionMemoryEntryKind/enum",keyword:"enum",params:{allowedValues: schema3945.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate1985.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1985.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1985.errors = null as any[] | null;
// prettier-ignore
validate1985.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1984(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMemoryReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1984.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.home === undefined) && (missing0 = "home"))) || ((data.homeScope === undefined) && (missing0 = "homeScope"))) || ((data.autoMemory === undefined) && (missing0 = "autoMemory"))) || ((data.entries === undefined) && (missing0 = "entries"))) || ((data.listedAtNextStart === undefined) && (missing0 = "listedAtNextStart"))){validate1984.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "home")) || (key0 === "homeScope")) || (key0 === "autoMemory")) || (key0 === "entries")) || (key0 === "listedAtNextStart"))){validate1984.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1984.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1984.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.home !== undefined){let data1: any = data.home;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1984.errors = [{instancePath:instancePath+"/home",schemaPath:"#/properties/home/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1984.errors = [{instancePath:instancePath+"/home",schemaPath:"#/properties/home/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1984.errors = [{instancePath:instancePath+"/home",schemaPath:"#/properties/home/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1984.errors = [{instancePath:instancePath+"/home",schemaPath:"#/properties/home/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.homeScope !== undefined){let data2: any = data.homeScope;const _errs8: any = errors;if(typeof data2 !== "string"){validate1984.errors = [{instancePath:instancePath+"/homeScope",schemaPath:"#/$defs/SessionMemoryHomeScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "account") || (data2 === "sharedAcrossAccounts"))){validate1984.errors = [{instancePath:instancePath+"/homeScope",schemaPath:"#/$defs/SessionMemoryHomeScope/enum",keyword:"enum",params:{allowedValues: schema3942.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.autoMemory !== undefined){let data3: any = data.autoMemory;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if((data3.enabled === undefined) && (missing1 = "enabled")){validate1984.errors = [{instancePath:instancePath+"/autoMemory",schemaPath:"#/$defs/SessionAutoMemory/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data3){if(!((key1 === "enabled") || (key1 === "enabledAtNextStart"))){validate1984.errors = [{instancePath:instancePath+"/autoMemory",schemaPath:"#/$defs/SessionAutoMemory/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data3.enabled !== undefined){const _errs15: any = errors;if(typeof data3.enabled !== "boolean"){validate1984.errors = [{instancePath:instancePath+"/autoMemory/enabled",schemaPath:"#/$defs/SessionAutoMemory/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data3.enabledAtNextStart !== undefined){const _errs17: any = errors;if(typeof data3.enabledAtNextStart !== "boolean"){validate1984.errors = [{instancePath:instancePath+"/autoMemory/enabledAtNextStart",schemaPath:"#/$defs/SessionAutoMemory/properties/enabledAtNextStart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}}}}}else {validate1984.errors = [{instancePath:instancePath+"/autoMemory",schemaPath:"#/$defs/SessionAutoMemory/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.entries !== undefined){let data6: any = data.entries;const _errs19: any = errors;if(errors === _errs19){if(Array.isArray(data6)){var valid5: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs21: any = errors;if(!(validate1985.call(this, data6[i0], {instancePath:instancePath+"/entries/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1985.errors : vErrors.concat(validate1985.errors);errors = vErrors.length;}var valid5: any = _errs21 === errors;if(!valid5){break;}}}else {validate1984.errors = [{instancePath:instancePath+"/entries",schemaPath:"#/properties/entries/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.listedAtNextStart !== undefined){const _errs22: any = errors;if(typeof data.listedAtNextStart !== "boolean"){validate1984.errors = [{instancePath:instancePath+"/listedAtNextStart",schemaPath:"#/properties/listedAtNextStart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1984.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1984.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1984.errors = null as any[] | null;
// prettier-ignore
validate1984.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionAutoMemoryUpdateRequest}. */
export const validateSessionAutoMemoryUpdateRequest: SchemaCheck<SessionAutoMemoryUpdateRequest> =
  validate1972;
/** Checks that a value is a {@link SessionAutoMemoryUpdateResponse}. */
export const validateSessionAutoMemoryUpdateResponse: SchemaCheck<SessionAutoMemoryUpdateResponse> =
  validate1973;
/** Checks that a value is a {@link SessionContextReading}. */
export const validateSessionContextReading: SchemaCheck<SessionContextReading> = validate1974;
/** Checks that a value is a {@link SessionHookListResponse}. */
export const validateSessionHookListResponse: SchemaCheck<SessionHookListResponse> = validate1981;
/** Checks that a value is a {@link SessionMemoryReadResponse}. */
export const validateSessionMemoryReadResponse: SchemaCheck<SessionMemoryReadResponse> =
  validate1984;

/** The methods of {@link SESSION_INSPECTOR_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionInspectorMethodDescriptors {
  readonly "session.context.subscribe": {
    readonly method: "session.context.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionAddressedRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SessionContextReading>;
  };
  readonly "session.memory.read": {
    readonly method: "session.memory.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionAddressedRequest>;
    readonly responseCheck: SchemaCheck<SessionMemoryReadResponse>;
  };
  readonly "session.autoMemory.update": {
    readonly method: "session.autoMemory.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAutoMemoryUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionAutoMemoryUpdateResponse>;
  };
  readonly "session.hook.list": {
    readonly method: "session.hook.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionAddressedRequest>;
    readonly responseCheck: SchemaCheck<SessionHookListResponse>;
  };
}
/** The inspector methods' wire contract: name, procedure type and types. */
export const SESSION_INSPECTOR_METHOD_DESCRIPTORS: SessionInspectorMethodDescriptors =
  Object.freeze({
    "session.context.subscribe": Object.freeze({
      method: "session.context.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateSessionAddressedRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateSessionContextReading,
    }),
    "session.memory.read": Object.freeze({
      method: "session.memory.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateSessionAddressedRequest,
      responseCheck: validateSessionMemoryReadResponse,
    }),
    "session.autoMemory.update": Object.freeze({
      method: "session.autoMemory.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionAutoMemoryUpdateRequest,
      responseCheck: validateSessionAutoMemoryUpdateResponse,
    }),
    "session.hook.list": Object.freeze({
      method: "session.hook.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateSessionAddressedRequest,
      responseCheck: validateSessionHookListResponse,
    }),
  });
