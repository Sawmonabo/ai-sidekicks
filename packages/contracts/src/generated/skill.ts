// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Skills: every skill folder, file reads and saves, call forms, availability per provider, the scan a widening runs, and their refusals.

import { type SchemaCheck, deepEqual, ucs2length } from "../schema-check.js";
import type { AgentDefinitionOrigin, AgentDefinitionScope } from "./agent/definition.js";
import type { NonBlankText } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
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

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
function validate2087(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillAvailabilityUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2087.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.skillId === undefined) && (missing0 = "skillId")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.available === undefined) && (missing0 = "available"))){validate2087.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "skillId") || (key0 === "provider")) || (key0 === "available"))){validate2087.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2087.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2087.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate2087.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2087.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.available !== undefined){const _errs10: any = errors;if(typeof data.available !== "boolean"){validate2087.errors = [{instancePath:instancePath+"/available",schemaPath:"#/properties/available/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2087.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2087.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2087.errors = null as any[] | null;
// prettier-ignore
validate2087.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2089(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2089.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.available === undefined) && (missing0 = "available"))){validate2089.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "available"))){validate2089.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate2089.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2089.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.available !== undefined){const _errs6: any = errors;if(typeof data.available !== "boolean"){validate2089.errors = [{instancePath:instancePath+"/available",schemaPath:"#/properties/available/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2089.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2089.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2089.errors = null as any[] | null;
// prettier-ignore
validate2089.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
function validate2088(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillAvailabilityUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2088.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.availability === undefined) && (missing0 = "availability")){validate2088.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "availability")){validate2088.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.availability !== undefined){let data0: any = data.availability;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2089.call(this, data0[i0], {instancePath:instancePath+"/availability/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2089.errors : vErrors.concat(validate2089.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}if(valid1){let i1: any = data0.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data0[i1], data0[j0])){validate2088.errors = [{instancePath:instancePath+"/availability",schemaPath:"#/properties/availability/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}else {validate2088.errors = [{instancePath:instancePath+"/availability",schemaPath:"#/properties/availability/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2088.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2088.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2088.errors = null as any[] | null;
// prettier-ignore
validate2088.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema81: any = {"description":"Whether a definition belongs to every project or to one.","type":"string","enum":["global","project"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate2091(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillCallFormReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2091.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs2: any = errors;let valid1: any = true;const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.scope === undefined) && (missing0 = "scope")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.scope !== undefined){if("project" !== data.scope){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs3 === errors;errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.projectId === undefined) && (missing1 = "projectId")){validate2091.errors = [{instancePath,schemaPath:"#/allOf/0/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}else {validate2091.errors = [{instancePath,schemaPath:"#/allOf/0/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs6 === errors;valid1 = _valid0;if(valid1){var props0: any = {};props0.projectId = true;props0.scope = true;}ifClause0 = "then";}else {const _errs8: any = errors;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.projectId === undefined) && (missing2 = "projectId")){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}else {const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var valid3: any = _errs10 === errors;if(valid3){validate2091.errors = [{instancePath,schemaPath:"#/allOf/0/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var _valid0: any = _errs8 === errors;valid1 = _valid0;ifClause0 = "else";}if(!valid1){const err5: any = {instancePath,schemaPath:"#/allOf/0/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate2091.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.name === undefined) && (missing3 = "name")){validate2091.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs12: any = errors;for(const key0 in data){if(!((((key0 === "name") || (key0 === "scope")) || (key0 === "projectId")) || (key0 === "skillId"))){validate2091.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs12 === errors){if(data.name !== undefined){let data1: any = data.name;const _errs13: any = errors;if(errors === _errs13){if(typeof data1 === "string"){if(func1(data1) > 128){validate2091.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate2091.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2091.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2091.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.scope !== undefined){let data2: any = data.scope;const _errs15: any = errors;if(typeof data2 !== "string"){validate2091.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "global") || (data2 === "project"))){validate2091.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/enum",keyword:"enum",params:{allowedValues: schema81.enum}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.projectId !== undefined){let data3: any = data.projectId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2091.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2091.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.skillId !== undefined){let data4: any = data.skillId;const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate2091.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2091.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}}}}}}}else {validate2091.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2091.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2091.errors = null as any[] | null;
// prettier-ignore
validate2091.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2093(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2093.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.callForm === undefined) && (missing0 = "callForm"))){validate2093.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "callForm"))){validate2093.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate2093.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2093.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.callForm !== undefined){let data1: any = data.callForm;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate2093.errors = [{instancePath:instancePath+"/callForm",schemaPath:"#/properties/callForm/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate2093.errors = [{instancePath:instancePath+"/callForm",schemaPath:"#/properties/callForm/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2093.errors = [{instancePath:instancePath+"/callForm",schemaPath:"#/properties/callForm/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2093.errors = [{instancePath:instancePath+"/callForm",schemaPath:"#/properties/callForm/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2093.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2093.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2093.errors = null as any[] | null;
// prettier-ignore
validate2093.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate2096(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2096.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.distro === undefined) && (missing0 = "distro")){validate2096.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "distro")){validate2096.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate2096.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate2096.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2096.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2096.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2096.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2096.errors = null as any[] | null;
// prettier-ignore
validate2096.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2095(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2095.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.skillId === undefined) && (missing0 = "skillId")) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.folderPath === undefined) && (missing0 = "folderPath"))) || ((data.callForms === undefined) && (missing0 = "callForms"))){validate2095.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "skillId") || (key0 === "scope")) || (key0 === "folderPath")) || (key0 === "place")) || (key0 === "callForms"))){validate2095.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2095.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2095.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data1: any = data.scope;const _errs6: any = errors;if(typeof data1 !== "string"){validate2095.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "global") || (data1 === "project"))){validate2095.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/enum",keyword:"enum",params:{allowedValues: schema81.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderPath !== undefined){let data2: any = data.folderPath;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 4096){validate2095.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate2095.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data2)){validate2095.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2095.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs11: any = errors;if(!(validate2096.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2096.errors : vErrors.concat(validate2096.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.callForms !== undefined){let data4: any = data.callForms;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data4)){var valid3: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs14: any = errors;if(!(validate2093.call(this, data4[i0], {instancePath:instancePath+"/callForms/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2093.errors : vErrors.concat(validate2093.errors);errors = vErrors.length;}var valid3: any = _errs14 === errors;if(!valid3){break;}}if(valid3){let i1: any = data4.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data4[i1], data4[j0])){validate2095.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}else {validate2095.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}else {validate2095.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2095.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2095.errors = null as any[] | null;
// prettier-ignore
validate2095.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2092(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillCallFormReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2092.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.callForms === undefined) && (missing0 = "callForms")) || ((data.collision === undefined) && (missing0 = "collision"))){validate2092.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "callForms") || (key0 === "collision"))){validate2092.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.callForms !== undefined){let data0: any = data.callForms;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2093.call(this, data0[i0], {instancePath:instancePath+"/callForms/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2093.errors : vErrors.concat(validate2093.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}if(valid1){let i1: any = data0.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data0[i1], data0[j0])){validate2092.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}else {validate2092.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.collision !== undefined){let data2: any = data.collision;const _errs5: any = errors;const _errs6: any = errors;let valid3: any = false;const _errs7: any = errors;if(!(validate2095.call(this, data2, {instancePath:instancePath+"/collision",parentData:data,parentDataProperty:"collision",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2095.errors : vErrors.concat(validate2095.errors);errors = vErrors.length;}var _valid0: any = _errs7 === errors;valid3 = valid3 || _valid0;const _errs8: any = errors;if(data2 !== null){const err0: any = {instancePath:instancePath+"/collision",schemaPath:"#/properties/collision/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs8 === errors;valid3 = valid3 || _valid0;if(!valid3){const err1: any = {instancePath:instancePath+"/collision",schemaPath:"#/properties/collision/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate2092.errors = vErrors;return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2092.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2092.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2092.errors = null as any[] | null;
// prettier-ignore
validate2092.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4099: any = {"type":"object","additionalProperties":false,"properties":{"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"Its name."},"description":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/NonBlankText","description":"Its description: a new skill reaches every installed provider, and a provider can refuse to\nload a skill without one."},"body":{"type":"string","description":"The body of `SKILL.md`."},"icon":{"type":["string","null"],"minLength":1,"description":"Its icon, or `null` for the default mark."},"files":{"type":"array","items":{"description":"A file written with this body: new to the folder, or changed.","type":"object","properties":{"path":{"description":"The file.","type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1},"content":{"description":"Its body.","type":"string"}},"additionalProperties":false,"required":["path","content"]},"description":"The other files."},"scope":{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope","description":"Every project, or one."},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project, on a project scope."},"clientIdempotencyKey":{"type":"string","pattern":"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$","description":"The key that makes a repeated create one skill, answering what the first saved."}},"required":["name","description","body","clientIdempotencyKey"],"description":"`skill.create`: a new skill, written whole in one save under the scope's\n`.ai-sidekicks/skills/`: the name folded into the folder name (case folded, anything but letters\nand digits to hyphens), and a colliding folder suffixed rather than overwritten; a folder named\n`new` keeps its name. `description` and `body` become `SKILL.md` and `files` are the other\nfiles. It is available on every installed provider. `scope` defaults to `global`; a project\nscope names its project.","allOf":[{"if":{"type":"object","properties":{"scope":{"const":"project"}},"required":["scope"]},"then":{"type":"object","properties":{"projectId":{}},"required":["projectId"]},"else":{"not":{"type":"object","properties":{"projectId":{}},"required":["projectId"]}}}]};
// prettier-ignore
const pattern323 = new RegExp("[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]", "u");
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
function validate2100(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2100.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs2: any = errors;let valid1: any = true;const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.scope === undefined) && (missing0 = "scope")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.scope !== undefined){if("project" !== data.scope){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs3 === errors;errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.projectId === undefined) && (missing1 = "projectId")){validate2100.errors = [{instancePath,schemaPath:"#/allOf/0/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}else {validate2100.errors = [{instancePath,schemaPath:"#/allOf/0/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs6 === errors;valid1 = _valid0;if(valid1){var props0: any = {};props0.projectId = true;props0.scope = true;}ifClause0 = "then";}else {const _errs8: any = errors;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.projectId === undefined) && (missing2 = "projectId")){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}else {const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var valid3: any = _errs10 === errors;if(valid3){validate2100.errors = [{instancePath,schemaPath:"#/allOf/0/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var _valid0: any = _errs8 === errors;valid1 = _valid0;ifClause0 = "else";}if(!valid1){const err5: any = {instancePath,schemaPath:"#/allOf/0/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate2100.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.name === undefined) && (missing3 = "name")) || ((data.description === undefined) && (missing3 = "description"))) || ((data.body === undefined) && (missing3 = "body"))) || ((data.clientIdempotencyKey === undefined) && (missing3 = "clientIdempotencyKey"))){validate2100.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs12: any = errors;for(const key0 in data){if(!((((((((key0 === "name") || (key0 === "description")) || (key0 === "body")) || (key0 === "icon")) || (key0 === "files")) || (key0 === "scope")) || (key0 === "projectId")) || (key0 === "clientIdempotencyKey"))){validate2100.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs12 === errors){if(data.name !== undefined){let data1: any = data.name;const _errs13: any = errors;if(errors === _errs13){if(typeof data1 === "string"){if(func1(data1) > 128){validate2100.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate2100.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2100.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2100.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.description !== undefined){let data2: any = data.description;const _errs15: any = errors;const _errs16: any = errors;if(errors === _errs16){if(typeof data2 === "string"){if(!pattern323.test(data2)){validate2100.errors = [{instancePath:instancePath+"/description",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/NonBlankText/pattern",keyword:"pattern",params:{pattern: "[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"}}];return false;}}else {validate2100.errors = [{instancePath:instancePath+"/description",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/NonBlankText/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.body !== undefined){const _errs18: any = errors;if(typeof data.body !== "string"){validate2100.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.icon !== undefined){let data4: any = data.icon;const _errs20: any = errors;if((typeof data4 !== "string") && (data4 !== null)){validate2100.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/type",keyword:"type",params:{type: schema4099.properties.icon.type}}];return false;}if(errors === _errs20){if(typeof data4 === "string"){if(func1(data4) < 1){validate2100.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.files !== undefined){let data5: any = data.files;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data5)){var valid6: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){let data6: any = data5[i0];const _errs24: any = errors;if(errors === _errs24){if(data6 && typeof data6 == "object" && !Array.isArray(data6)){let missing4: any;if(((data6.path === undefined) && (missing4 = "path")) || ((data6.content === undefined) && (missing4 = "content"))){validate2100.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/properties/files/items/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs26: any = errors;for(const key1 in data6){if(!((key1 === "path") || (key1 === "content"))){validate2100.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/properties/files/items/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs26 === errors){if(data6.path !== undefined){let data7: any = data6.path;const _errs27: any = errors;if(errors === _errs27){if(typeof data7 === "string"){if(func1(data7) > 4096){validate2100.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/properties/files/items/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validate2100.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/properties/files/items/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data7)){validate2100.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/properties/files/items/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2100.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/properties/files/items/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data6.content !== undefined){const _errs29: any = errors;if(typeof data6.content !== "string"){validate2100.errors = [{instancePath:instancePath+"/files/" + i0+"/content",schemaPath:"#/properties/files/items/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}var valid7: any = _errs29 === errors;}else {var valid7: any = true;}}}}}else {validate2100.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/properties/files/items/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs24 === errors;if(!valid6){break;}}}else {validate2100.errors = [{instancePath:instancePath+"/files",schemaPath:"#/properties/files/type",keyword:"type",params:{type: "array"}}];return false;}}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.scope !== undefined){let data9: any = data.scope;const _errs31: any = errors;if(typeof data9 !== "string"){validate2100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data9 === "global") || (data9 === "project"))){validate2100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/enum",keyword:"enum",params:{allowedValues: schema81.enum}}];return false;}var valid4: any = _errs31 === errors;}else {var valid4: any = true;}if(valid4){if(data.projectId !== undefined){let data10: any = data.projectId;const _errs34: any = errors;const _errs35: any = errors;if(errors === _errs35){if(typeof data10 === "string"){if(!pattern4.test(data10)){validate2100.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2100.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs34 === errors;}else {var valid4: any = true;}if(valid4){if(data.clientIdempotencyKey !== undefined){let data11: any = data.clientIdempotencyKey;const _errs38: any = errors;if(errors === _errs38){if(typeof data11 === "string"){if(!pattern222.test(data11)){validate2100.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate2100.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs38 === errors;}else {var valid4: any = true;}}}}}}}}}}}else {validate2100.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2100.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2100.errors = null as any[] | null;
// prettier-ignore
validate2100.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4104: any = {"type":"object","additionalProperties":false,"properties":{"skillId":{"$ref":"#/$defs/SkillId","description":"The skill."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":4096,"description":"The front matter's name, or the folder's where it has none."},"description":{"type":["string","null"],"description":"`null` when `SKILL.md` carries none, or the record is orphaned."},"icon":{"type":["string","null"],"minLength":1,"description":"A glyph key kept in our record on every origin; `null` draws the default mark."},"origin":{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionOrigin","description":"Which files it came from."},"originProvider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider, on a provider's own skill."},"pluginName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The plugin, on a plugin's skill."},"scope":{"$ref":"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope","description":"Every project, or one."},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project, on a project skill."},"folderPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The folder, or for an orphaned record the last path it was known at."},"place":{"$ref":"sidekicks-contracts:place#/$defs/WslPlace","description":"The WSL 2 distribution the folder is in, its path in Linux form; absent elsewhere."},"files":{"type":"array","items":{"$ref":"#/$defs/SkillFile"},"description":"Every file in the folder; empty for an orphaned record."},"availability":{"type":"array","items":{"$ref":"#/$defs/SkillProviderAvailability"},"uniqueItems":true,"description":"Which providers it reaches."},"callForms":{"type":"array","items":{"$ref":"#/$defs/SkillProviderCallForm"},"uniqueItems":true,"description":"What a person types to call it."},"orphaned":{"type":"boolean","description":"The folder was renamed or deleted outside the app; the record keeps its availability and\nicon until it is reattached or discarded."},"disabledInProvider":{"type":"array","items":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId"},"description":"The providers whose own configuration switches it off."},"loadError":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":1024,"description":"The daemon's own parse failed, with the reason; `null` otherwise."}},"required":["skillId","name","description","icon","origin","scope","folderPath","files","availability","callForms","orphaned","disabledInProvider","loadError"],"description":"One skill as the list serves it. A provider's own skill names its provider, a plugin's skill,\nwhich is read-only, names its plugin, and no other does either; a project skill names its\nproject and no other does.","allOf":[{"if":{"type":"object","properties":{"origin":{"const":"provider"}},"required":["origin"]},"then":{"type":"object","properties":{"originProvider":{}},"required":["originProvider"]},"else":{"not":{"type":"object","properties":{"originProvider":{}},"required":["originProvider"]}}},{"if":{"type":"object","properties":{"origin":{"const":"plugin"}},"required":["origin"]},"then":{"type":"object","properties":{"pluginName":{}},"required":["pluginName"]},"else":{"not":{"type":"object","properties":{"pluginName":{}},"required":["pluginName"]}}},{"if":{"type":"object","properties":{"scope":{"const":"project"}},"required":["scope"]},"then":{"type":"object","properties":{"projectId":{}},"required":["projectId"]},"else":{"not":{"type":"object","properties":{"projectId":{}},"required":["projectId"]}}}]};
// prettier-ignore
const schema100: any = {"description":"Which files a definition came from: ours, a provider's own, whose provider the entry names in\n`originProvider`, or a plugin's, which is read-only.","type":"string","enum":["ours","provider","plugin"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate2102(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2102.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;const _errs2: any = errors;let valid1: any = true;const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.origin === undefined) && (missing0 = "origin")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.origin !== undefined){if("provider" !== data.origin){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs3 === errors;errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.originProvider === undefined) && (missing1 = "originProvider")){validate2102.errors = [{instancePath,schemaPath:"#/allOf/0/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}else {validate2102.errors = [{instancePath,schemaPath:"#/allOf/0/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs6 === errors;valid1 = _valid0;if(valid1){var props0: any = {};props0.originProvider = true;props0.origin = true;}ifClause0 = "then";}else {const _errs8: any = errors;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.originProvider === undefined) && (missing2 = "originProvider")){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}else {const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var valid3: any = _errs10 === errors;if(valid3){validate2102.errors = [{instancePath,schemaPath:"#/allOf/0/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var _valid0: any = _errs8 === errors;valid1 = _valid0;ifClause0 = "else";}if(!valid1){const err5: any = {instancePath,schemaPath:"#/allOf/0/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate2102.errors = vErrors;return false;}var valid0: any = _errs1 === errors;if(valid0){const _errs12: any = errors;const _errs13: any = errors;let valid4: any = true;const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.origin === undefined) && (missing3 = "origin")){const err6: any = {};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(data.origin !== undefined){if("plugin" !== data.origin){const err7: any = {};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}}}else {const err8: any = {};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid1: any = _errs14 === errors;errors = _errs13;if(vErrors !== null){if(_errs13){vErrors.length = _errs13;}else {vErrors = null;}}let ifClause1: any;if(_valid1){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.pluginName === undefined) && (missing4 = "pluginName")){validate2102.errors = [{instancePath,schemaPath:"#/allOf/1/then/required",keyword:"required",params:{missingProperty: missing4}}];return false;}}else {validate2102.errors = [{instancePath,schemaPath:"#/allOf/1/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid1: any = _errs17 === errors;valid4 = _valid1;if(valid4){var props1: any = {};props1.pluginName = true;props1.origin = true;}ifClause1 = "then";}else {const _errs19: any = errors;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((data.pluginName === undefined) && (missing5 = "pluginName")){const err9: any = {};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}else {const err10: any = {};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var valid6: any = _errs21 === errors;if(valid6){validate2102.errors = [{instancePath,schemaPath:"#/allOf/1/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs20;if(vErrors !== null){if(_errs20){vErrors.length = _errs20;}else {vErrors = null;}}}var _valid1: any = _errs19 === errors;valid4 = _valid1;ifClause1 = "else";}if(!valid4){const err11: any = {instancePath,schemaPath:"#/allOf/1/if",keyword:"if",params:{failingKeyword: ifClause1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validate2102.errors = vErrors;return false;}var valid0: any = _errs12 === errors;if(valid0){if(props0 !== true && props1 !== undefined){if(props1 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props1);}}const _errs23: any = errors;const _errs24: any = errors;let valid7: any = true;const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((data.scope === undefined) && (missing6 = "scope")){const err12: any = {};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {if(data.scope !== undefined){if("project" !== data.scope){const err13: any = {};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}}}else {const err14: any = {};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var _valid2: any = _errs25 === errors;errors = _errs24;if(vErrors !== null){if(_errs24){vErrors.length = _errs24;}else {vErrors = null;}}let ifClause2: any;if(_valid2){const _errs28: any = errors;if(errors === _errs28){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((data.projectId === undefined) && (missing7 = "projectId")){validate2102.errors = [{instancePath,schemaPath:"#/allOf/2/then/required",keyword:"required",params:{missingProperty: missing7}}];return false;}}else {validate2102.errors = [{instancePath,schemaPath:"#/allOf/2/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid2: any = _errs28 === errors;valid7 = _valid2;if(valid7){var props2: any = {};props2.projectId = true;props2.scope = true;}ifClause2 = "then";}else {const _errs30: any = errors;const _errs31: any = errors;const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing8: any;if((data.projectId === undefined) && (missing8 = "projectId")){const err15: any = {};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}else {const err16: any = {};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var valid9: any = _errs32 === errors;if(valid9){validate2102.errors = [{instancePath,schemaPath:"#/allOf/2/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs31;if(vErrors !== null){if(_errs31){vErrors.length = _errs31;}else {vErrors = null;}}}var _valid2: any = _errs30 === errors;valid7 = _valid2;ifClause2 = "else";}if(!valid7){const err17: any = {instancePath,schemaPath:"#/allOf/2/if",keyword:"if",params:{failingKeyword: ifClause2}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;validate2102.errors = vErrors;return false;}var valid0: any = _errs23 === errors;if(valid0){if(props0 !== true && props2 !== undefined){if(props2 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props2);}}}}}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing9: any;if((((((((((((((data.skillId === undefined) && (missing9 = "skillId")) || ((data.name === undefined) && (missing9 = "name"))) || ((data.description === undefined) && (missing9 = "description"))) || ((data.icon === undefined) && (missing9 = "icon"))) || ((data.origin === undefined) && (missing9 = "origin"))) || ((data.scope === undefined) && (missing9 = "scope"))) || ((data.folderPath === undefined) && (missing9 = "folderPath"))) || ((data.files === undefined) && (missing9 = "files"))) || ((data.availability === undefined) && (missing9 = "availability"))) || ((data.callForms === undefined) && (missing9 = "callForms"))) || ((data.orphaned === undefined) && (missing9 = "orphaned"))) || ((data.disabledInProvider === undefined) && (missing9 = "disabledInProvider"))) || ((data.loadError === undefined) && (missing9 = "loadError"))){validate2102.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing9}}];return false;}else {const _errs34: any = errors;for(const key0 in data){if(!(func2.call(schema4104.properties, key0))){validate2102.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs34 === errors){if(data.skillId !== undefined){let data3: any = data.skillId;const _errs35: any = errors;const _errs36: any = errors;if(errors === _errs36){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2102.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2102.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs35 === errors;}else {var valid10: any = true;}if(valid10){if(data.name !== undefined){let data4: any = data.name;const _errs39: any = errors;if(errors === _errs39){if(typeof data4 === "string"){if(func1(data4) > 4096){validate2102.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validate2102.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate2102.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2102.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs39 === errors;}else {var valid10: any = true;}if(valid10){if(data.description !== undefined){let data5: any = data.description;const _errs41: any = errors;if((typeof data5 !== "string") && (data5 !== null)){validate2102.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: schema4104.properties.description.type}}];return false;}var valid10: any = _errs41 === errors;}else {var valid10: any = true;}if(valid10){if(data.icon !== undefined){let data6: any = data.icon;const _errs43: any = errors;if((typeof data6 !== "string") && (data6 !== null)){validate2102.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/type",keyword:"type",params:{type: schema4104.properties.icon.type}}];return false;}if(errors === _errs43){if(typeof data6 === "string"){if(func1(data6) < 1){validate2102.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid10: any = _errs43 === errors;}else {var valid10: any = true;}if(valid10){if(data.origin !== undefined){let data7: any = data.origin;const _errs45: any = errors;if(typeof data7 !== "string"){validate2102.errors = [{instancePath:instancePath+"/origin",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionOrigin/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data7 === "ours") || (data7 === "provider")) || (data7 === "plugin"))){validate2102.errors = [{instancePath:instancePath+"/origin",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionOrigin/enum",keyword:"enum",params:{allowedValues: schema100.enum}}];return false;}var valid10: any = _errs45 === errors;}else {var valid10: any = true;}if(valid10){if(data.originProvider !== undefined){let data8: any = data.originProvider;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(typeof data8 === "string"){if(!pattern16.test(data8)){validate2102.errors = [{instancePath:instancePath+"/originProvider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2102.errors = [{instancePath:instancePath+"/originProvider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs48 === errors;}else {var valid10: any = true;}if(valid10){if(data.pluginName !== undefined){let data9: any = data.pluginName;const _errs52: any = errors;if(errors === _errs52){if(typeof data9 === "string"){if(func1(data9) > 128){validate2102.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data9) < 1){validate2102.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data9)){validate2102.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2102.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs52 === errors;}else {var valid10: any = true;}if(valid10){if(data.scope !== undefined){let data10: any = data.scope;const _errs54: any = errors;if(typeof data10 !== "string"){validate2102.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data10 === "global") || (data10 === "project"))){validate2102.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/enum",keyword:"enum",params:{allowedValues: schema81.enum}}];return false;}var valid10: any = _errs54 === errors;}else {var valid10: any = true;}if(valid10){if(data.projectId !== undefined){let data11: any = data.projectId;const _errs57: any = errors;const _errs58: any = errors;if(errors === _errs58){if(typeof data11 === "string"){if(!pattern4.test(data11)){validate2102.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2102.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs57 === errors;}else {var valid10: any = true;}if(valid10){if(data.folderPath !== undefined){let data12: any = data.folderPath;const _errs61: any = errors;if(errors === _errs61){if(typeof data12 === "string"){if(func1(data12) > 4096){validate2102.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data12) < 1){validate2102.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data12)){validate2102.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2102.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs61 === errors;}else {var valid10: any = true;}if(valid10){if(data.place !== undefined){const _errs63: any = errors;if(!(validate2096.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2096.errors : vErrors.concat(validate2096.errors);errors = vErrors.length;}var valid10: any = _errs63 === errors;}else {var valid10: any = true;}if(valid10){if(data.files !== undefined){let data14: any = data.files;const _errs64: any = errors;if(errors === _errs64){if(Array.isArray(data14)){var valid16: any = true;const len0: any = data14.length;for(let i0=0; i0<len0; i0++){let data15: any = data14[i0];const _errs66: any = errors;const _errs67: any = errors;if(errors === _errs67){if(data15 && typeof data15 == "object" && !Array.isArray(data15)){let missing10: any;if((((data15.path === undefined) && (missing10 = "path")) || ((data15.size === undefined) && (missing10 = "size"))) || ((data15.readable === undefined) && (missing10 = "readable"))){validate2102.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFile/required",keyword:"required",params:{missingProperty: missing10}}];return false;}else {const _errs69: any = errors;for(const key1 in data15){if(!(((key1 === "path") || (key1 === "size")) || (key1 === "readable"))){validate2102.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFile/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs69 === errors){if(data15.path !== undefined){let data16: any = data15.path;const _errs70: any = errors;if(errors === _errs70){if(typeof data16 === "string"){if(func1(data16) > 4096){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data16) < 1){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data16)){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs70 === errors;}else {var valid18: any = true;}if(valid18){if(data15.size !== undefined){let data17: any = data15.size;const _errs72: any = errors;if(!(((typeof data17 == "number") && (!(data17 % 1) && !isNaN(data17))) && (isFinite(data17)))){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/size",schemaPath:"#/$defs/SkillFile/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs72){if((typeof data17 == "number") && (isFinite(data17))){if(data17 > 9007199254740991 || isNaN(data17)){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/size",schemaPath:"#/$defs/SkillFile/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data17 < 0 || isNaN(data17)){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/size",schemaPath:"#/$defs/SkillFile/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid18: any = _errs72 === errors;}else {var valid18: any = true;}if(valid18){if(data15.readable !== undefined){const _errs74: any = errors;if(typeof data15.readable !== "boolean"){validate2102.errors = [{instancePath:instancePath+"/files/" + i0+"/readable",schemaPath:"#/$defs/SkillFile/properties/readable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid18: any = _errs74 === errors;}else {var valid18: any = true;}}}}}}else {validate2102.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFile/type",keyword:"type",params:{type: "object"}}];return false;}}var valid16: any = _errs66 === errors;if(!valid16){break;}}}else {validate2102.errors = [{instancePath:instancePath+"/files",schemaPath:"#/properties/files/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs64 === errors;}else {var valid10: any = true;}if(valid10){if(data.availability !== undefined){let data19: any = data.availability;const _errs76: any = errors;if(errors === _errs76){if(Array.isArray(data19)){var valid19: any = true;const len1: any = data19.length;for(let i1=0; i1<len1; i1++){const _errs78: any = errors;if(!(validate2089.call(this, data19[i1], {instancePath:instancePath+"/availability/" + i1,parentData:data19,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2089.errors : vErrors.concat(validate2089.errors);errors = vErrors.length;}var valid19: any = _errs78 === errors;if(!valid19){break;}}if(valid19){let i2: any = data19.length;let j0: any;if(i2 > 1){outer0:for(;i2--;){for(j0 = i2; j0--;){if(func0(data19[i2], data19[j0])){validate2102.errors = [{instancePath:instancePath+"/availability",schemaPath:"#/properties/availability/uniqueItems",keyword:"uniqueItems",params:{i: i2, j: j0}}];return false;break outer0;}}}}}}else {validate2102.errors = [{instancePath:instancePath+"/availability",schemaPath:"#/properties/availability/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs76 === errors;}else {var valid10: any = true;}if(valid10){if(data.callForms !== undefined){let data21: any = data.callForms;const _errs79: any = errors;if(errors === _errs79){if(Array.isArray(data21)){var valid21: any = true;const len2: any = data21.length;for(let i3=0; i3<len2; i3++){const _errs81: any = errors;if(!(validate2093.call(this, data21[i3], {instancePath:instancePath+"/callForms/" + i3,parentData:data21,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2093.errors : vErrors.concat(validate2093.errors);errors = vErrors.length;}var valid21: any = _errs81 === errors;if(!valid21){break;}}if(valid21){let i4: any = data21.length;let j1: any;if(i4 > 1){outer1:for(;i4--;){for(j1 = i4; j1--;){if(func0(data21[i4], data21[j1])){validate2102.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/uniqueItems",keyword:"uniqueItems",params:{i: i4, j: j1}}];return false;break outer1;}}}}}}else {validate2102.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs79 === errors;}else {var valid10: any = true;}if(valid10){if(data.orphaned !== undefined){const _errs82: any = errors;if(typeof data.orphaned !== "boolean"){validate2102.errors = [{instancePath:instancePath+"/orphaned",schemaPath:"#/properties/orphaned/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs82 === errors;}else {var valid10: any = true;}if(valid10){if(data.disabledInProvider !== undefined){let data24: any = data.disabledInProvider;const _errs84: any = errors;if(errors === _errs84){if(Array.isArray(data24)){var valid23: any = true;const len3: any = data24.length;for(let i5=0; i5<len3; i5++){let data25: any = data24[i5];const _errs86: any = errors;const _errs87: any = errors;if(errors === _errs87){if(typeof data25 === "string"){if(!pattern16.test(data25)){validate2102.errors = [{instancePath:instancePath+"/disabledInProvider/" + i5,schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2102.errors = [{instancePath:instancePath+"/disabledInProvider/" + i5,schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid23: any = _errs86 === errors;if(!valid23){break;}}}else {validate2102.errors = [{instancePath:instancePath+"/disabledInProvider",schemaPath:"#/properties/disabledInProvider/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs84 === errors;}else {var valid10: any = true;}if(valid10){if(data.loadError !== undefined){let data26: any = data.loadError;const _errs90: any = errors;if((typeof data26 !== "string") && (data26 !== null)){validate2102.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/type",keyword:"type",params:{type: schema4104.properties.loadError.type}}];return false;}if(errors === _errs90){if(typeof data26 === "string"){if(func1(data26) > 1024){validate2102.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data26) < 1){validate2102.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data26)){validate2102.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid10: any = _errs90 === errors;}else {var valid10: any = true;}}}}}}}}}}}}}}}}}}}}else {validate2102.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2102.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2102.errors = null as any[] | null;
// prettier-ignore
validate2102.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2101(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillEntryResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2101.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.skill === undefined) && (missing0 = "skill")){validate2101.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "skill")){validate2101.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skill !== undefined){if(!(validate2102.call(this, data.skill, {instancePath:instancePath+"/skill",parentData:data,parentDataProperty:"skill",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2102.errors : vErrors.concat(validate2102.errors);errors = vErrors.length;}}}}}else {validate2101.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2101.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2101.errors = null as any[] | null;
// prettier-ignore
validate2101.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2107(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillFileChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2107.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.content === undefined) && (missing0 = "content"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "content"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs4: any = errors;if(errors === _errs4){if(typeof data0 === "string"){if(func1(data0) > 4096){const err2: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data0) < 1){const err3: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(!pattern43.test(data0)){const err4: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/0/properties/path/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.content !== undefined){const _errs6: any = errors;if(typeof data.content !== "string"){const err6: any = {instancePath:instancePath+"/content",schemaPath:"#/anyOf/0/properties/content/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}}}}}else {const err7: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.path === undefined) && (missing1 = "path")) || ((data.renamedFrom === undefined) && (missing1 = "renamedFrom"))){const err8: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}else {const _errs10: any = errors;for(const key1 in data){if(!(((key1 === "path") || (key1 === "renamedFrom")) || (key1 === "content"))){const err9: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;break;}}if(_errs10 === errors){if(data.path !== undefined){let data2: any = data.path;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 4096){const err10: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(func1(data2) < 1){const err11: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(!pattern43.test(data2)){const err12: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}}else {const err13: any = {instancePath:instancePath+"/path",schemaPath:"#/anyOf/1/properties/path/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.renamedFrom !== undefined){let data3: any = data.renamedFrom;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) > 4096){const err14: any = {instancePath:instancePath+"/renamedFrom",schemaPath:"#/anyOf/1/properties/renamedFrom/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {if(func1(data3) < 1){const err15: any = {instancePath:instancePath+"/renamedFrom",schemaPath:"#/anyOf/1/properties/renamedFrom/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(!pattern43.test(data3)){const err16: any = {instancePath:instancePath+"/renamedFrom",schemaPath:"#/anyOf/1/properties/renamedFrom/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}}}else {const err17: any = {instancePath:instancePath+"/renamedFrom",schemaPath:"#/anyOf/1/properties/renamedFrom/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.content !== undefined){const _errs15: any = errors;if(typeof data.content !== "string"){const err18: any = {instancePath:instancePath+"/content",schemaPath:"#/anyOf/1/properties/content/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}}}}}}else {const err19: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var _valid0: any = _errs8 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err20: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;validate2107.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate2107.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate2107.errors = null as any[] | null;
// prettier-ignore
validate2107.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate2108(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillFileReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2108.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.skillId === undefined) && (missing0 = "skillId")) || ((data.path === undefined) && (missing0 = "path"))){validate2108.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "skillId") || (key0 === "path"))){validate2108.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2108.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2108.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate2108.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate2108.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate2108.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2108.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2108.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2108.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2108.errors = null as any[] | null;
// prettier-ignore
validate2108.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2109(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillFileReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2109.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.content === undefined) && (missing0 = "content")){validate2109.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "content")){validate2109.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.content !== undefined){if(typeof data.content !== "string"){validate2109.errors = [{instancePath:instancePath+"/content",schemaPath:"#/properties/content/type",keyword:"type",params:{type: "string"}}];return false;}}}}}else {validate2109.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2109.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2109.errors = null as any[] | null;
// prettier-ignore
validate2109.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2110(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2110.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate2110.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2110.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2110.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2110.errors = null as any[] | null;
// prettier-ignore
validate2110.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2111(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2111.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;const _errs2: any = errors;let valid1: any = true;const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.origin === undefined) && (missing0 = "origin")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.origin !== undefined){if("provider" !== data.origin){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs3 === errors;errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.originProvider === undefined) && (missing1 = "originProvider")){validate2111.errors = [{instancePath,schemaPath:"#/allOf/0/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}else {validate2111.errors = [{instancePath,schemaPath:"#/allOf/0/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs6 === errors;valid1 = _valid0;if(valid1){var props0: any = {};props0.originProvider = true;props0.origin = true;}ifClause0 = "then";}else {const _errs8: any = errors;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.originProvider === undefined) && (missing2 = "originProvider")){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}else {const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var valid3: any = _errs10 === errors;if(valid3){validate2111.errors = [{instancePath,schemaPath:"#/allOf/0/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var _valid0: any = _errs8 === errors;valid1 = _valid0;ifClause0 = "else";}if(!valid1){const err5: any = {instancePath,schemaPath:"#/allOf/0/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate2111.errors = vErrors;return false;}var valid0: any = _errs1 === errors;if(valid0){const _errs12: any = errors;const _errs13: any = errors;let valid4: any = true;const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((data.origin === undefined) && (missing3 = "origin")){const err6: any = {};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(data.origin !== undefined){if("plugin" !== data.origin){const err7: any = {};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}}}else {const err8: any = {};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid1: any = _errs14 === errors;errors = _errs13;if(vErrors !== null){if(_errs13){vErrors.length = _errs13;}else {vErrors = null;}}let ifClause1: any;if(_valid1){const _errs17: any = errors;if(errors === _errs17){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((data.pluginName === undefined) && (missing4 = "pluginName")){validate2111.errors = [{instancePath,schemaPath:"#/allOf/1/then/required",keyword:"required",params:{missingProperty: missing4}}];return false;}}else {validate2111.errors = [{instancePath,schemaPath:"#/allOf/1/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid1: any = _errs17 === errors;valid4 = _valid1;if(valid4){var props1: any = {};props1.pluginName = true;props1.origin = true;}ifClause1 = "then";}else {const _errs19: any = errors;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if((data.pluginName === undefined) && (missing5 = "pluginName")){const err9: any = {};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}else {const err10: any = {};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var valid6: any = _errs21 === errors;if(valid6){validate2111.errors = [{instancePath,schemaPath:"#/allOf/1/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs20;if(vErrors !== null){if(_errs20){vErrors.length = _errs20;}else {vErrors = null;}}}var _valid1: any = _errs19 === errors;valid4 = _valid1;ifClause1 = "else";}if(!valid4){const err11: any = {instancePath,schemaPath:"#/allOf/1/if",keyword:"if",params:{failingKeyword: ifClause1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validate2111.errors = vErrors;return false;}var valid0: any = _errs12 === errors;if(valid0){if(props0 !== true && props1 !== undefined){if(props1 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props1);}}const _errs23: any = errors;const _errs24: any = errors;let valid7: any = true;const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if((data.scope === undefined) && (missing6 = "scope")){const err12: any = {};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {if(data.scope !== undefined){if("project" !== data.scope){const err13: any = {};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}}}else {const err14: any = {};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var _valid2: any = _errs25 === errors;errors = _errs24;if(vErrors !== null){if(_errs24){vErrors.length = _errs24;}else {vErrors = null;}}let ifClause2: any;if(_valid2){const _errs28: any = errors;if(errors === _errs28){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if((data.projectId === undefined) && (missing7 = "projectId")){validate2111.errors = [{instancePath,schemaPath:"#/allOf/2/then/required",keyword:"required",params:{missingProperty: missing7}}];return false;}}else {validate2111.errors = [{instancePath,schemaPath:"#/allOf/2/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid2: any = _errs28 === errors;valid7 = _valid2;if(valid7){var props2: any = {};props2.projectId = true;props2.scope = true;}ifClause2 = "then";}else {const _errs30: any = errors;const _errs31: any = errors;const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing8: any;if((data.projectId === undefined) && (missing8 = "projectId")){const err15: any = {};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}else {const err16: any = {};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var valid9: any = _errs32 === errors;if(valid9){validate2111.errors = [{instancePath,schemaPath:"#/allOf/2/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs31;if(vErrors !== null){if(_errs31){vErrors.length = _errs31;}else {vErrors = null;}}}var _valid2: any = _errs30 === errors;valid7 = _valid2;ifClause2 = "else";}if(!valid7){const err17: any = {instancePath,schemaPath:"#/allOf/2/if",keyword:"if",params:{failingKeyword: ifClause2}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;validate2111.errors = vErrors;return false;}var valid0: any = _errs23 === errors;if(valid0){if(props0 !== true && props2 !== undefined){if(props2 === true){props0 = true;}else {props0 = props0 || {};Object.assign(props0, props2);}}}}}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing9: any;if((((((((((((((data.skillId === undefined) && (missing9 = "skillId")) || ((data.name === undefined) && (missing9 = "name"))) || ((data.description === undefined) && (missing9 = "description"))) || ((data.icon === undefined) && (missing9 = "icon"))) || ((data.origin === undefined) && (missing9 = "origin"))) || ((data.scope === undefined) && (missing9 = "scope"))) || ((data.folderPath === undefined) && (missing9 = "folderPath"))) || ((data.files === undefined) && (missing9 = "files"))) || ((data.availability === undefined) && (missing9 = "availability"))) || ((data.callForms === undefined) && (missing9 = "callForms"))) || ((data.orphaned === undefined) && (missing9 = "orphaned"))) || ((data.disabledInProvider === undefined) && (missing9 = "disabledInProvider"))) || ((data.loadError === undefined) && (missing9 = "loadError"))){validate2111.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing9}}];return false;}else {const _errs34: any = errors;for(const key0 in data){if(!(func2.call(schema4104.properties, key0))){validate2111.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs34 === errors){if(data.skillId !== undefined){let data3: any = data.skillId;const _errs35: any = errors;const _errs36: any = errors;if(errors === _errs36){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2111.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2111.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs35 === errors;}else {var valid10: any = true;}if(valid10){if(data.name !== undefined){let data4: any = data.name;const _errs39: any = errors;if(errors === _errs39){if(typeof data4 === "string"){if(func1(data4) > 4096){validate2111.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data4) < 1){validate2111.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate2111.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2111.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs39 === errors;}else {var valid10: any = true;}if(valid10){if(data.description !== undefined){let data5: any = data.description;const _errs41: any = errors;if((typeof data5 !== "string") && (data5 !== null)){validate2111.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: schema4104.properties.description.type}}];return false;}var valid10: any = _errs41 === errors;}else {var valid10: any = true;}if(valid10){if(data.icon !== undefined){let data6: any = data.icon;const _errs43: any = errors;if((typeof data6 !== "string") && (data6 !== null)){validate2111.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/type",keyword:"type",params:{type: schema4104.properties.icon.type}}];return false;}if(errors === _errs43){if(typeof data6 === "string"){if(func1(data6) < 1){validate2111.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid10: any = _errs43 === errors;}else {var valid10: any = true;}if(valid10){if(data.origin !== undefined){let data7: any = data.origin;const _errs45: any = errors;if(typeof data7 !== "string"){validate2111.errors = [{instancePath:instancePath+"/origin",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionOrigin/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data7 === "ours") || (data7 === "provider")) || (data7 === "plugin"))){validate2111.errors = [{instancePath:instancePath+"/origin",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionOrigin/enum",keyword:"enum",params:{allowedValues: schema100.enum}}];return false;}var valid10: any = _errs45 === errors;}else {var valid10: any = true;}if(valid10){if(data.originProvider !== undefined){let data8: any = data.originProvider;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(typeof data8 === "string"){if(!pattern16.test(data8)){validate2111.errors = [{instancePath:instancePath+"/originProvider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2111.errors = [{instancePath:instancePath+"/originProvider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs48 === errors;}else {var valid10: any = true;}if(valid10){if(data.pluginName !== undefined){let data9: any = data.pluginName;const _errs52: any = errors;if(errors === _errs52){if(typeof data9 === "string"){if(func1(data9) > 128){validate2111.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data9) < 1){validate2111.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data9)){validate2111.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2111.errors = [{instancePath:instancePath+"/pluginName",schemaPath:"#/properties/pluginName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs52 === errors;}else {var valid10: any = true;}if(valid10){if(data.scope !== undefined){let data10: any = data.scope;const _errs54: any = errors;if(typeof data10 !== "string"){validate2111.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data10 === "global") || (data10 === "project"))){validate2111.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentDefinitionScope/enum",keyword:"enum",params:{allowedValues: schema81.enum}}];return false;}var valid10: any = _errs54 === errors;}else {var valid10: any = true;}if(valid10){if(data.projectId !== undefined){let data11: any = data.projectId;const _errs57: any = errors;const _errs58: any = errors;if(errors === _errs58){if(typeof data11 === "string"){if(!pattern4.test(data11)){validate2111.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2111.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs57 === errors;}else {var valid10: any = true;}if(valid10){if(data.folderPath !== undefined){let data12: any = data.folderPath;const _errs61: any = errors;if(errors === _errs61){if(typeof data12 === "string"){if(func1(data12) > 4096){validate2111.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data12) < 1){validate2111.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data12)){validate2111.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2111.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs61 === errors;}else {var valid10: any = true;}if(valid10){if(data.place !== undefined){const _errs63: any = errors;if(!(validate2096.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2096.errors : vErrors.concat(validate2096.errors);errors = vErrors.length;}var valid10: any = _errs63 === errors;}else {var valid10: any = true;}if(valid10){if(data.files !== undefined){let data14: any = data.files;const _errs64: any = errors;if(errors === _errs64){if(Array.isArray(data14)){var valid16: any = true;const len0: any = data14.length;for(let i0=0; i0<len0; i0++){let data15: any = data14[i0];const _errs66: any = errors;const _errs67: any = errors;if(errors === _errs67){if(data15 && typeof data15 == "object" && !Array.isArray(data15)){let missing10: any;if((((data15.path === undefined) && (missing10 = "path")) || ((data15.size === undefined) && (missing10 = "size"))) || ((data15.readable === undefined) && (missing10 = "readable"))){validate2111.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFile/required",keyword:"required",params:{missingProperty: missing10}}];return false;}else {const _errs69: any = errors;for(const key1 in data15){if(!(((key1 === "path") || (key1 === "size")) || (key1 === "readable"))){validate2111.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFile/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs69 === errors){if(data15.path !== undefined){let data16: any = data15.path;const _errs70: any = errors;if(errors === _errs70){if(typeof data16 === "string"){if(func1(data16) > 4096){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data16) < 1){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data16)){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFile/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs70 === errors;}else {var valid18: any = true;}if(valid18){if(data15.size !== undefined){let data17: any = data15.size;const _errs72: any = errors;if(!(((typeof data17 == "number") && (!(data17 % 1) && !isNaN(data17))) && (isFinite(data17)))){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/size",schemaPath:"#/$defs/SkillFile/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs72){if((typeof data17 == "number") && (isFinite(data17))){if(data17 > 9007199254740991 || isNaN(data17)){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/size",schemaPath:"#/$defs/SkillFile/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data17 < 0 || isNaN(data17)){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/size",schemaPath:"#/$defs/SkillFile/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid18: any = _errs72 === errors;}else {var valid18: any = true;}if(valid18){if(data15.readable !== undefined){const _errs74: any = errors;if(typeof data15.readable !== "boolean"){validate2111.errors = [{instancePath:instancePath+"/files/" + i0+"/readable",schemaPath:"#/$defs/SkillFile/properties/readable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid18: any = _errs74 === errors;}else {var valid18: any = true;}}}}}}else {validate2111.errors = [{instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFile/type",keyword:"type",params:{type: "object"}}];return false;}}var valid16: any = _errs66 === errors;if(!valid16){break;}}}else {validate2111.errors = [{instancePath:instancePath+"/files",schemaPath:"#/properties/files/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs64 === errors;}else {var valid10: any = true;}if(valid10){if(data.availability !== undefined){let data19: any = data.availability;const _errs76: any = errors;if(errors === _errs76){if(Array.isArray(data19)){var valid19: any = true;const len1: any = data19.length;for(let i1=0; i1<len1; i1++){const _errs78: any = errors;if(!(validate2089.call(this, data19[i1], {instancePath:instancePath+"/availability/" + i1,parentData:data19,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2089.errors : vErrors.concat(validate2089.errors);errors = vErrors.length;}var valid19: any = _errs78 === errors;if(!valid19){break;}}if(valid19){let i2: any = data19.length;let j0: any;if(i2 > 1){outer0:for(;i2--;){for(j0 = i2; j0--;){if(func0(data19[i2], data19[j0])){validate2111.errors = [{instancePath:instancePath+"/availability",schemaPath:"#/properties/availability/uniqueItems",keyword:"uniqueItems",params:{i: i2, j: j0}}];return false;break outer0;}}}}}}else {validate2111.errors = [{instancePath:instancePath+"/availability",schemaPath:"#/properties/availability/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs76 === errors;}else {var valid10: any = true;}if(valid10){if(data.callForms !== undefined){let data21: any = data.callForms;const _errs79: any = errors;if(errors === _errs79){if(Array.isArray(data21)){var valid21: any = true;const len2: any = data21.length;for(let i3=0; i3<len2; i3++){const _errs81: any = errors;if(!(validate2093.call(this, data21[i3], {instancePath:instancePath+"/callForms/" + i3,parentData:data21,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2093.errors : vErrors.concat(validate2093.errors);errors = vErrors.length;}var valid21: any = _errs81 === errors;if(!valid21){break;}}if(valid21){let i4: any = data21.length;let j1: any;if(i4 > 1){outer1:for(;i4--;){for(j1 = i4; j1--;){if(func0(data21[i4], data21[j1])){validate2111.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/uniqueItems",keyword:"uniqueItems",params:{i: i4, j: j1}}];return false;break outer1;}}}}}}else {validate2111.errors = [{instancePath:instancePath+"/callForms",schemaPath:"#/properties/callForms/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs79 === errors;}else {var valid10: any = true;}if(valid10){if(data.orphaned !== undefined){const _errs82: any = errors;if(typeof data.orphaned !== "boolean"){validate2111.errors = [{instancePath:instancePath+"/orphaned",schemaPath:"#/properties/orphaned/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs82 === errors;}else {var valid10: any = true;}if(valid10){if(data.disabledInProvider !== undefined){let data24: any = data.disabledInProvider;const _errs84: any = errors;if(errors === _errs84){if(Array.isArray(data24)){var valid23: any = true;const len3: any = data24.length;for(let i5=0; i5<len3; i5++){let data25: any = data24[i5];const _errs86: any = errors;const _errs87: any = errors;if(errors === _errs87){if(typeof data25 === "string"){if(!pattern16.test(data25)){validate2111.errors = [{instancePath:instancePath+"/disabledInProvider/" + i5,schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2111.errors = [{instancePath:instancePath+"/disabledInProvider/" + i5,schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid23: any = _errs86 === errors;if(!valid23){break;}}}else {validate2111.errors = [{instancePath:instancePath+"/disabledInProvider",schemaPath:"#/properties/disabledInProvider/type",keyword:"type",params:{type: "array"}}];return false;}}var valid10: any = _errs84 === errors;}else {var valid10: any = true;}if(valid10){if(data.loadError !== undefined){let data26: any = data.loadError;const _errs90: any = errors;if((typeof data26 !== "string") && (data26 !== null)){validate2111.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/type",keyword:"type",params:{type: schema4104.properties.loadError.type}}];return false;}if(errors === _errs90){if(typeof data26 === "string"){if(func1(data26) > 1024){validate2111.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data26) < 1){validate2111.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data26)){validate2111.errors = [{instancePath:instancePath+"/loadError",schemaPath:"#/properties/loadError/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid10: any = _errs90 === errors;}else {var valid10: any = true;}}}}}}}}}}}}}}}}}}}}else {validate2111.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2111.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2111.errors = null as any[] | null;
// prettier-ignore
validate2111.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2115(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2115.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.skills === undefined) && (missing0 = "skills")){validate2115.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "skills")){validate2115.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skills !== undefined){let data0: any = data.skills;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2102.call(this, data0[i0], {instancePath:instancePath+"/skills/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2102.errors : vErrors.concat(validate2102.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2115.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2115.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2115.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2115.errors = null as any[] | null;
// prettier-ignore
validate2115.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4127: any = {"description":"Why `skill.pathRefused` refused. A save's path would land outside the folder, the folder\nalready holds it, or it names `SKILL.md`, which a folder always has exactly one of and which is\nnever replaced, renamed or removed. A send's picked skill matches no row of `skill.list` by name\nand folder, so the provider is never handed a file the daemon does not list.","type":"string","enum":["escapesFolder","duplicatePath","namesEntryFile","notListed"]};
// prettier-ignore
function validate2117(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillPathRefusedDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2117.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.path === undefined) && (missing0 = "path")) || ((data.reason === undefined) && (missing0 = "reason"))){validate2117.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "path") || (key0 === "reason"))){validate2117.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.path !== undefined){let data0: any = data.path;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate2117.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}}else {validate2117.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data1: any = data.reason;const _errs4: any = errors;if(typeof data1 !== "string"){validate2117.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/SkillPathRefusedReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data1 === "escapesFolder") || (data1 === "duplicatePath")) || (data1 === "namesEntryFile")) || (data1 === "notListed"))){validate2117.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/SkillPathRefusedReason/enum",keyword:"enum",params:{allowedValues: schema4127.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate2117.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2117.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2117.errors = null as any[] | null;
// prettier-ignore
validate2117.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2118(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillRecordDiscardRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2118.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.skillId === undefined) && (missing0 = "skillId")){validate2118.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "skillId")){validate2118.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2118.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2118.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2118.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2118.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2118.errors = null as any[] | null;
// prettier-ignore
validate2118.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2119(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillRecordDiscardResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2119.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.discarded === undefined) && (missing0 = "discarded")){validate2119.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "discarded")){validate2119.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.discarded !== undefined){let data0: any = data.discarded;if(typeof data0 !== "boolean"){validate2119.errors = [{instancePath:instancePath+"/discarded",schemaPath:"#/properties/discarded/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate2119.errors = [{instancePath:instancePath+"/discarded",schemaPath:"#/properties/discarded/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate2119.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2119.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2119.errors = null as any[] | null;
// prettier-ignore
validate2119.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2120(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillRecordReattachRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2120.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.skillId === undefined) && (missing0 = "skillId")) || ((data.folderPath === undefined) && (missing0 = "folderPath"))){validate2120.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "skillId") || (key0 === "folderPath"))){validate2120.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2120.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2120.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderPath !== undefined){let data1: any = data.folderPath;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate2120.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate2120.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate2120.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2120.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2120.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2120.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2120.errors = null as any[] | null;
// prettier-ignore
validate2120.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2121(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillScanRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2121.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.skillId === undefined) && (missing0 = "skillId")) || ((data.provider === undefined) && (missing0 = "provider"))){validate2121.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "skillId") || (key0 === "provider"))){validate2121.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2121.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2121.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate2121.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2121.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2121.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2121.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2121.errors = null as any[] | null;
// prettier-ignore
validate2121.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2123(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2123.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "file"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.path === undefined) && (missing0 = "path"))) || ((data.tools === undefined) && (missing0 = "tools"))) || ((data.callSigil === undefined) && (missing0 = "callSigil"))){validate2123.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "kind") || (key0 === "path")) || (key0 === "tools")) || (key0 === "callSigil"))){validate2123.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate2123.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("file" !== data0){validate2123.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "file"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.path !== undefined){let data1: any = data.path;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 4096){validate2123.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate2123.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate2123.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2123.errors = [{instancePath:instancePath+"/path",schemaPath:"#/oneOf/0/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.tools !== undefined){let data2: any = data.tools;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data2)){var valid3: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){let data3: any = data2[i0];const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if(((data3.name === undefined) && (missing1 = "name")) || ((data3.whatHappensInstead === undefined) && (missing1 = "whatHappensInstead"))){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/SkillScanTool/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data3){if(!((key1 === "name") || (key1 === "whatHappensInstead"))){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/SkillScanTool/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data3.name !== undefined){let data4: any = data3.name;const _errs15: any = errors;if(errors === _errs15){if(typeof data4 === "string"){if(func1(data4) > 128){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/SkillScanTool/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/SkillScanTool/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/SkillScanTool/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/name",schemaPath:"#/$defs/SkillScanTool/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data3.whatHappensInstead !== undefined){let data5: any = data3.whatHappensInstead;const _errs17: any = errors;if(errors === _errs17){if(typeof data5 === "string"){if(func1(data5) > 1024){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/whatHappensInstead",schemaPath:"#/$defs/SkillScanTool/properties/whatHappensInstead/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data5) < 1){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/whatHappensInstead",schemaPath:"#/$defs/SkillScanTool/properties/whatHappensInstead/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/whatHappensInstead",schemaPath:"#/$defs/SkillScanTool/properties/whatHappensInstead/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2123.errors = [{instancePath:instancePath+"/tools/" + i0+"/whatHappensInstead",schemaPath:"#/$defs/SkillScanTool/properties/whatHappensInstead/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}}}}}else {validate2123.errors = [{instancePath:instancePath+"/tools/" + i0,schemaPath:"#/$defs/SkillScanTool/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs11 === errors;if(!valid3){break;}}}else {validate2123.errors = [{instancePath:instancePath+"/tools",schemaPath:"#/oneOf/0/properties/tools/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.callSigil !== undefined){const _errs19: any = errors;if(typeof data.callSigil !== "boolean"){validate2123.errors = [{instancePath:instancePath+"/callSigil",schemaPath:"#/oneOf/0/properties/callSigil/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}}}}}}}else {validate2123.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "nameTooLong"){const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.provider === undefined) && (missing2 = "provider"))) || ((data.limit === undefined) && (missing2 = "limit"))){validate2123.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "provider")) || (key2 === "limit"))){validate2123.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs23 === errors){if(data.kind !== undefined){let data7: any = data.kind;const _errs24: any = errors;if(typeof data7 !== "string"){validate2123.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("nameTooLong" !== data7){validate2123.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "nameTooLong"}}];return false;}var valid7: any = _errs24 === errors;}else {var valid7: any = true;}if(valid7){if(data.provider !== undefined){let data8: any = data.provider;const _errs26: any = errors;const _errs27: any = errors;if(errors === _errs27){if(typeof data8 === "string"){if(!pattern16.test(data8)){validate2123.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2123.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs26 === errors;}else {var valid7: any = true;}if(valid7){if(data.limit !== undefined){let data9: any = data.limit;const _errs30: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate2123.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/oneOf/1/properties/limit/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate2123.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/oneOf/1/properties/limit/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 1 || isNaN(data9)){validate2123.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/oneOf/1/properties/limit/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid7: any = _errs30 === errors;}else {var valid7: any = true;}}}}}}else {validate2123.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else {validate2123.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2123.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validate2123.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate2123.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2123.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2123.errors = null as any[] | null;
// prettier-ignore
validate2123.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2122(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillScanResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2122.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.findings === undefined) && (missing0 = "findings")){validate2122.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "findings")){validate2122.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.findings !== undefined){let data0: any = data.findings;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2123.call(this, data0[i0], {instancePath:instancePath+"/findings/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2123.errors : vErrors.concat(validate2123.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2122.errors = [{instancePath:instancePath+"/findings",schemaPath:"#/properties/findings/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2122.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2122.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2122.errors = null as any[] | null;
// prettier-ignore
validate2122.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4140: any = {"type":"object","additionalProperties":false,"properties":{"skillId":{"$ref":"#/$defs/SkillId","description":"The skill."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"Its new name."},"description":{"type":"string","description":"Its description."},"body":{"type":"string","description":"The body of `SKILL.md`."},"files":{"type":"array","items":{"$ref":"#/$defs/SkillFileChange"},"description":"The changed files."},"removedPaths":{"type":"array","items":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1},"description":"The removed files."},"icon":{"type":["string","null"],"minLength":1,"description":"Its icon, or `null` for the default mark."}},"required":["skillId","description","body","files","removedPaths","icon"],"description":"`skill.update`: the folder saved whole, applied together or not at all, and the same result\nwhen saved twice. `description` and `body` rewrite `SKILL.md` and keep its other front-matter\nkeys; `files` and `removedPaths` never name `SKILL.md`; `icon` goes to our record. `name`\nrenames a folder of ours; a provider's own folder is edited in place and gains nothing of ours."};
// prettier-ignore
function validate2125(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SkillUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2125.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.skillId === undefined) && (missing0 = "skillId")) || ((data.description === undefined) && (missing0 = "description"))) || ((data.body === undefined) && (missing0 = "body"))) || ((data.files === undefined) && (missing0 = "files"))) || ((data.removedPaths === undefined) && (missing0 = "removedPaths"))) || ((data.icon === undefined) && (missing0 = "icon"))){validate2125.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "skillId") || (key0 === "name")) || (key0 === "description")) || (key0 === "body")) || (key0 === "files")) || (key0 === "removedPaths")) || (key0 === "icon"))){validate2125.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.skillId !== undefined){let data0: any = data.skillId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2125.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2125.errors = [{instancePath:instancePath+"/skillId",schemaPath:"#/$defs/SkillId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate2125.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate2125.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2125.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate2125.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs8: any = errors;if(typeof data.description !== "string"){validate2125.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.body !== undefined){const _errs10: any = errors;if(typeof data.body !== "string"){validate2125.errors = [{instancePath:instancePath+"/body",schemaPath:"#/properties/body/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.files !== undefined){let data4: any = data.files;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data4)){var valid2: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){let data5: any = data4[i0];const _errs14: any = errors;const _errs16: any = errors;let valid4: any = false;const _errs17: any = errors;if(errors === _errs17){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing1: any;if(((data5.path === undefined) && (missing1 = "path")) || ((data5.content === undefined) && (missing1 = "content"))){const err0: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf/0/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs19: any = errors;for(const key1 in data5){if(!((key1 === "path") || (key1 === "content"))){const err1: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs19 === errors){if(data5.path !== undefined){let data6: any = data5.path;const _errs20: any = errors;if(errors === _errs20){if(typeof data6 === "string"){if(func1(data6) > 4096){const err2: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/0/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data6) < 1){const err3: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/0/properties/path/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(!pattern43.test(data6)){const err4: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/0/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/0/properties/path/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}if(valid5){if(data5.content !== undefined){const _errs22: any = errors;if(typeof data5.content !== "string"){const err6: any = {instancePath:instancePath+"/files/" + i0+"/content",schemaPath:"#/$defs/SkillFileChange/anyOf/0/properties/content/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}}}}}else {const err7: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var _valid0: any = _errs17 === errors;valid4 = valid4 || _valid0;if(_valid0){var props0: any = true;}const _errs24: any = errors;if(errors === _errs24){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing2: any;if(((data5.path === undefined) && (missing2 = "path")) || ((data5.renamedFrom === undefined) && (missing2 = "renamedFrom"))){const err8: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}else {const _errs26: any = errors;for(const key2 in data5){if(!(((key2 === "path") || (key2 === "renamedFrom")) || (key2 === "content"))){const err9: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;break;}}if(_errs26 === errors){if(data5.path !== undefined){let data8: any = data5.path;const _errs27: any = errors;if(errors === _errs27){if(typeof data8 === "string"){if(func1(data8) > 4096){const err10: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(func1(data8) < 1){const err11: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/path/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(!pattern43.test(data8)){const err12: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}}else {const err13: any = {instancePath:instancePath+"/files/" + i0+"/path",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/path/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data5.renamedFrom !== undefined){let data9: any = data5.renamedFrom;const _errs29: any = errors;if(errors === _errs29){if(typeof data9 === "string"){if(func1(data9) > 4096){const err14: any = {instancePath:instancePath+"/files/" + i0+"/renamedFrom",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/renamedFrom/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {if(func1(data9) < 1){const err15: any = {instancePath:instancePath+"/files/" + i0+"/renamedFrom",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/renamedFrom/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {if(!pattern43.test(data9)){const err16: any = {instancePath:instancePath+"/files/" + i0+"/renamedFrom",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/renamedFrom/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}}}else {const err17: any = {instancePath:instancePath+"/files/" + i0+"/renamedFrom",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/renamedFrom/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var valid6: any = _errs29 === errors;}else {var valid6: any = true;}if(valid6){if(data5.content !== undefined){const _errs31: any = errors;if(typeof data5.content !== "string"){const err18: any = {instancePath:instancePath+"/files/" + i0+"/content",schemaPath:"#/$defs/SkillFileChange/anyOf/1/properties/content/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}var valid6: any = _errs31 === errors;}else {var valid6: any = true;}}}}}}else {const err19: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var _valid0: any = _errs24 === errors;valid4 = valid4 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid4){const err20: any = {instancePath:instancePath+"/files/" + i0,schemaPath:"#/$defs/SkillFileChange/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;validate2125.errors = vErrors;return false;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs14 === errors;if(!valid2){break;}}}else {validate2125.errors = [{instancePath:instancePath+"/files",schemaPath:"#/properties/files/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.removedPaths !== undefined){let data11: any = data.removedPaths;const _errs33: any = errors;if(errors === _errs33){if(Array.isArray(data11)){var valid7: any = true;const len1: any = data11.length;for(let i1=0; i1<len1; i1++){let data12: any = data11[i1];const _errs35: any = errors;if(errors === _errs35){if(typeof data12 === "string"){if(func1(data12) > 4096){validate2125.errors = [{instancePath:instancePath+"/removedPaths/" + i1,schemaPath:"#/properties/removedPaths/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data12) < 1){validate2125.errors = [{instancePath:instancePath+"/removedPaths/" + i1,schemaPath:"#/properties/removedPaths/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data12)){validate2125.errors = [{instancePath:instancePath+"/removedPaths/" + i1,schemaPath:"#/properties/removedPaths/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate2125.errors = [{instancePath:instancePath+"/removedPaths/" + i1,schemaPath:"#/properties/removedPaths/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs35 === errors;if(!valid7){break;}}}else {validate2125.errors = [{instancePath:instancePath+"/removedPaths",schemaPath:"#/properties/removedPaths/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs33 === errors;}else {var valid0: any = true;}if(valid0){if(data.icon !== undefined){let data13: any = data.icon;const _errs37: any = errors;if((typeof data13 !== "string") && (data13 !== null)){validate2125.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/type",keyword:"type",params:{type: schema4140.properties.icon.type}}];return false;}if(errors === _errs37){if(typeof data13 === "string"){if(func1(data13) < 1){validate2125.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs37 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate2125.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2125.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2125.errors = null as any[] | null;
// prettier-ignore
validate2125.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SkillAvailabilityUpdateRequest}. */
export const validateSkillAvailabilityUpdateRequest: SchemaCheck<SkillAvailabilityUpdateRequest> =
  validate2087;
/** Checks that a value is a {@link SkillAvailabilityUpdateResponse}. */
export const validateSkillAvailabilityUpdateResponse: SchemaCheck<SkillAvailabilityUpdateResponse> =
  validate2088;
/** Checks that a value is a {@link SkillCallFormReadRequest}. */
export const validateSkillCallFormReadRequest: SchemaCheck<SkillCallFormReadRequest> = validate2091;
/** Checks that a value is a {@link SkillCallFormReadResponse}. */
export const validateSkillCallFormReadResponse: SchemaCheck<SkillCallFormReadResponse> =
  validate2092;
/** Checks that a value is a {@link SkillCreateRequest}. */
export const validateSkillCreateRequest: SchemaCheck<SkillCreateRequest> = validate2100;
/** Checks that a value is a {@link SkillEntryResponse}. */
export const validateSkillEntryResponse: SchemaCheck<SkillEntryResponse> = validate2101;
/** Checks that a value is a {@link SkillFileChange}. */
export const validateSkillFileChange: SchemaCheck<SkillFileChange> = validate2107;
/** Checks that a value is a {@link SkillFileReadRequest}. */
export const validateSkillFileReadRequest: SchemaCheck<SkillFileReadRequest> = validate2108;
/** Checks that a value is a {@link SkillFileReadResponse}. */
export const validateSkillFileReadResponse: SchemaCheck<SkillFileReadResponse> = validate2109;
/** Checks that a value is a {@link SkillId}. */
export const validateSkillId: SchemaCheck<SkillId> = validate2110;
/** Checks that a value is a {@link SkillListEntry}. */
export const validateSkillListEntry: SchemaCheck<SkillListEntry> = validate2111;
/** Checks that a value is a {@link SkillListResponse}. */
export const validateSkillListResponse: SchemaCheck<SkillListResponse> = validate2115;
/** Checks that a value is a {@link SkillPathRefusedDetails}. */
export const validateSkillPathRefusedDetails: SchemaCheck<SkillPathRefusedDetails> = validate2117;
/** Checks that a value is a {@link SkillRecordDiscardRequest}. */
export const validateSkillRecordDiscardRequest: SchemaCheck<SkillRecordDiscardRequest> =
  validate2118;
/** Checks that a value is a {@link SkillRecordDiscardResponse}. */
export const validateSkillRecordDiscardResponse: SchemaCheck<SkillRecordDiscardResponse> =
  validate2119;
/** Checks that a value is a {@link SkillRecordReattachRequest}. */
export const validateSkillRecordReattachRequest: SchemaCheck<SkillRecordReattachRequest> =
  validate2120;
/** Checks that a value is a {@link SkillScanRequest}. */
export const validateSkillScanRequest: SchemaCheck<SkillScanRequest> = validate2121;
/** Checks that a value is a {@link SkillScanResponse}. */
export const validateSkillScanResponse: SchemaCheck<SkillScanResponse> = validate2122;
/** Checks that a value is a {@link SkillUpdateRequest}. */
export const validateSkillUpdateRequest: SchemaCheck<SkillUpdateRequest> = validate2125;

/** The methods of {@link SKILL_METHOD_DESCRIPTORS}, each with its checks. */
export interface SkillMethodDescriptors {
  readonly "skill.list": {
    readonly method: "skill.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SkillListResponse>;
  };
  readonly "skill.subscribe": {
    readonly method: "skill.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SkillListResponse>;
  };
  readonly "skill.file.read": {
    readonly method: "skill.file.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SkillFileReadRequest>;
    readonly responseCheck: SchemaCheck<SkillFileReadResponse>;
  };
  readonly "skill.create": {
    readonly method: "skill.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SkillCreateRequest>;
    readonly responseCheck: SchemaCheck<SkillEntryResponse>;
  };
  readonly "skill.update": {
    readonly method: "skill.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SkillUpdateRequest>;
    readonly responseCheck: SchemaCheck<SkillEntryResponse>;
  };
  readonly "skill.callForm.read": {
    readonly method: "skill.callForm.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SkillCallFormReadRequest>;
    readonly responseCheck: SchemaCheck<SkillCallFormReadResponse>;
  };
  readonly "skill.availability.update": {
    readonly method: "skill.availability.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SkillAvailabilityUpdateRequest>;
    readonly responseCheck: SchemaCheck<SkillAvailabilityUpdateResponse>;
  };
  readonly "skill.scan": {
    readonly method: "skill.scan";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SkillScanRequest>;
    readonly responseCheck: SchemaCheck<SkillScanResponse>;
  };
  readonly "skill.record.reattach": {
    readonly method: "skill.record.reattach";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SkillRecordReattachRequest>;
    readonly responseCheck: SchemaCheck<SkillEntryResponse>;
  };
  readonly "skill.record.discard": {
    readonly method: "skill.record.discard";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SkillRecordDiscardRequest>;
    readonly responseCheck: SchemaCheck<SkillRecordDiscardResponse>;
  };
}
/**
 * The `skill.*` methods. `skill.subscribe` resends the whole `skill.list` reply each time a
 * save from any window or the daemon's watch over the skill folders changes it.
 */
export const SKILL_METHOD_DESCRIPTORS: SkillMethodDescriptors = Object.freeze({
  "skill.list": Object.freeze({
    method: "skill.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSkillListResponse,
  }),
  "skill.subscribe": Object.freeze({
    method: "skill.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateSkillListResponse,
  }),
  "skill.file.read": Object.freeze({
    method: "skill.file.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSkillFileReadRequest,
    responseCheck: validateSkillFileReadResponse,
  }),
  "skill.create": Object.freeze({
    method: "skill.create",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSkillCreateRequest,
    responseCheck: validateSkillEntryResponse,
  }),
  "skill.update": Object.freeze({
    method: "skill.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSkillUpdateRequest,
    responseCheck: validateSkillEntryResponse,
  }),
  "skill.callForm.read": Object.freeze({
    method: "skill.callForm.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSkillCallFormReadRequest,
    responseCheck: validateSkillCallFormReadResponse,
  }),
  "skill.availability.update": Object.freeze({
    method: "skill.availability.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSkillAvailabilityUpdateRequest,
    responseCheck: validateSkillAvailabilityUpdateResponse,
  }),
  "skill.scan": Object.freeze({
    method: "skill.scan",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSkillScanRequest,
    responseCheck: validateSkillScanResponse,
  }),
  "skill.record.reattach": Object.freeze({
    method: "skill.record.reattach",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSkillRecordReattachRequest,
    responseCheck: validateSkillEntryResponse,
  }),
  "skill.record.discard": Object.freeze({
    method: "skill.record.discard",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSkillRecordDiscardRequest,
    responseCheck: validateSkillRecordDiscardResponse,
  }),
});
