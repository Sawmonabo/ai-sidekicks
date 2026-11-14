// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Skills: every skill folder, file reads and saves, call forms, availability per provider, the scan a widening runs, and their refusals.

import type { AgentDefinitionOrigin, AgentDefinitionScope } from "./agent/definition.js";
import type { NonBlankText } from "./internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { EmptyPayload } from "./method-descriptor.js";
import type { WslPlace } from "./place.js";
import type { ProjectId } from "./project.js";
import type { ProviderId } from "./provider/id.js";

/** Every reason a path can be refused. */
export const SKILL_PATH_REFUSED_REASONS = [
  "escapesFolder",
  "duplicatePath",
  "namesEntryFile",
  "notListed",
] as const;

/** Every reason a write can be refused. */
export const SKILL_WRITE_REFUSED_REASONS = ["pluginReadOnly", "notOrphaned"] as const;

/**
 * A skill's daemon-minted id: the handle every method takes. Never its folder path, which is
 * display data only, and never its name, which two origins can share.
 */
export type SkillId = string & { readonly __brand: "SkillId" };
/**
 * One change a save makes to a file other than `SKILL.md`.
 */
export type SkillFileChange =
  | {
      /**
       * The file.
       */
      path: string;
      /**
       * Its body.
       */
      content: string;
    }
  | {
      /**
       * Where it moves to.
       */
      path: string;
      /**
       * Where it was.
       */
      renamedFrom: string;
      /**
       * Its new body.
       */
      content?: string;
    };
/**
 * One thing the scan found, by kind.
 */
export type SkillScanFinding =
  | {
      kind: "file";
      /**
       * The file.
       */
      path: string;
      /**
       * The tools it names.
       */
      tools: SkillScanTool[];
      /**
       * Whether it names another provider's call sigil.
       */
      callSigil: boolean;
    }
  | {
      kind: "nameTooLong";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The most characters that provider takes in a skill's name.
       */
      limit: number;
    };
/**
 * Why `skill.pathRefused` refused. A save's path would land outside the folder, the folder
 * already holds it, or it names `SKILL.md`, which a folder always has exactly one of and which is
 * never replaced, renamed or removed. A send's picked skill matches no row of `skill.list` by name
 * and folder, so the provider is never handed a file the daemon does not list.
 */
export type SkillPathRefusedReason =
  | "escapesFolder"
  | "duplicatePath"
  | "namesEntryFile"
  | "notListed";
/**
 * Why `skill.writeRefused` refused: every method that writes refuses a plugin's skill, which is
 * read-only, and `skill.record.reattach` refuses a record that is not orphaned.
 */
export type SkillWriteRefusedReason = "pluginReadOnly" | "notOrphaned";

/**
 * Whether a skill is on one provider.
 */
export interface SkillProviderAvailability {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * Whether the skill is on it.
   */
  available: boolean;
}
/**
 * What a person types to call a skill on one provider, in that provider's own form.
 */
export interface SkillProviderCallForm {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * What a person types there.
   */
  callForm: string;
}
/**
 * One file in a skill folder, `SKILL.md` included. `size` is in bytes; `readable` is false for a
 * binary file, which the editor does not open but the folder still lists, because the folder
 * travels whole.
 */
export interface SkillFile {
  /**
   * Its path in the folder.
   */
  path: string;
  /**
   * Its size in bytes.
   */
  size: number;
  /**
   * Whether the editor can open it.
   */
  readable: boolean;
}
/**
 * One skill as the list serves it. A provider's own skill names its provider, a plugin's skill,
 * which is read-only, names its plugin, and no other does either; a project skill names its
 * project and no other does.
 */
export interface SkillListEntry {
  /**
   * The skill.
   */
  skillId: SkillId;
  /**
   * The front matter's name, or the folder's where it has none.
   */
  name: string;
  /**
   * `null` when `SKILL.md` carries none, or the record is orphaned.
   */
  description: string | null;
  /**
   * A glyph key kept in our record on every origin; `null` draws the default mark.
   */
  icon: string | null;
  /**
   * Which files it came from.
   */
  origin: AgentDefinitionOrigin;
  /**
   * The provider, on a provider's own skill.
   */
  originProvider?: ProviderId;
  /**
   * The plugin, on a plugin's skill.
   */
  pluginName?: string;
  /**
   * Every project, or one.
   */
  scope: AgentDefinitionScope;
  /**
   * The project, on a project skill.
   */
  projectId?: ProjectId;
  /**
   * The folder, or for an orphaned record the last path it was known at.
   */
  folderPath: string;
  /**
   * The WSL 2 distribution the folder is in, its path in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * Every file in the folder; empty for an orphaned record.
   */
  files: SkillFile[];
  /**
   * Which providers it reaches.
   */
  availability: SkillProviderAvailability[];
  /**
   * What a person types to call it.
   */
  callForms: SkillProviderCallForm[];
  /**
   * The folder was renamed or deleted outside the app; the record keeps its availability and
   * icon until it is reattached or discarded.
   */
  orphaned: boolean;
  /**
   * The providers whose own configuration switches it off.
   */
  disabledInProvider: ProviderId[];
  /**
   * The daemon's own parse failed, with the reason; `null` otherwise.
   */
  loadError: string | null;
}
/**
 * Every skill folder across the four origins, orphaned records included. A file the daemon
 * cannot read is listed, never a reason to refuse the read.
 */
export interface SkillListResponse {
  /**
   * Every skill.
   */
  skills: SkillListEntry[];
}
/**
 * One skill as it stands after `skill.create`, `skill.update` or `skill.record.reattach`, under
 * its final folder name, so a client never merges its own patch.
 */
export interface SkillEntryResponse {
  /**
   * The skill.
   */
  skill: SkillListEntry;
}
/**
 * `skill.file.read`: one file's body, loaded when the file opens in the editor.
 */
export interface SkillFileReadRequest {
  /**
   * The skill.
   */
  skillId: SkillId;
  /**
   * The file.
   */
  path: string;
}
/**
 * The file's text as it is on disk.
 */
export interface SkillFileReadResponse {
  /**
   * The text.
   */
  content: string;
}
/**
 * `skill.create`: a new skill, written whole in one save under the scope's
 * `.ai-sidekicks/skills/`: the name folded into the folder name (case folded, anything but letters
 * and digits to hyphens), and a colliding folder suffixed rather than overwritten; a folder named
 * `new` keeps its name. `description` and `body` become `SKILL.md` and `files` are the other
 * files. It is available on every installed provider. `scope` defaults to `global`; a project
 * scope names its project.
 */
export interface SkillCreateRequest {
  /**
   * Its name.
   */
  name: string;
  /**
   * Its description: a new skill reaches every installed provider, and a provider can refuse to
   * load a skill without one.
   */
  description: NonBlankText;
  /**
   * The body of `SKILL.md`.
   */
  body: string;
  /**
   * Its icon, or `null` for the default mark.
   */
  icon?: string | null;
  /**
   * The other files.
   *
   * Items: A file written with this body: new to the folder, or changed.
   */
  files?: {
    /**
     * The file.
     */
    path: string;
    /**
     * Its body.
     */
    content: string;
  }[];
  /**
   * Every project, or one.
   */
  scope?: AgentDefinitionScope;
  /**
   * The project, on a project scope.
   */
  projectId?: ProjectId;
  /**
   * The key that makes a repeated create one skill, answering what the first saved.
   */
  clientIdempotencyKey: string;
}
/**
 * `skill.update`: the folder saved whole, applied together or not at all, and the same result
 * when saved twice. `description` and `body` rewrite `SKILL.md` and keep its other front-matter
 * keys; `files` and `removedPaths` never name `SKILL.md`; `icon` goes to our record. `name`
 * renames a folder of ours; a provider's own folder is edited in place and gains nothing of ours.
 */
export interface SkillUpdateRequest {
  /**
   * The skill.
   */
  skillId: SkillId;
  /**
   * Its new name.
   */
  name?: string;
  /**
   * Its description.
   */
  description: string;
  /**
   * The body of `SKILL.md`.
   */
  body: string;
  /**
   * The changed files.
   */
  files: SkillFileChange[];
  /**
   * The removed files.
   */
  removedPaths: string[];
  /**
   * Its icon, or `null` for the default mark.
   */
  icon: string | null;
}
/**
 * `skill.callForm.read`: the name a skill of ours would be called by, read while its name is typed
 * and before any save: the typed `name`, folded as `skill.create` folds it, at `scope` (default
 * `global`; a project scope names its project). `skillId` names the folder being edited, so it is
 * never its own collision; a new skill sends none.
 */
export interface SkillCallFormReadRequest {
  /**
   * The typed name.
   */
  name: string;
  /**
   * Every project, or one.
   */
  scope?: AgentDefinitionScope;
  /**
   * The project, on a project scope.
   */
  projectId?: ProjectId;
  /**
   * The folder being edited.
   */
  skillId?: SkillId;
}
/**
 * A provider whose name limit a skill's name passes, and that limit in characters: the details a
 * `skill.nameTooLong` refusal carries for the first provider the skill is on, and a scan's finding
 * for the provider it is widened onto.
 */
export interface SkillNameTooLongDetails {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The most characters that provider takes in a skill's name.
   */
  limit: number;
}
/**
 * The other folder of ours a name would share its packed name with, one global and one project.
 * Both still pack and nothing is refused; `callForms` is what the other folder is called by once
 * the typed one is saved, the project one taking the `-2` suffix.
 */
export interface SkillCallFormCollision {
  /**
   * The other folder's skill.
   */
  skillId: SkillId;
  /**
   * Its scope.
   */
  scope: AgentDefinitionScope;
  /**
   * Its folder.
   */
  folderPath: string;
  /**
   * The WSL 2 distribution the folder is in, its path in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * What it is called by once the typed one is saved.
   */
  callForms: SkillProviderCallForm[];
}
/**
 * What the typed name would be called by on each provider once saved, derived by the same code
 * that builds the session pack, and the folder it collides with, or `null` when none does.
 */
export interface SkillCallFormReadResponse {
  /**
   * What it would be called by.
   */
  callForms: SkillProviderCallForm[];
  /**
   * The folder it collides with, or `null`.
   */
  collision: SkillCallFormCollision | null;
}
/**
 * `skill.availability.update`: sets one provider on or off, with no lock: a provider's own skill
 * can be switched off its home provider, and a skill can be off everywhere.
 */
export interface SkillAvailabilityUpdateRequest {
  /**
   * The skill.
   */
  skillId: SkillId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * Whether it is on.
   */
  available: boolean;
}
/**
 * The availability the record now holds.
 */
export interface SkillAvailabilityUpdateResponse {
  /**
   * The availability.
   */
  availability: SkillProviderAvailability[];
}
/**
 * `skill.scan`: the scan a widening runs: the folder, and the provider it is widened onto.
 */
export interface SkillScanRequest {
  /**
   * The skill.
   */
  skillId: SkillId;
  /**
   * The provider it is widened onto.
   */
  provider: ProviderId;
}
/**
 * One tool of another provider that a file names: its name as words in sentence case, never its
 * wire spelling, and what will happen instead on the provider the skill is widened onto, in words.
 */
export interface SkillScanTool {
  /**
   * The tool, in words.
   */
  name: string;
  /**
   * What happens instead.
   */
  whatHappensInstead: string;
}
/**
 * What the scan found: each file it found another provider's tools or call sigil in, and the
 * skill's name where it is too long for the target provider; empty when it found neither. A read
 * that stores nothing: the warning it feeds is derived from the availability setting and never
 * kept.
 */
export interface SkillScanResponse {
  /**
   * The findings.
   */
  findings: SkillScanFinding[];
}
/**
 * `skill.record.reattach`: reattaches an orphaned record (its availability and icon) to a folder,
 * accepted only while the record is orphaned. The renderer sends the folder chooser's token and
 * main forwards the path in its place, so `folderPath` is the path the daemon reads.
 */
export interface SkillRecordReattachRequest {
  /**
   * The skill.
   */
  skillId: SkillId;
  /**
   * The folder, the path main's relay put in place of the chooser's token.
   */
  folderPath: string;
}
/**
 * `skill.record.discard`: drops an orphaned record.
 */
export interface SkillRecordDiscardRequest {
  /**
   * The skill.
   */
  skillId: SkillId;
}
/**
 * A discard's answer.
 */
export interface SkillRecordDiscardResponse {
  /**
   * Always true.
   */
  discarded: true;
}
/**
 * The `skill.pathRefused` refusal's details: the refused path and why, so the skill editor
 * answers in the row it was typed into.
 */
export interface SkillPathRefusedDetails {
  /**
   * The path.
   */
  path: string;
  /**
   * Why.
   */
  reason: SkillPathRefusedReason;
}
/**
 * The `skill.writeRefused` refusal's details.
 */
export interface SkillWriteRefusedDetails {
  /**
   * Why.
   */
  reason: SkillWriteRefusedReason;
}
/**
 * The `skill.nameTaken` refusal's details: the folder already holding the name, so the screen
 * names it under the Name field.
 */
export interface SkillNameTakenDetails {
  /**
   * The folder.
   */
  folderPath: string;
  /**
   * The WSL 2 distribution the folder is in, its path in Linux form; absent elsewhere.
   */
  place?: WslPlace;
}

/** The methods of {@link SKILL_METHOD_DESCRIPTORS}, each with its kind. */
export interface SkillMethodDescriptors {
  readonly "skill.list": {
    readonly method: "skill.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "skill.subscribe": {
    readonly method: "skill.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "skill.file.read": {
    readonly method: "skill.file.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "skill.create": {
    readonly method: "skill.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "skill.update": {
    readonly method: "skill.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "skill.callForm.read": {
    readonly method: "skill.callForm.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "skill.availability.update": {
    readonly method: "skill.availability.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "skill.scan": {
    readonly method: "skill.scan";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "skill.record.reattach": {
    readonly method: "skill.record.reattach";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "skill.record.discard": {
    readonly method: "skill.record.discard";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link SKILL_METHOD_DESCRIPTORS}. */
export interface SkillMethodTypes {
  readonly "skill.list": { readonly params: EmptyPayload; readonly result: SkillListResponse };
  readonly "skill.subscribe": {
    readonly params: EmptyPayload;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: SkillListResponse;
  };
  readonly "skill.file.read": {
    readonly params: SkillFileReadRequest;
    readonly result: SkillFileReadResponse;
  };
  readonly "skill.create": {
    readonly params: SkillCreateRequest;
    readonly result: SkillEntryResponse;
  };
  readonly "skill.update": {
    readonly params: SkillUpdateRequest;
    readonly result: SkillEntryResponse;
  };
  readonly "skill.callForm.read": {
    readonly params: SkillCallFormReadRequest;
    readonly result: SkillCallFormReadResponse;
  };
  readonly "skill.availability.update": {
    readonly params: SkillAvailabilityUpdateRequest;
    readonly result: SkillAvailabilityUpdateResponse;
  };
  readonly "skill.scan": { readonly params: SkillScanRequest; readonly result: SkillScanResponse };
  readonly "skill.record.reattach": {
    readonly params: SkillRecordReattachRequest;
    readonly result: SkillEntryResponse;
  };
  readonly "skill.record.discard": {
    readonly params: SkillRecordDiscardRequest;
    readonly result: SkillRecordDiscardResponse;
  };
}
/**
 * The `skill.*` methods. `skill.subscribe` resends the whole `skill.list` reply each time a
 * save from any window or the daemon's watch over the skill folders changes it.
 */
export const SKILL_METHOD_DESCRIPTORS: SkillMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "skill.list": /* @__PURE__ */ Object.freeze({
    method: "skill.list",
    procedureType: "query",
    mutating: false,
  }),
  "skill.subscribe": /* @__PURE__ */ Object.freeze({
    method: "skill.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "skill.file.read": /* @__PURE__ */ Object.freeze({
    method: "skill.file.read",
    procedureType: "query",
    mutating: false,
  }),
  "skill.create": /* @__PURE__ */ Object.freeze({
    method: "skill.create",
    procedureType: "mutation",
    mutating: true,
  }),
  "skill.update": /* @__PURE__ */ Object.freeze({
    method: "skill.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "skill.callForm.read": /* @__PURE__ */ Object.freeze({
    method: "skill.callForm.read",
    procedureType: "query",
    mutating: false,
  }),
  "skill.availability.update": /* @__PURE__ */ Object.freeze({
    method: "skill.availability.update",
    procedureType: "mutation",
    mutating: true,
  }),
  "skill.scan": /* @__PURE__ */ Object.freeze({
    method: "skill.scan",
    procedureType: "query",
    mutating: false,
  }),
  "skill.record.reattach": /* @__PURE__ */ Object.freeze({
    method: "skill.record.reattach",
    procedureType: "mutation",
    mutating: true,
  }),
  "skill.record.discard": /* @__PURE__ */ Object.freeze({
    method: "skill.record.discard",
    procedureType: "mutation",
    mutating: true,
  }),
});
