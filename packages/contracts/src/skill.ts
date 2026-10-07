// Skills: the list of every skill folder, file reads and saves, the name a typed skill would be
// called by, availability per provider, the scan a widening runs, and the refusals of those verbs.
// A skill is its whole folder. The daemon parses every `SKILL.md` itself because a provider can
// load a broken one without a word, so a provider's own skill enumeration is evidence of what it
// loaded, never a second registry.
// Skills are node-local configuration: no verb here appends an event.
import { z } from "zod";

import {
  AGENT_DEFINITION_ORIGINS,
  AGENT_DEFINITION_SCOPES,
  AGENT_REASON_MAX_LEN,
  type AgentDefinitionOrigin,
  type AgentDefinitionScope,
  refinePluginOrigin,
  refineProjectScope,
} from "./agent/definition.js";
import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { ProviderNameSchema, type ProviderName } from "./provider/name.js";
import { DRIVER_TOOL_NAME_MAX_LEN } from "./provider/driver/length-limits.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./free-form-string.js";
import { countSchema } from "./internal/wire-scalars.js";

/**
 * The longest name a new skill takes. Codex refuses to load a skill whose name is
 * longer, and a new skill is available on both providers.
 */
export const SKILL_NAME_MAX_LEN = 64;

// The skill as the list serves it

/**
 * A skill's daemon-minted id: the handle every verb takes. Never its folder path,
 * which is display data only, and never its name, which two origins can share.
 */
export type SkillId = string & { readonly __brand: "SkillId" };
/** Parses a {@link SkillId}. */
export const SkillIdSchema: z.ZodType<SkillId, SkillId> = brandedUuidIdSchema<SkillId>("SkillId");

/** A file's path inside its skill folder, relative to the folder, as the daemon judges it. */
const relativeFilePathSchema = (label: string): z.ZodString =>
  wireFreeFormString(FILE_PATH_MAX_LEN, label);

/**
 * Which providers a skill reaches. Defaulted by origin: a skill authored here is on
 * both, one found in a provider's own folder is on that provider alone, and a
 * plugin's is on the provider the plugin was installed for.
 */
export type SkillAvailability = Record<ProviderName, boolean>;
/** Parses a {@link SkillAvailability}; every provider is present and no other key is. */
export const SkillAvailabilitySchema: z.ZodType<SkillAvailability> = z.record(
  ProviderNameSchema,
  z.boolean(),
);

/**
 * One file in a skill folder, `SKILL.md` included. `size` is in bytes; `readable`
 * is false for a binary file, which the editor does not open but the folder still
 * lists, because the folder travels whole.
 */
export interface SkillFile {
  path: string;
  size: number;
  readable: boolean;
}
/** Parses a {@link SkillFile}. */
export const SkillFileSchema: z.ZodType<SkillFile> = z
  .object({
    path: relativeFilePathSchema("SkillFile.path"),
    size: countSchema,
    readable: z.boolean(),
  })
  .strict();

/**
 * What a person types to call the skill, per provider it reaches, in that
 * provider's own form: a provider's own folder keeps its bare name there
 * (`/security-review`, `$refactor-plan`), a skill made in the app arrives as
 * `sidekicks:<name>` (`/sidekicks:review-diff`), a skill crossing to the other
 * provider under its origin's plugin name (`$claude:security-review`,
 * `/codex:refactor-plan`), and a plugin's skill under the plugin's name on both.
 * The daemon derives it; the composer inserts it.
 */
export type SkillCallForms = Partial<Record<ProviderName, string>>;
/** Parses {@link SkillCallForms}; a key that is not a provider is refused. */
export const SkillCallFormsSchema: z.ZodType<SkillCallForms> = z.partialRecord(
  ProviderNameSchema,
  wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "SkillCallForms entry"),
);

/**
 * One skill as the list serves it.
 *
 * - `name` is the front matter's name, or the folder's name where it has none.
 * - `description` is null when `SKILL.md` carries none, or the record is orphaned.
 * - `icon` is a glyph key from the app's icon set, kept in our record on every origin; null
 *   draws the default mark.
 * - `pluginName` is present exactly on a plugin's skill, which is read-only.
 * - `projectId` is present exactly when `scope` is `project`.
 * - `folderPath` is the folder, or for an orphaned record the last path it was known at; display
 *   data only, never a capability.
 * - `files` is every file in the folder; empty for an orphaned record.
 * - `orphaned`: the folder was renamed or deleted outside the app; the record keeps its
 *   availability and icon until it is reattached or discarded.
 * - `disabledInProvider`: the providers whose own configuration switches the skill off.
 * - `loadError`: the folder failed the daemon's own parse, with the reason.
 */
export interface SkillListEntry {
  skillId: SkillId;
  name: string;
  description: string | null;
  icon: string | null;
  origin: AgentDefinitionOrigin;
  pluginName?: string | undefined;
  scope: AgentDefinitionScope;
  projectId?: string | undefined;
  folderPath: string;
  files: SkillFile[];
  availability: SkillAvailability;
  callForms: SkillCallForms;
  orphaned: boolean;
  disabledInProvider: ProviderName[];
  loadError: string | null;
}

/** The icon member: a glyph key, or null for the default mark. */
const iconSchema = z.string().min(1).nullable();

/** Parses a {@link SkillListEntry}. */
export const SkillListEntrySchema: z.ZodType<SkillListEntry> = z
  .object({
    skillId: SkillIdSchema,
    name: wireFreeFormString(FILE_PATH_MAX_LEN, "SkillListEntry.name"),
    description: z.string().nullable(),
    icon: iconSchema,
    origin: z.enum(AGENT_DEFINITION_ORIGINS),
    pluginName: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "pluginName").optional(),
    scope: z.enum(AGENT_DEFINITION_SCOPES),
    projectId: uuidTextFormSchema.optional(),
    folderPath: wireFreeFormString(FILE_PATH_MAX_LEN, "folderPath"),
    files: z.array(SkillFileSchema),
    availability: SkillAvailabilitySchema,
    callForms: SkillCallFormsSchema,
    orphaned: z.boolean(),
    disabledInProvider: z.array(ProviderNameSchema),
    loadError: wireFreeFormString(AGENT_REASON_MAX_LEN, "loadError").nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    refinePluginOrigin(entry, context);
    refineProjectScope(entry, context);
  });

// skill.list and skill.subscribe

/** `skill.list` and `skill.subscribe` take no members. */
export type SkillListRequest = Record<string, never>;
/** Parses a {@link SkillListRequest}: an empty object. */
export const SkillListRequestSchema: z.ZodType<SkillListRequest, SkillListRequest> = z
  .object({})
  .strict();

/**
 * Every skill folder across the four origins, orphaned records included. A file the
 * daemon cannot read is listed, never a reason to refuse the read.
 */
export interface SkillListResponse {
  skills: SkillListEntry[];
}
/** Parses a {@link SkillListResponse}. */
export const SkillListResponseSchema: z.ZodType<SkillListResponse> = z
  .object({ skills: z.array(SkillListEntrySchema) })
  .strict();

// skill.fileRead

/** One file's body, loaded when the file opens in the editor. */
export interface SkillFileReadRequest {
  skillId: SkillId;
  path: string;
}
/** Parses a {@link SkillFileReadRequest}. */
export const SkillFileReadRequestSchema: z.ZodType<SkillFileReadRequest, SkillFileReadRequest> = z
  .object({ skillId: SkillIdSchema, path: relativeFilePathSchema("SkillFileReadRequest.path") })
  .strict();

/** The file's text as it is on disk. */
export interface SkillFileReadResponse {
  content: string;
}
/** Parses a {@link SkillFileReadResponse}. */
export const SkillFileReadResponseSchema: z.ZodType<SkillFileReadResponse> = z
  .object({ content: z.string() })
  .strict();

// The folder a save writes

/** A file written with this body: new to the folder, or changed. */
export interface SkillFileWrite {
  path: string;
  content: string;
}
/** Parses a {@link SkillFileWrite}. */
export const SkillFileWriteSchema: z.ZodType<SkillFileWrite, SkillFileWrite> = z
  .object({ path: relativeFilePathSchema("SkillFileWrite.path"), content: z.string() })
  .strict();

/**
 * A file moved from `renamedFrom` to `path`. It keeps its body unless `content`
 * carries a new one, so a file that cannot be read can still be renamed.
 */
export interface SkillFileRename {
  path: string;
  renamedFrom: string;
  content?: string | undefined;
}

/** Parses a {@link SkillFileRename}. */
export const SkillFileRenameSchema: z.ZodType<SkillFileRename, SkillFileRename> = z
  .object({
    path: relativeFilePathSchema("SkillFileRename.path"),
    renamedFrom: relativeFilePathSchema("SkillFileRename.renamedFrom"),
    content: z.string().optional(),
  })
  .strict();

/** One change a save makes to a file other than `SKILL.md`. */
export type SkillFileChange = SkillFileWrite | SkillFileRename;
/** Parses a {@link SkillFileChange}. */
export const SkillFileChangeSchema: z.ZodType<SkillFileChange, SkillFileChange> = z.union([
  SkillFileWriteSchema,
  SkillFileRenameSchema,
]);

/**
 * A new skill's description. A new skill reaches both providers, and Codex refuses
 * to load a skill without one.
 */
const descriptionSchema = z
  .string()
  .regex(/\S/, { message: "A skill's description must contain a non-whitespace character." });

/** A new skill's name, before the daemon folds it into a folder name. */
const newSkillNameSchema = wireFreeFormString(SKILL_NAME_MAX_LEN, "skill name");

// skill.create

/**
 * A new skill, written whole in one save under the scope's `.ai-sidekicks/skills/`: the name
 * folded into the folder name (case folded, anything but letters and digits to hyphens), and a
 * colliding folder suffixed rather than overwritten; a folder named `new` keeps its name.
 * `description` and `body` become `SKILL.md` and `files` are the other files. It is available on
 * both providers. `scope` defaults to `global`; a project scope names its project.
 */
export interface SkillCreateRequest {
  name: string;
  description: string;
  body: string;
  icon?: string | null | undefined;
  files?: SkillFileWrite[] | undefined;
  scope?: AgentDefinitionScope | undefined;
  projectId?: string | undefined;
}
/** Parses a {@link SkillCreateRequest}. */
export const SkillCreateRequestSchema: z.ZodType<SkillCreateRequest, SkillCreateRequest> = z
  .object({
    name: newSkillNameSchema,
    description: descriptionSchema,
    body: z.string(),
    icon: iconSchema.optional(),
    files: z.array(SkillFileWriteSchema).optional(),
    scope: z.enum(AGENT_DEFINITION_SCOPES).optional(),
    projectId: uuidTextFormSchema.optional(),
  })
  .strict()
  .superRefine(refineProjectScope);

/** The created skill, as the list serves it, under its final folder name. */
export interface SkillCreateResponse {
  skill: SkillListEntry;
}
/** Parses a {@link SkillCreateResponse}. */
export const SkillCreateResponseSchema: z.ZodType<SkillCreateResponse> = z
  .object({ skill: SkillListEntrySchema })
  .strict();

// skill.update

/**
 * The folder saved whole, applied together or not at all, and the same result when saved twice.
 * `description` and `body` rewrite `SKILL.md` and keep its other front-matter keys; `files` and
 * `removedPaths` never name `SKILL.md`; `icon` goes to our record. `name` renames a folder of
 * ours; a provider's own folder is edited in place and gains nothing of ours.
 */
export interface SkillUpdateRequest {
  skillId: SkillId;
  name?: string | undefined;
  description: string;
  body: string;
  files: SkillFileChange[];
  removedPaths: string[];
  icon: string | null;
}
/** Parses a {@link SkillUpdateRequest}. */
export const SkillUpdateRequestSchema: z.ZodType<SkillUpdateRequest, SkillUpdateRequest> = z
  .object({
    skillId: SkillIdSchema,
    name: newSkillNameSchema.optional(),
    description: z.string(),
    body: z.string(),
    files: z.array(SkillFileChangeSchema),
    removedPaths: z.array(relativeFilePathSchema("SkillUpdateRequest.removedPaths")),
    icon: iconSchema,
  })
  .strict();

/** The whole row after the save, so a client never merges its own patch. */
export interface SkillUpdateResponse {
  skill: SkillListEntry;
}
/** Parses a {@link SkillUpdateResponse}. */
export const SkillUpdateResponseSchema: z.ZodType<SkillUpdateResponse> = z
  .object({ skill: SkillListEntrySchema })
  .strict();

// skill.callFormRead

/**
 * The name a skill of ours would be called by, read while its name is typed and before any
 * save: the typed `name`, folded as `skill.create` folds it, at `scope` (default `global`; a
 * project scope names its project). `skillId` names the folder being edited, so it is never
 * its own collision; a new skill sends none.
 */
export interface SkillCallFormReadRequest {
  name: string;
  scope?: AgentDefinitionScope | undefined;
  projectId?: string | undefined;
  skillId?: SkillId | undefined;
}
/** Parses a {@link SkillCallFormReadRequest}. */
export const SkillCallFormReadRequestSchema: z.ZodType<
  SkillCallFormReadRequest,
  SkillCallFormReadRequest
> = z
  .object({
    name: newSkillNameSchema,
    scope: z.enum(AGENT_DEFINITION_SCOPES).optional(),
    projectId: uuidTextFormSchema.optional(),
    skillId: SkillIdSchema.optional(),
  })
  .strict()
  .superRefine(refineProjectScope);

/**
 * The other folder of ours a name would share its packed name with, one global and one project.
 * Both still pack and nothing is refused; `callForms` is what the other folder is called by once
 * the typed one is saved, the project one taking the `-2` suffix.
 */
export interface SkillCallFormCollision {
  skillId: SkillId;
  scope: AgentDefinitionScope;
  folderPath: string;
  callForms: SkillCallForms;
}
/** Parses a {@link SkillCallFormCollision}. */
export const SkillCallFormCollisionSchema: z.ZodType<SkillCallFormCollision> = z
  .object({
    skillId: SkillIdSchema,
    scope: z.enum(AGENT_DEFINITION_SCOPES),
    folderPath: wireFreeFormString(FILE_PATH_MAX_LEN, "folderPath"),
    callForms: SkillCallFormsSchema,
  })
  .strict();

/**
 * What the typed name would be called by on each provider once saved, derived by the same code
 * that builds the session pack, and the folder it collides with, or null when none does.
 */
export interface SkillCallFormReadResponse {
  callForms: SkillCallForms;
  collision: SkillCallFormCollision | null;
}
/** Parses a {@link SkillCallFormReadResponse}. */
export const SkillCallFormReadResponseSchema: z.ZodType<SkillCallFormReadResponse> = z
  .object({ callForms: SkillCallFormsSchema, collision: SkillCallFormCollisionSchema.nullable() })
  .strict();

// skill.availabilityUpdate

/**
 * Sets one provider on or off, with no lock: a provider's own skill can be switched off
 * its home provider, and a skill can be off everywhere.
 */
export interface SkillAvailabilityUpdateRequest {
  skillId: SkillId;
  provider: ProviderName;
  available: boolean;
}
/** Parses a {@link SkillAvailabilityUpdateRequest}. */
export const SkillAvailabilityUpdateRequestSchema: z.ZodType<
  SkillAvailabilityUpdateRequest,
  SkillAvailabilityUpdateRequest
> = z
  .object({ skillId: SkillIdSchema, provider: ProviderNameSchema, available: z.boolean() })
  .strict();

/** The availability the record now holds. */
export interface SkillAvailabilityUpdateResponse {
  availability: SkillAvailability;
}
/** Parses a {@link SkillAvailabilityUpdateResponse}. */
export const SkillAvailabilityUpdateResponseSchema: z.ZodType<SkillAvailabilityUpdateResponse> = z
  .object({ availability: SkillAvailabilitySchema })
  .strict();

// skill.scan

/** The scan a widening runs: the folder, and the provider it is widened onto. */
export interface SkillScanRequest {
  skillId: SkillId;
  provider: ProviderName;
}
/** Parses a {@link SkillScanRequest}. */
export const SkillScanRequestSchema: z.ZodType<SkillScanRequest, SkillScanRequest> = z
  .object({ skillId: SkillIdSchema, provider: ProviderNameSchema })
  .strict();

/** The longest account of what a tool does instead on the provider a skill is widened onto. */
const SKILL_SCAN_TOOL_INSTEAD_MAX_LEN = 1024;

/**
 * One other provider's tool a file names: its name as words in sentence case, never its wire
 * spelling, and what will happen instead on the provider the skill is widened onto, in words.
 */
export interface SkillScanTool {
  name: string;
  whatHappensInstead: string;
}
/** Parses a {@link SkillScanTool}. */
export const SkillScanToolSchema: z.ZodType<SkillScanTool, SkillScanTool> = z
  .object({
    name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "SkillScanTool.name"),
    whatHappensInstead: wireFreeFormString(
      SKILL_SCAN_TOOL_INSTEAD_MAX_LEN,
      "SkillScanTool.whatHappensInstead",
    ),
  })
  .strict();

/**
 * One file that names the other provider's tools or its call sigil. The file is named, never
 * the line, because a line offset goes stale when the file is edited outside the app.
 */
export interface SkillScanFinding {
  path: string;
  tools: SkillScanTool[];
  callSigil: boolean;
}
/** Parses a {@link SkillScanFinding}. */
export const SkillScanFindingSchema: z.ZodType<SkillScanFinding> = z
  .object({
    path: relativeFilePathSchema("SkillScanFinding.path"),
    tools: z.array(SkillScanToolSchema),
    callSigil: z.boolean(),
  })
  .strict();

/**
 * Every file the scan found something in; empty when the folder names no other
 * provider's tools. A read that stores nothing: the warning it feeds is derived
 * from the availability setting and never kept.
 */
export interface SkillScanResponse {
  findings: SkillScanFinding[];
}
/** Parses a {@link SkillScanResponse}. */
export const SkillScanResponseSchema: z.ZodType<SkillScanResponse> = z
  .object({ findings: z.array(SkillScanFindingSchema) })
  .strict();

// skill.recordReattach and skill.recordDiscard

/**
 * Reattaches an orphaned record (its availability and icon) to a folder, accepted only while the
 * record is orphaned. The renderer sends the folder chooser's token and main forwards the path in
 * its place, so `folderPath` is the path the daemon reads.
 */
export interface SkillRecordReattachRequest {
  skillId: SkillId;
  folderPath: string;
}
/** Parses a {@link SkillRecordReattachRequest}. */
export const SkillRecordReattachRequestSchema: z.ZodType<
  SkillRecordReattachRequest,
  SkillRecordReattachRequest
> = z
  .object({
    skillId: SkillIdSchema,
    folderPath: wireFreeFormString(FILE_PATH_MAX_LEN, "folderPath"),
  })
  .strict();

/** The reattached skill, as the list serves it. */
export interface SkillRecordReattachResponse {
  skill: SkillListEntry;
}
/** Parses a {@link SkillRecordReattachResponse}. */
export const SkillRecordReattachResponseSchema: z.ZodType<SkillRecordReattachResponse> = z
  .object({ skill: SkillListEntrySchema })
  .strict();

/** Drops an orphaned record. */
export interface SkillRecordDiscardRequest {
  skillId: SkillId;
}
/** Parses a {@link SkillRecordDiscardRequest}. */
export const SkillRecordDiscardRequestSchema: z.ZodType<
  SkillRecordDiscardRequest,
  SkillRecordDiscardRequest
> = z.object({ skillId: SkillIdSchema }).strict();

/** A discard's answer. */
export interface SkillRecordDiscardResponse {
  discarded: true;
}
/** Parses a {@link SkillRecordDiscardResponse}. */
export const SkillRecordDiscardResponseSchema: z.ZodType<SkillRecordDiscardResponse> = z
  .object({ discarded: z.literal(true) })
  .strict();

// Refusals

/**
 * A save or a create that names a file path the folder cannot take, or a send whose picked skill
 * is not a row of `skill.list`; nothing is written or sent.
 */
export const SKILL_PATH_REFUSED_CODE = "skill.path_refused" as const;
/**
 * The type of {@link SKILL_PATH_REFUSED_CODE}.
 *
 * @consumedBy the handler that returns the `skill.path_refused` error
 */
export type SkillPathRefusedCode = typeof SKILL_PATH_REFUSED_CODE;

/**
 * Why a path was refused. A save's path would land outside the folder, the folder already
 * holds it, or it names `SKILL.md`, which a folder always has exactly one of and which is
 * never replaced, renamed or removed. A send's picked skill matches no row of `skill.list` by
 * name and folder, so the provider is never handed a file the daemon does not list.
 */
export const SKILL_PATH_REFUSED_REASONS = [
  "escapes_folder",
  "duplicate_path",
  "names_entry_file",
  "not_listed",
] as const;
/** One of {@link SKILL_PATH_REFUSED_REASONS}. */
export type SkillPathRefusedReason = (typeof SKILL_PATH_REFUSED_REASONS)[number];

/** The refused path and why, so the screen answers in the row it was typed into. */
export interface SkillPathRefusedDetails {
  path: string;
  reason: SkillPathRefusedReason;
}
/**
 * Parses {@link SkillPathRefusedDetails}.
 *
 * @consumedBy the handler that returns the `skill.path_refused` error
 */
export const SkillPathRefusedDetailsSchema: z.ZodType<SkillPathRefusedDetails> = z
  .object({
    path: z.string().max(FILE_PATH_MAX_LEN),
    reason: z.enum(SKILL_PATH_REFUSED_REASONS),
  })
  .strict();

/** A write the skill cannot take; nothing is written. */
export const SKILL_WRITE_REFUSED_CODE = "skill.write_refused" as const;
/**
 * The type of {@link SKILL_WRITE_REFUSED_CODE}.
 *
 * @consumedBy the handler that returns the `skill.write_refused` error
 */
export type SkillWriteRefusedCode = typeof SKILL_WRITE_REFUSED_CODE;

/**
 * Why a write was refused: every operation that writes refuses a plugin's skill,
 * which is read-only, and `skill.recordReattach` refuses a record that is not
 * orphaned.
 */
export const SKILL_WRITE_REFUSED_REASONS = ["plugin_read_only", "not_orphaned"] as const;
/** One of {@link SKILL_WRITE_REFUSED_REASONS}. */
export type SkillWriteRefusedReason = (typeof SKILL_WRITE_REFUSED_REASONS)[number];

/** Why the write was refused. */
export interface SkillWriteRefusedDetails {
  reason: SkillWriteRefusedReason;
}
/**
 * Parses {@link SkillWriteRefusedDetails}.
 *
 * @consumedBy the handler that returns the `skill.write_refused` error
 */
export const SkillWriteRefusedDetailsSchema: z.ZodType<SkillWriteRefusedDetails> = z
  .object({ reason: z.enum(SKILL_WRITE_REFUSED_REASONS) })
  .strict();

/**
 * A save whose `name` would rename a folder of ours onto a name another folder of
 * ours already holds in the same place; nothing is renamed and nothing is written.
 */
export const SKILL_NAME_TAKEN_CODE = "skill.name_taken" as const;
/**
 * The type of {@link SKILL_NAME_TAKEN_CODE}.
 *
 * @consumedBy the handler that returns the `skill.name_taken` error
 */
export type SkillNameTakenCode = typeof SKILL_NAME_TAKEN_CODE;

/** The folder already holding the name, so the screen names it under the Name field. */
export interface SkillNameTakenDetails {
  folderPath: string;
}
/**
 * Parses {@link SkillNameTakenDetails}.
 *
 * @consumedBy the handler that returns the `skill.name_taken` error
 */
export const SkillNameTakenDetailsSchema: z.ZodType<SkillNameTakenDetails> = z
  .object({ folderPath: z.string().max(FILE_PATH_MAX_LEN) })
  .strict();

// The skill.* method table

/**
 * The `skill.*` methods. `skill.subscribe` resends the whole `skill.list` reply
 * each time a save from any window or the daemon's watch over the skill folders
 * changes it, so the Skills screen and the composer stay current.
 */
export interface SkillMethodDescriptors {
  readonly "skill.list": MethodDescriptor<"skill.list", SkillListRequest, SkillListResponse>;
  readonly "skill.subscribe": SubscriptionMethodDescriptor<
    "skill.subscribe",
    SkillListRequest,
    SubscribeAckResponse,
    SkillListResponse
  >;
  readonly "skill.fileRead": MethodDescriptor<
    "skill.fileRead",
    SkillFileReadRequest,
    SkillFileReadResponse
  >;
  readonly "skill.create": MethodDescriptor<
    "skill.create",
    SkillCreateRequest,
    SkillCreateResponse
  >;
  readonly "skill.update": MethodDescriptor<
    "skill.update",
    SkillUpdateRequest,
    SkillUpdateResponse
  >;
  readonly "skill.callFormRead": MethodDescriptor<
    "skill.callFormRead",
    SkillCallFormReadRequest,
    SkillCallFormReadResponse
  >;
  readonly "skill.availabilityUpdate": MethodDescriptor<
    "skill.availabilityUpdate",
    SkillAvailabilityUpdateRequest,
    SkillAvailabilityUpdateResponse
  >;
  readonly "skill.scan": MethodDescriptor<"skill.scan", SkillScanRequest, SkillScanResponse>;
  readonly "skill.recordReattach": MethodDescriptor<
    "skill.recordReattach",
    SkillRecordReattachRequest,
    SkillRecordReattachResponse
  >;
  readonly "skill.recordDiscard": MethodDescriptor<
    "skill.recordDiscard",
    SkillRecordDiscardRequest,
    SkillRecordDiscardResponse
  >;
}

/**
 * The `skill.*` method table.
 *
 * @consumedBy the daemon's `skill.*` handlers
 */
export const SKILL_METHOD_DESCRIPTORS: SkillMethodDescriptors = defineMethodDescriptors({
  "skill.list": {
    method: "skill.list",
    procedureType: "query",
    mutating: false,
    requestSchema: SkillListRequestSchema,
    responseSchema: SkillListResponseSchema,
  },
  "skill.subscribe": {
    method: "skill.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: SkillListRequestSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: SkillListResponseSchema,
  },
  "skill.fileRead": {
    method: "skill.fileRead",
    procedureType: "query",
    mutating: false,
    requestSchema: SkillFileReadRequestSchema,
    responseSchema: SkillFileReadResponseSchema,
  },
  "skill.create": {
    method: "skill.create",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SkillCreateRequestSchema,
    responseSchema: SkillCreateResponseSchema,
  },
  "skill.update": {
    method: "skill.update",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SkillUpdateRequestSchema,
    responseSchema: SkillUpdateResponseSchema,
  },
  "skill.callFormRead": {
    method: "skill.callFormRead",
    procedureType: "query",
    mutating: false,
    requestSchema: SkillCallFormReadRequestSchema,
    responseSchema: SkillCallFormReadResponseSchema,
  },
  "skill.availabilityUpdate": {
    method: "skill.availabilityUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SkillAvailabilityUpdateRequestSchema,
    responseSchema: SkillAvailabilityUpdateResponseSchema,
  },
  "skill.scan": {
    method: "skill.scan",
    procedureType: "query",
    mutating: false,
    requestSchema: SkillScanRequestSchema,
    responseSchema: SkillScanResponseSchema,
  },
  "skill.recordReattach": {
    method: "skill.recordReattach",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SkillRecordReattachRequestSchema,
    responseSchema: SkillRecordReattachResponseSchema,
  },
  "skill.recordDiscard": {
    method: "skill.recordDiscard",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SkillRecordDiscardRequestSchema,
    responseSchema: SkillRecordDiscardResponseSchema,
  },
});
