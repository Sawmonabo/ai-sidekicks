// Saved agents: the definition registry a person builds in the library and the editor, the
// binding that says which provider runs an agent, and the requests and refusals of the
// definition verbs.
//
// A definition is node-local configuration, never session history: no verb here appends an
// event. The list reads four origins (ours under `.ai-sidekicks/agents/`, Claude Code's agent
// files, Codex's, and a plugin's, which is read-only), and the daemon parses every file itself
// because a provider can drop a broken file without a word.
//
// A stored row and a draft are two shapes because a write treats an absent member as "leave it
// to the default" and an explicit `null` as "stop pinning this", while the stored row has no
// absence and materializes the inherit state as `null`. One shape could not clear a pinned
// account or effort. So create leaves `overrides` optional, the row always carries the list, and
// update types each nullable member `T | null`, optional.
//
// `AgentId` lives here beside the definition's id: every other agent file imports it, and this
// is the one module none of them is imported by.
import { z } from "zod";

import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
import {
  ProviderAccountIdSchema,
  PROVIDER_NAMES,
  ProviderNameSchema,
  type ProviderAccountId,
  type ProviderName,
} from "./provider-account.js";
import { DRIVER_TOOL_NAME_MAX_LEN } from "./provider-driver.js";
import { DRIVER_WIRE_TOKEN_MAX_LEN } from "./provider-driver-wire.js";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "./session.js";

/** The longest reason text a refusal or a load failure carries. */
export const AGENT_REASON_MAX_LEN = 1024;

// Ids

/**
 * A saved definition's daemon-minted id. Never its name: the name is a label a
 * person changes, and a rename must not orphan a stored reference.
 */
export type AgentDefinitionId = string & { readonly __brand: "AgentDefinitionId" };
/** Parses an {@link AgentDefinitionId}. */
export const AgentDefinitionIdSchema: z.ZodType<AgentDefinitionId, AgentDefinitionId> =
  brandedUuidIdSchema<AgentDefinitionId>("AgentDefinitionId");

/** A live agent's daemon-minted id: the lead of a session, or an agent it reached. */
export type AgentId = string & { readonly __brand: "AgentId" };
/** Parses an {@link AgentId}. */
export const AgentIdSchema: z.ZodType<AgentId, AgentId> = brandedUuidIdSchema<AgentId>("AgentId");

// The provider binding

/** A provider's own vocabulary token: a model id, an effort or a speed. */
const providerTokenSchema = (label: string): z.ZodString =>
  wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, label);

/**
 * Which provider runs an agent, on which model, paying from which account, at which
 * effort and speed. One shape for a saved definition's bindings and a running
 * agent's binding.
 *
 * - `providerAccountId` null follows the provider's current account, resolved when
 *   the run starts and followed when that mark moves. Not a foreign key: a
 *   definition may name an account later removed, which surfaces as a resolution
 *   refusal rather than a rewrite of the definition.
 * - `effort` null takes the driver's default, and is validated when a run resolves,
 *   never at save, because the vocabulary belongs to the model the run binds.
 * - `outputSpeed` is set on a running agent's binding by `agent.configUpdate`; a
 *   saved definition's bindings leave it absent, because the editor authors no speed.
 */
export interface AgentProviderBinding {
  driverName: ProviderName;
  modelId: string;
  providerAccountId: ProviderAccountId | null;
  effort: string | null;
  outputSpeed?: string | undefined;
}
/** Parses an {@link AgentProviderBinding}. */
export const AgentProviderBindingSchema: z.ZodType<AgentProviderBinding, AgentProviderBinding> = z
  .object({
    driverName: ProviderNameSchema,
    modelId: providerTokenSchema("AgentProviderBinding.modelId"),
    providerAccountId: ProviderAccountIdSchema.nullable(),
    effort: providerTokenSchema("AgentProviderBinding.effort").nullable(),
    outputSpeed: providerTokenSchema("AgentProviderBinding.outputSpeed").optional(),
  })
  .strict();

/**
 * A definition's bindings: the one used when a caller names no driver, and any
 * number of others, one per further provider. The default is one of the bindings
 * the resolver may pick, never a fallback the others are patched from.
 */
export interface AgentDefinitionBindings {
  default: AgentProviderBinding;
  overrides: AgentProviderBinding[];
}

/** A write's bindings: `overrides` may be left out, and is stored as an empty list. */
export interface AgentDefinitionBindingsDraft {
  default: AgentProviderBinding;
  overrides?: AgentProviderBinding[] | undefined;
}

/**
 * Refuses bindings that name one driver twice: an override's driver is unique
 * among the overrides and never repeats the default's, so each provider resolves
 * to exactly one binding.
 */
function refineOneBindingPerDriver(
  bindings: {
    default: { driverName?: ProviderName | undefined };
    overrides?: Array<{ driverName?: ProviderName | undefined }> | undefined;
  },
  context: z.RefinementCtx,
): void {
  const seenDrivers = new Set<ProviderName>();
  if (bindings.default.driverName !== undefined) {
    seenDrivers.add(bindings.default.driverName);
  }
  for (const [index, override] of (bindings.overrides ?? []).entries()) {
    if (override.driverName === undefined) {
      continue;
    }
    if (seenDrivers.has(override.driverName)) {
      context.addIssue({
        code: "custom",
        path: ["overrides", index, "driverName"],
        message: `A definition binds driver ${override.driverName} once.`,
      });
    }
    seenDrivers.add(override.driverName);
  }
}

/** Parses stored {@link AgentDefinitionBindings}, one binding per driver. */
export const AgentDefinitionBindingsSchema: z.ZodType<AgentDefinitionBindings> = z
  .object({ default: AgentProviderBindingSchema, overrides: z.array(AgentProviderBindingSchema) })
  .strict()
  .superRefine(refineOneBindingPerDriver);

/** Parses written {@link AgentDefinitionBindingsDraft}, one binding per driver. */
export const AgentDefinitionBindingsDraftSchema: z.ZodType<
  AgentDefinitionBindingsDraft,
  AgentDefinitionBindingsDraft
> = z
  .object({
    default: AgentProviderBindingSchema,
    overrides: z.array(AgentProviderBindingSchema).optional(),
  })
  .strict()
  .superRefine(refineOneBindingPerDriver);

/**
 * A binding as the list serves it: `driverName` where the file names a provider this app runs,
 * or `unsupportedProviderName`, the name the file gave, where it names one the app does not.
 * Exactly one of the two is present.
 */
export interface AgentListedProviderBinding extends Omit<AgentProviderBinding, "driverName"> {
  driverName?: ProviderName | undefined;
  unsupportedProviderName?: string | undefined;
}
/** Parses an {@link AgentListedProviderBinding}. */
export const AgentListedProviderBindingSchema: z.ZodType<AgentListedProviderBinding> = z
  .object({
    driverName: ProviderNameSchema.optional(),
    unsupportedProviderName: providerTokenSchema(
      "AgentListedProviderBinding.unsupportedProviderName",
    ).optional(),
    modelId: providerTokenSchema("AgentListedProviderBinding.modelId"),
    providerAccountId: ProviderAccountIdSchema.nullable(),
    effort: providerTokenSchema("AgentListedProviderBinding.effort").nullable(),
    outputSpeed: providerTokenSchema("AgentListedProviderBinding.outputSpeed").optional(),
  })
  .strict()
  .refine(
    (binding) =>
      (binding.driverName === undefined) !== (binding.unsupportedProviderName === undefined),
    {
      message: "A listed binding names a provider the app runs or the one it does not, not both.",
      path: ["driverName"],
    },
  );

/** A definition's bindings as the list serves them. */
export interface AgentListedBindings {
  default: AgentListedProviderBinding;
  overrides: AgentListedProviderBinding[];
}
const AgentListedBindingsSchema: z.ZodType<AgentListedBindings> = z
  .object({
    default: AgentListedProviderBindingSchema,
    overrides: z.array(AgentListedProviderBindingSchema),
  })
  .strict()
  .superRefine(refineOneBindingPerDriver);

// The definition's own vocabularies

/**
 * Where an agent's one memory lives: `user` everywhere, in the daemon's own
 * agent-memory folder; `project` in this project, saved with the repository;
 * `local` in this project on this machine only. Either provider running the agent
 * reads and writes the same folder.
 */
export const AGENT_MEMORY_SCOPES = ["user", "project", "local"] as const;
/** One of {@link AGENT_MEMORY_SCOPES}. */
export type AgentMemoryScope = (typeof AGENT_MEMORY_SCOPES)[number];
/** Parses an {@link AgentMemoryScope}. */
export const AgentMemoryScopeSchema: z.ZodType<AgentMemoryScope, AgentMemoryScope> =
  z.enum(AGENT_MEMORY_SCOPES);

/**
 * An agent's own hooks in Claude Code's own shape, the form an agent file's
 * `hooks` key holds: per event name, a list of `{ matcher?, hooks: [handler] }`.
 * A handler is carried as that provider's hook schema spells it; the daemon
 * checks it against that schema when it saves, and the editor draws one row per
 * handler.
 */
export type AgentHooks = Record<
  string,
  Array<{ matcher?: string | undefined; hooks: Array<Record<string, unknown>> }>
>;
/** Parses {@link AgentHooks}. */
export const AgentHooksSchema: z.ZodType<AgentHooks, AgentHooks> = z.record(
  wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "AgentHooks event"),
  z.array(
    z
      .object({
        matcher: z.string().optional(),
        hooks: z.array(z.record(z.string(), z.unknown())).min(1),
      })
      .strict(),
  ),
);

// The stored definition

/** A tool name on an allowlist, as the catalog spells it. */
const toolNameSchema: z.ZodString = wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "tool name");
/** The number of turns an agent may take before it is stopped. */
const turnCapSchema = z.number().int().positive();

/**
 * One saved definition.
 *
 * - `toolAllowlist` has three states: null is the driver's defaults, `[]` is no
 *   tools at all, and a list is exactly those. Collapsing the first two would make
 *   "I did not choose" read as "I chose nothing".
 * - `turnCap` null is no cap. One number on both providers: where a provider has no
 *   limit of its own the daemon counts the agent's rounds and, at the cap, denies
 *   every further tool call with words telling the agent to report what it did.
 * - `hooks` null is none; `memoryScope` null is no memory.
 */
export interface AgentDefinition {
  definitionId: AgentDefinitionId;
  name: string;
  description: string;
  /** A glyph key from the console's icon set; null is the generic agent mark. */
  icon: string | null;
  /** One step of the console's twelve-step hue wheel; null is no chosen hue. */
  accentHue: string | null;
  bindings: AgentDefinitionBindings;
  instructions: string;
  goal: string | null;
  toolAllowlist: string[] | null;
  turnCap: number | null;
  hooks: AgentHooks | null;
  memoryScope: AgentMemoryScope | null;
  createdAt: string;
  updatedAt: string;
}

const agentDefinitionFields = {
  definitionId: AgentDefinitionIdSchema,
  name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "AgentDefinition.name"),
  description: z.string(),
  icon: z.string().min(1).nullable(),
  accentHue: z.string().min(1).nullable(),
  bindings: AgentDefinitionBindingsSchema,
  instructions: z.string(),
  goal: z.string().nullable(),
  toolAllowlist: z.array(toolNameSchema).nullable(),
  turnCap: turnCapSchema.nullable(),
  hooks: AgentHooksSchema.nullable(),
  memoryScope: AgentMemoryScopeSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
};

/** Parses an {@link AgentDefinition}. */
export const AgentDefinitionSchema: z.ZodType<AgentDefinition> = z
  .object(agentDefinitionFields)
  .strict();

// Where a definition lives, as the list serves it

/** Which files a definition came from: ours, a provider's own, or a plugin's. */
export const AGENT_DEFINITION_ORIGINS: readonly ["ours", ...ProviderName[], "plugin"] = [
  "ours",
  ...PROVIDER_NAMES,
  "plugin",
];
/** One of {@link AGENT_DEFINITION_ORIGINS}. */
export type AgentDefinitionOrigin = (typeof AGENT_DEFINITION_ORIGINS)[number];

/** Whether a definition belongs to every project or to one. */
export const AGENT_DEFINITION_SCOPES = ["global", "project"] as const;
/** One of {@link AGENT_DEFINITION_SCOPES}. */
export type AgentDefinitionScope = (typeof AGENT_DEFINITION_SCOPES)[number];

/**
 * One definition as the list serves it: the record, where it lives, and two
 * provider facts. Each is its own member and none excludes another: an orphaned
 * record can also carry a load error. Its bindings are listed bindings, so a file
 * naming a provider the app does not run is listed too.
 *
 * - `pluginName` is present exactly on a plugin's agent, which is read-only.
 * - `projectId` is present exactly when `scope` is `project`.
 * - `sourcePath` is the file the record lives in, or for an orphaned record the last
 *   path its file was known at. Display data only, never a capability.
 * - `orphaned`: a provider's file was renamed or deleted outside the app, and the
 *   record keeps its extras until it is reattached or discarded.
 * - `disabledInProvider`: the provider's own configuration switches the agent off.
 * - `loadError`: its file failed the daemon's own parse, with the reason.
 */
export interface AgentDefinitionListEntry extends Omit<AgentDefinition, "bindings"> {
  bindings: AgentListedBindings;
  origin: AgentDefinitionOrigin;
  pluginName?: string | undefined;
  scope: AgentDefinitionScope;
  projectId?: string | undefined;
  sourcePath: string;
  orphaned: boolean;
  disabledInProvider: boolean;
  loadError: string | null;
}

/**
 * Refuses a scope and a project that disagree: a project scope names its project.
 * Saved agents and skills share the rule.
 */
export function refineProjectScope(
  value: { scope?: AgentDefinitionScope | undefined; projectId?: string | undefined },
  context: z.RefinementCtx,
): void {
  if ((value.scope === "project") !== (value.projectId !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["projectId"],
      message: "projectId is present exactly when scope is project.",
    });
  }
}

/**
 * Refuses an origin and a plugin name that disagree: a plugin's entry names its
 * plugin and no other entry does. Saved agents and skills share the rule.
 */
export function refinePluginOrigin(
  value: { origin: AgentDefinitionOrigin; pluginName?: string | undefined },
  context: z.RefinementCtx,
): void {
  if ((value.origin === "plugin") !== (value.pluginName !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["pluginName"],
      message: "pluginName is present exactly when origin is plugin.",
    });
  }
}

/** Parses an {@link AgentDefinitionListEntry}. */
export const AgentDefinitionListEntrySchema: z.ZodType<AgentDefinitionListEntry> = z
  .object({
    ...agentDefinitionFields,
    bindings: AgentListedBindingsSchema,
    origin: z.enum(AGENT_DEFINITION_ORIGINS),
    pluginName: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "pluginName").optional(),
    scope: z.enum(AGENT_DEFINITION_SCOPES),
    projectId: uuidTextFormSchema.optional(),
    sourcePath: wireFreeFormString(FILE_PATH_MAX_LEN, "sourcePath"),
    orphaned: z.boolean(),
    disabledInProvider: z.boolean(),
    loadError: wireFreeFormString(AGENT_REASON_MAX_LEN, "loadError").nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    refinePluginOrigin(entry, context);
    refineProjectScope(entry, context);
  });

/**
 * What a running agent was started with, echoed on whichever reply started it:
 * every field as applied, with the resolved binding in place of the definition's
 * bindings. A record of the start, never a live view of the definition, which may
 * have moved since; the resolved-from id here is the one home of the definition an
 * agent came from.
 */
export interface AgentResolvedConfiguration {
  resolvedFromDefinitionId: AgentDefinitionId;
  resolvedBinding: AgentProviderBinding;
  toolAllowlist: string[] | null;
  instructions: string;
  goal: string | null;
}
/** Parses an {@link AgentResolvedConfiguration}. */
export const AgentResolvedConfigurationSchema: z.ZodType<AgentResolvedConfiguration> = z
  .object({
    resolvedFromDefinitionId: AgentDefinitionIdSchema,
    resolvedBinding: AgentProviderBindingSchema,
    toolAllowlist: agentDefinitionFields.toolAllowlist,
    instructions: agentDefinitionFields.instructions,
    goal: agentDefinitionFields.goal,
  })
  .strict();

// agent.definitionList and agent.definitionSubscribe

/** `agent.definitionList` and `agent.definitionSubscribe` take no members. */
export type AgentDefinitionListRequest = Record<string, never>;
/** Parses an {@link AgentDefinitionListRequest}: an empty object. */
export const AgentDefinitionListRequestSchema: z.ZodType<
  AgentDefinitionListRequest,
  AgentDefinitionListRequest
> = z.object({}).strict();

/**
 * The whole registry, and two readings folded per reply and never stored:
 * `workflowUsage`, how many workflow definitions bind each definition, and
 * `lastUsedAt`, when a session run or a workflow run last resolved it. Each is
 * absent as a whole only when its source could not be read, so a card leaves the
 * line out rather than showing zero; a definition never run has no `lastUsedAt` key.
 */
export interface AgentDefinitionListResponse {
  definitions: AgentDefinitionListEntry[];
  workflowUsage?: Record<AgentDefinitionId, number> | undefined;
  lastUsedAt?: Record<AgentDefinitionId, string> | undefined;
}
/** Parses an {@link AgentDefinitionListResponse}. */
export const AgentDefinitionListResponseSchema: z.ZodType<AgentDefinitionListResponse> = z
  .object({
    definitions: z.array(AgentDefinitionListEntrySchema),
    workflowUsage: z.record(AgentDefinitionIdSchema, z.number().int().nonnegative()).optional(),
    lastUsedAt: z.record(AgentDefinitionIdSchema, z.iso.datetime({ offset: true })).optional(),
  })
  .strict();

// agent.definitionCreate

/**
 * A new definition. Every member except the name and the default binding is
 * optional, and an omitted one is stored as its null state, so a definition never
 * silently pins today's default forever. `scope` defaults to `global`; a project
 * scope names its project. The daemon writes our file under the scope's
 * `.ai-sidekicks/agents/` and the store row in one operation.
 */
export interface AgentDefinitionCreateRequest {
  name: string;
  description?: string | undefined;
  icon?: string | null | undefined;
  accentHue?: string | null | undefined;
  bindings: AgentDefinitionBindingsDraft;
  instructions?: string | undefined;
  goal?: string | null | undefined;
  toolAllowlist?: string[] | null | undefined;
  turnCap?: number | null | undefined;
  hooks?: AgentHooks | null | undefined;
  memoryScope?: AgentMemoryScope | null | undefined;
  scope?: AgentDefinitionScope | undefined;
  projectId?: string | undefined;
}

/** The writable members shared by create and update, each optional. */
const writableDefinitionFields = {
  description: agentDefinitionFields.description.optional(),
  icon: agentDefinitionFields.icon.optional(),
  accentHue: agentDefinitionFields.accentHue.optional(),
  instructions: agentDefinitionFields.instructions.optional(),
  goal: agentDefinitionFields.goal.optional(),
  toolAllowlist: agentDefinitionFields.toolAllowlist.optional(),
  turnCap: agentDefinitionFields.turnCap.optional(),
  hooks: agentDefinitionFields.hooks.optional(),
  memoryScope: agentDefinitionFields.memoryScope.optional(),
};

/** Parses an {@link AgentDefinitionCreateRequest}. */
export const AgentDefinitionCreateRequestSchema: z.ZodType<
  AgentDefinitionCreateRequest,
  AgentDefinitionCreateRequest
> = z
  .object({
    name: agentDefinitionFields.name,
    bindings: AgentDefinitionBindingsDraftSchema,
    ...writableDefinitionFields,
    scope: z.enum(AGENT_DEFINITION_SCOPES).optional(),
    projectId: uuidTextFormSchema.optional(),
  })
  .strict()
  .superRefine(refineProjectScope);

/** The created definition, as the list serves it. */
export interface AgentDefinitionCreateResponse {
  definition: AgentDefinitionListEntry;
}
/** Parses an {@link AgentDefinitionCreateResponse}. */
export const AgentDefinitionCreateResponseSchema: z.ZodType<AgentDefinitionCreateResponse> = z
  .object({ definition: AgentDefinitionListEntrySchema })
  .strict();

// agent.definitionUpdate

/**
 * A partial patch. An absent member leaves the stored value alone and an explicit
 * null clears it to its inherit state. `bindings` and `hooks` each replace the
 * stored value whole. A member the provider's own file holds is written into that
 * file in place; any other is written only to our record beside it, so a
 * provider's file never gains a key its provider does not read. A plugin's agent is
 * read-only and refuses every update.
 *
 * `reattachFilePath` reattaches an orphaned record to a provider's file, accepted
 * only while the record is orphaned. The person picks the file with the platform's
 * own chooser, and the renderer sends the chooser's token; main's relay puts the
 * path in its place, so this member is the path the daemon reads.
 */
export interface AgentDefinitionUpdateRequest {
  definitionId: AgentDefinitionId;
  name?: string | undefined;
  description?: string | undefined;
  icon?: string | null | undefined;
  accentHue?: string | null | undefined;
  bindings?: AgentDefinitionBindingsDraft | undefined;
  instructions?: string | undefined;
  goal?: string | null | undefined;
  toolAllowlist?: string[] | null | undefined;
  turnCap?: number | null | undefined;
  hooks?: AgentHooks | null | undefined;
  memoryScope?: AgentMemoryScope | null | undefined;
  reattachFilePath?: string | undefined;
}
/** Parses an {@link AgentDefinitionUpdateRequest}. */
export const AgentDefinitionUpdateRequestSchema: z.ZodType<
  AgentDefinitionUpdateRequest,
  AgentDefinitionUpdateRequest
> = z
  .object({
    definitionId: AgentDefinitionIdSchema,
    name: agentDefinitionFields.name.optional(),
    bindings: AgentDefinitionBindingsDraftSchema.optional(),
    ...writableDefinitionFields,
    reattachFilePath: wireFreeFormString(FILE_PATH_MAX_LEN, "reattachFilePath").optional(),
  })
  .strict();

/** The whole row after the update, so a client never merges its own patch. */
export interface AgentDefinitionUpdateResponse {
  definition: AgentDefinitionListEntry;
}
/** Parses an {@link AgentDefinitionUpdateResponse}. */
export const AgentDefinitionUpdateResponseSchema: z.ZodType<AgentDefinitionUpdateResponse> = z
  .object({ definition: AgentDefinitionListEntrySchema })
  .strict();

// agent.definitionDelete

/**
 * Never refused and never cascading: a session running the agent keeps what it was
 * given, and a workflow that names it refuses at its next run. On an agent from a
 * provider's own file, the daemon checks the path is the agent file it read and
 * deletes that file and the record beside it in one act, so the provider loses the
 * agent too. On an orphaned record it discards the record.
 */
export interface AgentDefinitionDeleteRequest {
  definitionId: AgentDefinitionId;
}
/** Parses an {@link AgentDefinitionDeleteRequest}. */
export const AgentDefinitionDeleteRequestSchema: z.ZodType<
  AgentDefinitionDeleteRequest,
  AgentDefinitionDeleteRequest
> = z.object({ definitionId: AgentDefinitionIdSchema }).strict();

/** A delete's answer. */
export interface AgentDefinitionDeleteResponse {
  deleted: true;
}
/** Parses an {@link AgentDefinitionDeleteResponse}. */
export const AgentDefinitionDeleteResponseSchema: z.ZodType<AgentDefinitionDeleteResponse> = z
  .object({ deleted: z.literal(true) })
  .strict();

// agent.definitionExport and agent.definitionImport

/**
 * Writes the chosen definitions into the folder the person picked, one Markdown file per
 * definition: its record, icon, accent, hooks and memory scope, and every binding with the account
 * left out. The daemon leaves the accounts out itself and never reads the notes in an agent's
 * memory folder into a file. An unknown id refuses the whole export.
 *
 * `folder` is the path main's relay put in place of the token the platform's folder chooser
 * returned.
 */
export interface AgentDefinitionExportRequest {
  definitionIds: AgentDefinitionId[];
  folder: string;
}
/** Parses an {@link AgentDefinitionExportRequest}; it names at least one definition. */
export const AgentDefinitionExportRequestSchema: z.ZodType<
  AgentDefinitionExportRequest,
  AgentDefinitionExportRequest
> = z
  .object({
    definitionIds: z.array(AgentDefinitionIdSchema).min(1),
    folder: wireFreeFormString(FILE_PATH_MAX_LEN, "folder"),
  })
  .strict();

/** How many definition files the export wrote. */
export interface AgentDefinitionExportResponse {
  exportedCount: number;
}
/** Parses an {@link AgentDefinitionExportResponse}. */
export const AgentDefinitionExportResponseSchema: z.ZodType<AgentDefinitionExportResponse> = z
  .object({ exportedCount: z.number().int().positive() })
  .strict();

/**
 * Reads the folder the person picked and creates every agent definition in it, in one daemon
 * transaction. It only creates, never overwrites, suffixes a colliding name, and lands every
 * definition in the global scope, because the files carry nothing tied to one machine. Accounts
 * arrive cleared, so an import binds none. Every other file is skipped and listed, never refusing
 * the import.
 *
 * `folder` is the path main's relay put in place of the token the platform's open chooser
 * returned.
 */
export interface AgentDefinitionImportRequest {
  folder: string;
}
/** Parses an {@link AgentDefinitionImportRequest}. */
export const AgentDefinitionImportRequestSchema: z.ZodType<
  AgentDefinitionImportRequest,
  AgentDefinitionImportRequest
> = z.object({ folder: wireFreeFormString(FILE_PATH_MAX_LEN, "folder") }).strict();

/**
 * The created rows, under their final and possibly suffixed names, and each file skipped because
 * it is not an agent definition, listed once.
 */
export interface AgentDefinitionImportResponse {
  definitions: AgentDefinitionListEntry[];
  skipped: Array<{ fileName: string; reason: "not_an_agent_definition" }>;
}
/** Parses an {@link AgentDefinitionImportResponse}. */
export const AgentDefinitionImportResponseSchema: z.ZodType<AgentDefinitionImportResponse> = z
  .object({
    definitions: z.array(AgentDefinitionListEntrySchema),
    skipped: z.array(
      z
        .object({
          fileName: wireFreeFormString(FILE_PATH_MAX_LEN, "fileName"),
          reason: z.literal("not_an_agent_definition"),
        })
        .strict(),
    ),
  })
  .strict();

// Refusals

/** An export with a definition file that could not be written into the folder. */
export type AgentExportWriteFailedCode = "agent.export_write_failed";
/** The code of an export with a definition file that could not be written. */
export const AGENT_EXPORT_WRITE_FAILED_CODE: AgentExportWriteFailedCode =
  "agent.export_write_failed";

/** The operating system's own cause of the failed write, as it reported it. */
export interface AgentExportWriteFailedDetails {
  cause: string;
}
/** Parses {@link AgentExportWriteFailedDetails}. */
export const AgentExportWriteFailedDetailsSchema: z.ZodType<AgentExportWriteFailedDetails> = z
  .object({ cause: wireFreeFormString(AGENT_REASON_MAX_LEN, "cause") })
  .strict();

/** A definition that exists and cannot produce a runnable agent now. */
export type AgentResolutionRefusedCode = "agent.resolution_refused";
/** The code of a definition that cannot produce a runnable agent now. */
export const AGENT_RESOLUTION_REFUSED_CODE: AgentResolutionRefusedCode = "agent.resolution_refused";

/**
 * Why a definition could not resolve. The remedy is the same in every case (edit
 * the definition, or repair the account), so one code carries a reason.
 */
export const AGENT_RESOLUTION_REFUSED_REASONS = [
  "model_unavailable",
  "effort_unsupported",
  "account_unavailable",
  "allowlist_unrealizable",
  "provider_unsupported",
] as const;
/** One of {@link AGENT_RESOLUTION_REFUSED_REASONS}. */
export type AgentResolutionRefusedReason = (typeof AGENT_RESOLUTION_REFUSED_REASONS)[number];

/**
 * The resolution refusal's details, each reason naming what was asked for beside
 * what is available, because neither alone tells a person what to edit.
 *
 * - `model_unavailable`: the pinned model its provider no longer offers, or, with a
 *   null `modelId`, a driver the definition binds no model for.
 * - `effort_unsupported`: the stored effort and the efforts the model publishes.
 * - `account_unavailable`: the pinned account this machine no longer holds.
 * - `allowlist_unrealizable`: the allowlisted tools that have left the catalog, and
 *   the tools the driver has.
 * - `provider_unsupported`: the provider name the definition's file carries, which
 *   this app does not run, until the person picks an installed provider.
 */
export type AgentResolutionRefusedDetails =
  | {
      definitionId: AgentDefinitionId;
      reason: "model_unavailable";
      driverName: ProviderName;
      modelId: string | null;
    }
  | {
      definitionId: AgentDefinitionId;
      reason: "effort_unsupported";
      effort: string;
      effortLevels: string[];
    }
  | {
      definitionId: AgentDefinitionId;
      reason: "account_unavailable";
      providerAccountId: ProviderAccountId;
    }
  | {
      definitionId: AgentDefinitionId;
      reason: "allowlist_unrealizable";
      toolNames: string[];
      supportedToolNames: string[];
    }
  | {
      definitionId: AgentDefinitionId;
      reason: "provider_unsupported";
      unsupportedProviderName: string;
    };
/** Parses {@link AgentResolutionRefusedDetails}. */
export const AgentResolutionRefusedDetailsSchema: z.ZodType<AgentResolutionRefusedDetails> =
  z.discriminatedUnion("reason", [
    z
      .object({
        definitionId: AgentDefinitionIdSchema,
        reason: z.literal("model_unavailable"),
        driverName: ProviderNameSchema,
        modelId: providerTokenSchema("modelId").nullable(),
      })
      .strict(),
    z
      .object({
        definitionId: AgentDefinitionIdSchema,
        reason: z.literal("effort_unsupported"),
        effort: providerTokenSchema("effort"),
        effortLevels: z.array(providerTokenSchema("effortLevels")),
      })
      .strict(),
    z
      .object({
        definitionId: AgentDefinitionIdSchema,
        reason: z.literal("account_unavailable"),
        providerAccountId: ProviderAccountIdSchema,
      })
      .strict(),
    z
      .object({
        definitionId: AgentDefinitionIdSchema,
        reason: z.literal("allowlist_unrealizable"),
        toolNames: z.array(toolNameSchema).min(1),
        supportedToolNames: z.array(toolNameSchema),
      })
      .strict(),
    z
      .object({
        definitionId: AgentDefinitionIdSchema,
        reason: z.literal("provider_unsupported"),
        unsupportedProviderName: providerTokenSchema("unsupportedProviderName"),
      })
      .strict(),
  ]);

/** A definition update the daemon refused. */
export type AgentUpdateRefusedCode = "agent.update_refused";
/** The code of a definition update the daemon refused. */
export const AGENT_UPDATE_REFUSED_CODE: AgentUpdateRefusedCode = "agent.update_refused";

/**
 * Why an update was refused: `plugin_read_only`, the definition is a plugin's agent,
 * which is read-only; `not_orphaned`, a reattach named a record that is not orphaned.
 */
export const AGENT_UPDATE_REFUSED_REASONS = ["plugin_read_only", "not_orphaned"] as const;
/** One of {@link AGENT_UPDATE_REFUSED_REASONS}. */
export type AgentUpdateRefusedReason = (typeof AGENT_UPDATE_REFUSED_REASONS)[number];

/** The update refusal's details: the definition and why. */
export interface AgentUpdateRefusedDetails {
  definitionId: AgentDefinitionId;
  reason: AgentUpdateRefusedReason;
}
/** Parses {@link AgentUpdateRefusedDetails}. */
export const AgentUpdateRefusedDetailsSchema: z.ZodType<AgentUpdateRefusedDetails> = z
  .object({ definitionId: AgentDefinitionIdSchema, reason: z.enum(AGENT_UPDATE_REFUSED_REASONS) })
  .strict();
