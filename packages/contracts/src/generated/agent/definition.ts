// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Saved agents: the definition registry, the binding that says which provider runs an agent, and the requests and refusals of the definition verbs.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { WslPlace } from "../place.js";
import type { ProjectId } from "../project.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { ProviderOptionSetting } from "../provider/declaration.js";
import type { ProviderId } from "../provider/id.js";

/** The longest reason text a refusal or a load failure carries. */
export const AGENT_REASON_MAX_LEN = 1024 as const;

/** A definition that exists but cannot produce a runnable agent now. */
export const AGENT_DEFINITION_RESOLUTION_REFUSED_CODE =
  "agent.definition.resolutionRefused" as const;

/** The agent hue wheel's twelve steps by token name, in wheel order. */
export const AGENT_ACCENT_HUES = [
  "hue00",
  "hue01",
  "hue02",
  "hue03",
  "hue04",
  "hue05",
  "hue06",
  "hue07",
  "hue08",
  "hue09",
  "hue10",
  "hue11",
] as const;

/**
 * A saved definition's daemon-minted id, never its name, so a rename orphans no stored
 * reference.
 */
export type AgentDefinitionId = string & { readonly __brand: "AgentDefinitionId" };
/**
 * A live agent's daemon-minted id: the lead of a session, or an agent it reached.
 */
export type AgentId = string & { readonly __brand: "AgentId" };
/**
 * A binding as the list serves it: `providerName` where the file names a provider a registered
 * driver answers, or `unsupportedProviderName`, the name the file gave, where none does.
 */
export type AgentListedProviderBinding =
  | {
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * Only a provider no registered driver answers is named as the file gave it.
       */
      unsupportedProviderName?: never;
      /**
       * The model.
       */
      modelId: string;
      /**
       * The account, or `null` to follow the provider's current account.
       */
      providerAccountId: ProviderAccountId | null;
      /**
       * The effort, or `null` for the driver's default.
       */
      effort: string | null;
      /**
       * The speed; a saved definition leaves it absent.
       */
      outputSpeed?: string;
      /**
       * The session option values; a saved definition leaves them absent.
       *
       * @minItems 1
       */
      options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
      /**
       * The larger window chosen, in tokens.
       */
      largerWindow?: number;
    }
  | {
      /**
       * A provider a registered driver answers is named by `providerName`.
       */
      providerName?: never;
      /**
       * The provider name the file gave.
       */
      unsupportedProviderName: string;
      /**
       * The model.
       */
      modelId: string;
      /**
       * The account, or `null` to follow the provider's current account.
       */
      providerAccountId: ProviderAccountId | null;
      /**
       * The effort, or `null` for the driver's default.
       */
      effort: string | null;
      /**
       * The speed; a saved definition leaves it absent.
       */
      outputSpeed?: string;
      /**
       * The session option values; a saved definition leaves them absent.
       *
       * @minItems 1
       */
      options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
      /**
       * The larger window chosen, in tokens.
       */
      largerWindow?: number;
    };
/**
 * Where an agent's one memory lives: `user` in the daemon's own agent-memory folder, for every
 * project; `project` in the project's repository; `local` in the project but kept out of the
 * repository. Whichever provider runs the agent reads and writes the same folder.
 */
export type AgentMemoryScope = "user" | "project" | "local";
/**
 * One step of the agent hue wheel.
 */
export type AgentAccentHue =
  | "hue00"
  | "hue01"
  | "hue02"
  | "hue03"
  | "hue04"
  | "hue05"
  | "hue06"
  | "hue07"
  | "hue08"
  | "hue09"
  | "hue10"
  | "hue11";
/**
 * Whether a definition belongs to every project or to one.
 */
export type AgentDefinitionScope = "global" | "project";
/**
 * Which files a definition came from: ours, a provider's own, whose provider the entry names in
 * `originProvider`, or a plugin's, which is read-only.
 */
export type AgentDefinitionOrigin = "ours" | "provider" | "plugin";
/**
 * The code of a definition that cannot resolve to a runnable agent, wherever its refusal is
 * carried: always `agent.definition.resolutionRefused`.
 */
export type AgentDefinitionResolutionRefusedCode = "agent.definition.resolutionRefused";
/**
 * Why a definition that exists cannot produce a runnable agent now. The remedy is the same
 * in every case, edit the definition or repair the account, so one code carries a reason.
 */
export type AgentDefinitionResolutionRefusedDetails =
  | {
      reason: "modelUnavailable";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId;
      /**
       * The provider.
       */
      providerName: ProviderId;
      /**
       * The model, or `null` for none bound.
       */
      modelId: string | null;
    }
  | {
      reason: "effortUnsupported";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId;
      /**
       * The stored effort.
       */
      effort: string;
      /**
       * The model's efforts.
       */
      effortLevels: string[];
    }
  | {
      reason: "accountUnavailable";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId;
      /**
       * The account.
       */
      providerAccountId: ProviderAccountId;
    }
  | {
      reason: "allowlistUnrealizable";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId;
      /**
       * The missing tools, at least one.
       *
       * @minItems 1
       */
      toolNames: [string, ...string[]];
      /**
       * The driver's tools.
       */
      supportedToolNames: string[];
    }
  | {
      reason: "providerUnsupported";
      /**
       * The definition.
       */
      definitionId: AgentDefinitionId;
      /**
       * The provider as the definition's file names it, which may be no provider id.
       */
      unsupportedProviderName: string;
    };
/**
 * Why an update was refused: the definition is a plugin's agent, which is read-only, or a
 * reattach named a record that is not orphaned.
 */
export type AgentDefinitionUpdateRefusedReason = "pluginReadOnly" | "notOrphaned";

/**
 * Which provider runs an agent, on which model, paying from which account, at which effort,
 * speed and session options: one shape for a saved definition's bindings and a running
 * agent's binding.
 */
export interface AgentProviderBinding {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The model.
   */
  modelId: string;
  /**
   * The account, or `null` to follow the provider's current account, resolved at run
   * start; not a foreign key, so a removed account refuses resolution rather than
   * rewriting this.
   */
  providerAccountId: ProviderAccountId | null;
  /**
   * The effort, or `null` for the driver's default; checked when a run resolves.
   */
  effort: string | null;
  /**
   * The output speed, where one was picked; a saved definition leaves it absent.
   */
  outputSpeed?: string;
  /**
   * The values of the session options the driver declares, where any was set; an option
   * left out keeps the provider's own value, and a saved definition leaves it absent.
   *
   * @minItems 1
   */
  options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
  /**
   * The larger window chosen, in tokens, recorded when picked and sent on every resume
   * and turn; absent is the model's default window.
   */
  largerWindow?: number;
}
/**
 * A definition's bindings: the one used when a caller names no driver, and one per further
 * provider. The default is one the resolver may pick, never a fallback the others patch.
 */
export interface AgentDefinitionBindings {
  /**
   * The default binding.
   */
  default: AgentProviderBinding;
  /**
   * One binding per further provider.
   */
  overrides: AgentProviderBinding[];
}
/**
 * A write's bindings: `overrides` may be left out, and is stored as an empty list.
 */
export interface AgentDefinitionBindingsDraft {
  /**
   * The default binding.
   */
  default: AgentProviderBinding;
  /**
   * One binding per further provider.
   */
  overrides?: AgentProviderBinding[];
}
/**
 * A definition's bindings as the list serves them, each provider bound once.
 */
export interface AgentListedBindings {
  /**
   * The default binding.
   */
  default: AgentListedProviderBinding;
  /**
   * One binding per further provider.
   */
  overrides: AgentListedProviderBinding[];
}
/**
 * One matcher's handlers under a hook event, in the canonical hook form each driver translates
 * into its provider's own.
 */
export interface AgentHookGroup {
  /**
   * Which calls the handlers run on; absent runs them on every call.
   */
  matcher?: string;
  /**
   * The handlers, each in the canonical handler form; the daemon checks each when it saves.
   *
   * @minItems 1
   */
  hooks: [
    {
      [k: string]: unknown | undefined;
    },
    ...{
      [k: string]: unknown | undefined;
    }[],
  ];
}
/**
 * An agent's own hooks in the canonical hook form each driver translates: per event name, the matcher groups.
 */
export interface AgentHooks {
  [k: string]: AgentHookGroup[] | undefined;
}
/**
 * One saved definition, as our own agent files hold it.
 */
export interface AgentDefinition {
  /**
   * The definition's id.
   */
  definitionId: AgentDefinitionId;
  /**
   * The name.
   */
  name: string;
  /**
   * The description.
   */
  description: string;
  /**
   * A glyph key from the app's icon set; `null` is the generic agent mark.
   */
  icon: string | null;
  /**
   * One step of the hue wheel; `null` is no chosen hue.
   */
  accentHue: AgentAccentHue | null;
  /**
   * The bindings.
   */
  bindings: AgentDefinitionBindings;
  /**
   * The instructions.
   */
  instructions: string;
  /**
   * The goal, or `null` for none.
   */
  goal: string | null;
  /**
   * `null` is the driver's defaults, `[]` no tools, and a list exactly those, so "I did
   * not choose" never reads as "I chose nothing".
   */
  toolAllowlist: string[] | null;
  /**
   * The turns before the agent is stopped, or `null` for no cap.
   */
  turnCap: number | null;
  /**
   * The agent's own hooks, or `null` for none.
   */
  hooks: {
    [k: string]: AgentHookGroup[] | undefined;
  } | null;
  /**
   * Where its memory lives, or `null` for no memory.
   */
  memoryScope: AgentMemoryScope | null;
  /**
   * When it was created.
   */
  createdAt: WireInstant;
  /**
   * When it last changed.
   */
  updatedAt: WireInstant;
}
/**
 * One definition as the list serves it: the record, where it lives, and its provider facts,
 * none excluding another, since an orphaned record can also carry a load error.
 */
export interface AgentDefinitionListEntry {
  /**
   * The definition's id.
   */
  definitionId: AgentDefinitionId;
  /**
   * The name.
   */
  name: string;
  /**
   * The description.
   */
  description: string;
  /**
   * A glyph key from the app's icon set; `null` is the generic agent mark.
   */
  icon: string | null;
  /**
   * One step of the hue wheel; `null` is no chosen hue.
   */
  accentHue: AgentAccentHue | null;
  /**
   * The bindings.
   */
  bindings: AgentListedBindings;
  /**
   * The instructions.
   */
  instructions: string;
  /**
   * The goal, or `null` for none.
   */
  goal: string | null;
  /**
   * `null` is the driver's defaults, `[]` no tools, and a list exactly those, so "I did
   * not choose" never reads as "I chose nothing".
   */
  toolAllowlist: string[] | null;
  /**
   * The turns before the agent is stopped, or `null` for no cap.
   */
  turnCap: number | null;
  /**
   * The agent's own hooks, or `null` for none.
   */
  hooks: {
    [k: string]: AgentHookGroup[] | undefined;
  } | null;
  /**
   * Where its memory lives, or `null` for no memory.
   */
  memoryScope: AgentMemoryScope | null;
  /**
   * When it was created.
   */
  createdAt: WireInstant;
  /**
   * When it last changed.
   */
  updatedAt: WireInstant;
  /**
   * Which files it came from.
   */
  origin: AgentDefinitionOrigin;
  /**
   * The provider whose own agent files hold it, exactly when `origin` is `provider`.
   */
  originProvider?: ProviderId;
  /**
   * The plugin, exactly on a plugin's agent.
   */
  pluginName?: string;
  /**
   * Every project or one.
   */
  scope: AgentDefinitionScope;
  /**
   * The project, exactly when `scope` is `project`.
   */
  projectId?: ProjectId;
  /**
   * The record's file, or for an orphaned record the last path it was known at; shown,
   * never a capability.
   */
  sourcePath: string;
  /**
   * The WSL 2 distribution the file is in, its path in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * A provider's file was renamed or deleted outside the app; the record keeps its extras
   * until it is reattached or discarded.
   */
  orphaned: boolean;
  /**
   * The provider's own configuration switches the agent off.
   */
  disabledInProvider: boolean;
  /**
   * Why the file failed the daemon's own parse.
   */
  loadError: string | null;
}
/**
 * What a running agent was started with, echoed on whichever reply started it: a record of the
 * start with the resolved binding, never a live view of the definition, which may have moved.
 */
export interface AgentResolvedConfiguration {
  /**
   * The definition the agent came from.
   */
  resolvedFromDefinitionId: AgentDefinitionId;
  /**
   * The binding it resolved to.
   */
  resolvedBinding: AgentProviderBinding;
  /**
   * The definition's chosen hue, which the agent wears for the session's life.
   */
  accentHue: AgentAccentHue | null;
  /**
   * The tool allowlist as applied.
   */
  toolAllowlist: string[] | null;
  /**
   * The instructions as applied.
   */
  instructions: string;
  /**
   * The goal as applied.
   */
  goal: string | null;
}
/**
 * The whole registry and two readings folded per reply and never stored. Each reading is absent
 * as a whole only when its source could not be read, so a card leaves its line out rather than
 * showing zero; a definition never run has no `lastUsedAt` key.
 */
export interface AgentDefinitionListResponse {
  /**
   * The definitions.
   */
  definitions: AgentDefinitionListEntry[];
  /**
   * How many workflow definitions bind each definition.
   */
  workflowUsage?: {
    [k: string]: number | undefined;
  };
  /**
   * When a session run or a workflow run last resolved each definition.
   */
  lastUsedAt?: {
    [k: string]: WireInstant | undefined;
  };
}
/**
 * A new definition. An omitted member is stored as its null state, so a definition never
 * silently pins today's default; `scope` defaults to `global`, and a project scope names its
 * project.
 */
export interface AgentDefinitionCreateRequest {
  /**
   * The name.
   */
  name: string;
  /**
   * The bindings.
   */
  bindings: AgentDefinitionBindingsDraft;
  /**
   * Every project or one; absent is every project.
   */
  scope?: AgentDefinitionScope;
  /**
   * The project, exactly when `scope` is `project`.
   */
  projectId?: ProjectId;
  /**
   * The description.
   */
  description?: string;
  /**
   * A glyph key, or `null` for the generic agent mark.
   */
  icon?: string | null;
  /**
   * A hue, or `null` for none.
   */
  accentHue?: AgentAccentHue | null;
  /**
   * The instructions.
   */
  instructions?: string;
  /**
   * The goal, or `null` for none.
   */
  goal?: string | null;
  /**
   * The tools, or `null` for the driver's defaults.
   */
  toolAllowlist?: string[] | null;
  /**
   * The turn cap, or `null` for none.
   */
  turnCap?: number | null;
  /**
   * The hooks, replacing the stored ones whole, or `null` for none.
   */
  hooks?: {
    [k: string]: AgentHookGroup[] | undefined;
  } | null;
  /**
   * Where its memory lives, or `null` for no memory.
   */
  memoryScope?: AgentMemoryScope | null;
}
/**
 * The created definition, as the list serves it.
 */
export interface AgentDefinitionCreateResponse {
  /**
   * The definition.
   */
  definition: AgentDefinitionListEntry;
}
/**
 * A partial patch: an absent member is unchanged and `null` clears to the inherit state;
 * `bindings` and `hooks` replace the stored value whole. `reattachFilePath` reattaches an
 * orphaned record to a provider's file, the path main's relay put in place of the chooser's
 * token.
 */
export interface AgentDefinitionUpdateRequest {
  /**
   * The definition.
   */
  definitionId: AgentDefinitionId;
  /**
   * The name.
   */
  name?: string;
  /**
   * The bindings, replacing the stored ones whole.
   */
  bindings?: AgentDefinitionBindingsDraft;
  /**
   * The provider's file an orphaned record is reattached to, the path main's relay put in
   * place of the chooser's token.
   */
  reattachFilePath?: string;
  /**
   * The description.
   */
  description?: string;
  /**
   * A glyph key, or `null` for the generic agent mark.
   */
  icon?: string | null;
  /**
   * A hue, or `null` for none.
   */
  accentHue?: AgentAccentHue | null;
  /**
   * The instructions.
   */
  instructions?: string;
  /**
   * The goal, or `null` for none.
   */
  goal?: string | null;
  /**
   * The tools, or `null` for the driver's defaults.
   */
  toolAllowlist?: string[] | null;
  /**
   * The turn cap, or `null` for none.
   */
  turnCap?: number | null;
  /**
   * The hooks, replacing the stored ones whole, or `null` for none.
   */
  hooks?: {
    [k: string]: AgentHookGroup[] | undefined;
  } | null;
  /**
   * Where its memory lives, or `null` for no memory.
   */
  memoryScope?: AgentMemoryScope | null;
}
/**
 * The whole row after the update, so a client never merges its own patch.
 */
export interface AgentDefinitionUpdateResponse {
  /**
   * The definition.
   */
  definition: AgentDefinitionListEntry;
}
/**
 * Deletes a definition: never refused and never cascading. On a provider's own agent the daemon
 * deletes that file and the record beside it in one act; on an orphaned record it discards the
 * record.
 */
export interface AgentDefinitionDeleteRequest {
  /**
   * The definition.
   */
  definitionId: AgentDefinitionId;
}
/**
 * A delete's answer.
 */
export interface AgentDefinitionDeleteResponse {
  /**
   * Always `true`.
   */
  deleted: true;
}
/**
 * Writes the chosen definitions into the folder the person picked, one Markdown file each, every
 * binding with its account left out. An unknown id refuses the whole export.
 */
export interface AgentDefinitionExportRequest {
  /**
   * The definitions, at least one.
   *
   * @minItems 1
   */
  definitionIds: [AgentDefinitionId, ...AgentDefinitionId[]];
  /**
   * The folder, the path main's relay put in place of the chooser's token.
   */
  folder: string;
}
/**
 * How many definition files the export wrote.
 */
export interface AgentDefinitionExportResponse {
  /**
   * The count.
   */
  exportedCount: number;
}
/**
 * Reads the folder the person picked and creates every agent definition in it in one
 * transaction: it only creates, suffixes a colliding name, lands each in the global scope with
 * no account, and lists every other file it skipped.
 */
export interface AgentDefinitionImportRequest {
  /**
   * The folder, the path main's relay put in place of the chooser's token.
   */
  folder: string;
}
/**
 * A file an import skipped.
 */
export interface SkippedImportFile {
  /**
   * The file's name.
   */
  fileName: string;
  /**
   * Why it was skipped.
   */
  reason: "notAnAgentDefinition";
}
/**
 * The created rows under their final names, and each skipped file, listed once.
 */
export interface AgentDefinitionImportResponse {
  /**
   * The created definitions.
   */
  definitions: AgentDefinitionListEntry[];
  /**
   * The skipped files.
   */
  skipped: SkippedImportFile[];
}
/**
 * The operating system's own cause of a failed export write, as it reported it.
 */
export interface AgentDefinitionExportWriteFailedDetails {
  /**
   * The cause.
   */
  cause: string;
}
/**
 * The update refusal's details: the definition and why.
 */
export interface AgentDefinitionUpdateRefusedDetails {
  /**
   * The definition.
   */
  definitionId: AgentDefinitionId;
  /**
   * Why.
   */
  reason: AgentDefinitionUpdateRefusedReason;
}

export {
  validateAgentAccentHue,
  validateAgentDefinitionId,
  validateAgentId,
  validateAgentProviderBinding,
  validateAgentResolvedConfiguration,
} from "../checks/agent/definition.js";
