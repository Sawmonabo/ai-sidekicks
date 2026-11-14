// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A project: the durable record beside a mount that the person names, with its setup steps, its own environment rows and its own branch pattern.

import { type CompiledSchemaCheck, ucs2length } from "../schema-check.js";
import {
  type BranchNamePattern,
  type EnvironmentRow,
  validateBranchNamePattern,
  validateEnvironmentRow,
} from "./machine/settings.js";
import { type Place, validatePlace } from "./place.js";
import { type RepoMountId, validateRepoMountId } from "./repo/mount.js";
import { type SessionId, validateSessionId } from "./session/id.js";

/** The longest project name the daemon keeps. */
export const PROJECT_NAME_MAX_LEN = 256 as const;

/**
 * The longest setup command the daemon keeps: a command line the person types, bounded
 * generously so no command a shell accepts is refused for its length.
 */
export const PROJECT_SETUP_COMMAND_MAX_LEN = 8192 as const;

/**
 * The daemon-minted id of a project: the record beside a mount that the person names.
 */
export type ProjectId = string & { readonly __brand: "ProjectId" };
/**
 * A project's life: `cloning` from the first press of `Clone` until the clone attaches (a failed
 * or canceled clone stays `cloning`, so it can be run again), then `active`, and `archived` while
 * it sits in the archived group.
 */
export type ProjectState = "cloning" | "active" | "archived";

/**
 * What runs after a worktree is made in the project: files copied into the new tree, then
 * commands run in order, each given up on after the time limit when one is set. The steps run
 * with the repository's own git config, its hooks included, and never raise an approval, so only
 * the person writes them.
 */
export interface ProjectSetup {
  /**
   * Paths inside the repository copied into each new tree.
   */
  filesToCopy: string[];
  /**
   * Commands run in order.
   */
  commands: string[];
  /**
   * Seconds each command is given up on after; absent means no limit. At most 2^31 − 1 ms in
   * whole seconds, the longest delay a timer keeps.
   */
  timeLimitSeconds?: number;
}
/**
 * How many of a project's sessions are running, waiting on the person and done.
 */
export interface ProjectSessionTally {
  /**
   * Running.
   */
  running: number;
  /**
   * Waiting on the person.
   */
  waiting: number;
  /**
   * Done.
   */
  done: number;
}
/**
 * One project as the Projects page and the session list's project headers draw it.
 */
export interface ProjectListEntry {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * `null` while the project is still cloning; the mount is made when the clone attaches.
   */
  repoMountId: RepoMountId | null;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its folder, in its place's own form.
   */
  folderPath: string;
  /**
   * Its life.
   */
  state: ProjectState;
  /**
   * How many sessions it has.
   */
  sessionCount: number;
  /**
   * A session with an agent running anywhere in the project, or `null`.
   */
  runningSessionId: SessionId | null;
  /**
   * How many of its sessions are running, waiting on the person and done.
   */
  sessionTally: ProjectSessionTally;
  /**
   * Its setup steps.
   */
  setup: ProjectSetup;
  /**
   * The project's own rows, each winning over the `Every project` row of the same name.
   */
  environmentRows: EnvironmentRow[];
  /**
   * `null` while the project follows the machine's pattern.
   */
  branchPattern: BranchNamePattern | null;
  /**
   * Where its folder is and its sessions run, fixed at attach; absent on macOS and Linux.
   */
  place?: Place;
  /**
   * Present when the project's distribution is no longer on this computer, so its sessions
   * cannot run and the row offers `Remove`.
   */
  isDistributionRemoved?: true;
}
/**
 * One `project.subscribe` emission: every project, sent once on subscribe and again on each
 * change, so a project attached or cloned from another device appears at once.
 */
export interface ProjectList {
  /**
   * Every project.
   */
  projects: ProjectListEntry[];
}
/**
 * The project an edit acts on, as every project edit's reply returns it.
 */
export interface ProjectEditResponse {
  /**
   * The project as edited.
   */
  project: ProjectListEntry;
}
/**
 * `project.rename`: the project's display name; the folder on disk is untouched.
 */
export interface ProjectRenameRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its new name.
   */
  name: string;
}
/**
 * `project.archive` and `project.reactivate`: the project to move into or out of the
 * archived group. Its sessions are kept either way, and archiving an archived project, or
 * reactivating an active one, changes nothing.
 */
export interface ProjectStateChangeRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
}
/**
 * `project.setup.update`: the whole setup, replacing what the project had.
 */
export interface ProjectSetupUpdateRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its setup.
   */
  setup: ProjectSetup;
}
/**
 * `project.environment.update`: the project's whole list of rows, replacing what it had. A row
 * whose name the environment-name rule refuses is refused with `project.environment.nameRefused`
 * naming the row, and nothing is written.
 */
export interface ProjectEnvironmentUpdateRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its rows.
   */
  environmentRows: EnvironmentRow[];
}
/**
 * `project.branchPattern.update`: the project's own branch pattern, or `null` to return the
 * project to the machine's pattern. A pattern git refuses, or one that clashes with a branch in
 * the repository, is refused and nothing is written.
 */
export interface ProjectBranchPatternUpdateRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Its pattern, or `null` for the machine's.
   */
  pattern: string | null;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link ProjectId}. */
// prettier-ignore
export const validateProjectId: CompiledSchemaCheck<ProjectId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateProjectId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateProjectId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateProjectId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema906: any = {"description":"A project's life: `cloning` from the first press of `Clone` until the clone attaches (a failed\nor canceled clone stays `cloning`, so it can be run again), then `active`, and `archived` while\nit sits in the archived group.","type":"string","enum":["cloning","active","archived"]};
/** Checks that a value is a {@link ProjectState}. */
// prettier-ignore
export const validateProjectState: CompiledSchemaCheck<ProjectState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProjectState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "cloning") || (data === "active")) || (data === "archived"))){validateProjectState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema906.enum}}];return false;}validateProjectState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link ProjectSetup}. */
// prettier-ignore
export const validateProjectSetup: CompiledSchemaCheck<ProjectSetup> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectSetup {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectSetup.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.filesToCopy === undefined) && (missing0 = "filesToCopy")) || ((data.commands === undefined) && (missing0 = "commands"))){validateProjectSetup.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "filesToCopy") || (key0 === "commands")) || (key0 === "timeLimitSeconds"))){validateProjectSetup.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.filesToCopy !== undefined){let data0: any = data.filesToCopy;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validateProjectSetup.errors = [{instancePath:instancePath+"/filesToCopy/" + i0,schemaPath:"#/properties/filesToCopy/items/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateProjectSetup.errors = [{instancePath:instancePath+"/filesToCopy/" + i0,schemaPath:"#/properties/filesToCopy/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateProjectSetup.errors = [{instancePath:instancePath+"/filesToCopy/" + i0,schemaPath:"#/properties/filesToCopy/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateProjectSetup.errors = [{instancePath:instancePath+"/filesToCopy/" + i0,schemaPath:"#/properties/filesToCopy/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateProjectSetup.errors = [{instancePath:instancePath+"/filesToCopy",schemaPath:"#/properties/filesToCopy/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commands !== undefined){let data2: any = data.commands;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data2)){var valid2: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){let data3: any = data2[i1];const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(func1(data3) > 8192){validateProjectSetup.errors = [{instancePath:instancePath+"/commands/" + i1,schemaPath:"#/properties/commands/items/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data3) < 1){validateProjectSetup.errors = [{instancePath:instancePath+"/commands/" + i1,schemaPath:"#/properties/commands/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateProjectSetup.errors = [{instancePath:instancePath+"/commands/" + i1,schemaPath:"#/properties/commands/items/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProjectSetup.errors = [{instancePath:instancePath+"/commands/" + i1,schemaPath:"#/properties/commands/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validateProjectSetup.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/properties/commands/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.timeLimitSeconds !== undefined){let data4: any = data.timeLimitSeconds;const _errs10: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateProjectSetup.errors = [{instancePath:instancePath+"/timeLimitSeconds",schemaPath:"#/properties/timeLimitSeconds/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 2147483 || isNaN(data4)){validateProjectSetup.errors = [{instancePath:instancePath+"/timeLimitSeconds",schemaPath:"#/properties/timeLimitSeconds/maximum",keyword:"maximum",params:{comparison: "<=", limit: 2147483}}];return false;}else {if(data4 < 1 || isNaN(data4)){validateProjectSetup.errors = [{instancePath:instancePath+"/timeLimitSeconds",schemaPath:"#/properties/timeLimitSeconds/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validateProjectSetup.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectSetup.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectSetup.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectSessionTally}. */
// prettier-ignore
export const validateProjectSessionTally: CompiledSchemaCheck<ProjectSessionTally> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectSessionTally {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectSessionTally.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.running === undefined) && (missing0 = "running")) || ((data.waiting === undefined) && (missing0 = "waiting"))) || ((data.done === undefined) && (missing0 = "done"))){validateProjectSessionTally.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "running") || (key0 === "waiting")) || (key0 === "done"))){validateProjectSessionTally.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.running !== undefined){let data0: any = data.running;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateProjectSessionTally.errors = [{instancePath:instancePath+"/running",schemaPath:"#/properties/running/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateProjectSessionTally.errors = [{instancePath:instancePath+"/running",schemaPath:"#/properties/running/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateProjectSessionTally.errors = [{instancePath:instancePath+"/running",schemaPath:"#/properties/running/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.waiting !== undefined){let data1: any = data.waiting;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateProjectSessionTally.errors = [{instancePath:instancePath+"/waiting",schemaPath:"#/properties/waiting/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateProjectSessionTally.errors = [{instancePath:instancePath+"/waiting",schemaPath:"#/properties/waiting/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateProjectSessionTally.errors = [{instancePath:instancePath+"/waiting",schemaPath:"#/properties/waiting/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.done !== undefined){let data2: any = data.done;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateProjectSessionTally.errors = [{instancePath:instancePath+"/done",schemaPath:"#/properties/done/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateProjectSessionTally.errors = [{instancePath:instancePath+"/done",schemaPath:"#/properties/done/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateProjectSessionTally.errors = [{instancePath:instancePath+"/done",schemaPath:"#/properties/done/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateProjectSessionTally.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectSessionTally.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectSessionTally.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema905: any = {"type":"object","additionalProperties":false,"properties":{"projectId":{"$ref":"#/$defs/ProjectId","description":"The project."},"repoMountId":{"anyOf":[{"$ref":"sidekicks-contracts:repo/mount#/$defs/RepoMountId"},{"type":"null"}],"description":"`null` while the project is still cloning; the mount is made when the clone attaches."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its name."},"folderPath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"Its folder, in its place's own form."},"state":{"$ref":"#/$defs/ProjectState","description":"Its life."},"sessionCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many sessions it has."},"runningSessionId":{"anyOf":[{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId"},{"type":"null"}],"description":"A session with an agent running anywhere in the project, or `null`."},"sessionTally":{"$ref":"#/$defs/ProjectSessionTally","description":"How many of its sessions are running, waiting on the person and done."},"setup":{"$ref":"#/$defs/ProjectSetup","description":"Its setup steps."},"environmentRows":{"type":"array","items":{"$ref":"sidekicks-contracts:machine/settings#/$defs/EnvironmentRow"},"description":"The project's own rows, each winning over the `Every project` row of the same name."},"branchPattern":{"anyOf":[{"$ref":"sidekicks-contracts:machine/settings#/$defs/BranchNamePattern"},{"type":"null"}],"description":"`null` while the project follows the machine's pattern."},"place":{"$ref":"sidekicks-contracts:place#/$defs/Place","description":"Where its folder is and its sessions run, fixed at attach; absent on macOS and Linux."},"isDistributionRemoved":{"type":"boolean","const":true,"description":"Present when the project's distribution is no longer on this computer, so its sessions\ncannot run and the row offers `Remove`."}},"required":["projectId","repoMountId","name","folderPath","state","sessionCount","runningSessionId","sessionTally","setup","environmentRows","branchPattern"],"description":"One project as the Projects page and the session list's project headers draw it."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link ProjectListEntry}. */
// prettier-ignore
export const validateProjectListEntry: CompiledSchemaCheck<ProjectListEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectListEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((data.projectId === undefined) && (missing0 = "projectId")) || ((data.repoMountId === undefined) && (missing0 = "repoMountId"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.folderPath === undefined) && (missing0 = "folderPath"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.sessionCount === undefined) && (missing0 = "sessionCount"))) || ((data.runningSessionId === undefined) && (missing0 = "runningSessionId"))) || ((data.sessionTally === undefined) && (missing0 = "sessionTally"))) || ((data.setup === undefined) && (missing0 = "setup"))) || ((data.environmentRows === undefined) && (missing0 = "environmentRows"))) || ((data.branchPattern === undefined) && (missing0 = "branchPattern"))){validateProjectListEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema905.properties, key0))){validateProjectListEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs3: any = errors;const _errs4: any = errors;let valid1: any = false;const _errs5: any = errors;if(!(validateRepoMountId.call(this, data1, {instancePath:instancePath+"/repoMountId",parentData:data,parentDataProperty:"repoMountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRepoMountId.errors : vErrors.concat(validateRepoMountId.errors);errors = vErrors.length;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;const _errs6: any = errors;if(data1 !== null){const err0: any = {instancePath:instancePath+"/repoMountId",schemaPath:"#/properties/repoMountId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/repoMountId",schemaPath:"#/properties/repoMountId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateProjectListEntry.errors = vErrors;return false;}else {errors = _errs4;if(vErrors !== null){if(_errs4){vErrors.length = _errs4;}else {vErrors = null;}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 256){validateProjectListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateProjectListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateProjectListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProjectListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.folderPath !== undefined){let data3: any = data.folderPath;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 4096){validateProjectListEntry.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validateProjectListEntry.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data3)){validateProjectListEntry.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateProjectListEntry.errors = [{instancePath:instancePath+"/folderPath",schemaPath:"#/properties/folderPath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs12: any = errors;if(!(validateProjectState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectState.errors : vErrors.concat(validateProjectState.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionCount !== undefined){let data5: any = data.sessionCount;const _errs13: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateProjectListEntry.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateProjectListEntry.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validateProjectListEntry.errors = [{instancePath:instancePath+"/sessionCount",schemaPath:"#/properties/sessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.runningSessionId !== undefined){let data6: any = data.runningSessionId;const _errs15: any = errors;const _errs16: any = errors;let valid2: any = false;const _errs17: any = errors;if(!(validateSessionId.call(this, data6, {instancePath:instancePath+"/runningSessionId",parentData:data,parentDataProperty:"runningSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var _valid1: any = _errs17 === errors;valid2 = valid2 || _valid1;const _errs18: any = errors;if(data6 !== null){const err2: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/properties/runningSessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs18 === errors;valid2 = valid2 || _valid1;if(!valid2){const err3: any = {instancePath:instancePath+"/runningSessionId",schemaPath:"#/properties/runningSessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateProjectListEntry.errors = vErrors;return false;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionTally !== undefined){const _errs20: any = errors;if(!(validateProjectSessionTally.call(this, data.sessionTally, {instancePath:instancePath+"/sessionTally",parentData:data,parentDataProperty:"sessionTally",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectSessionTally.errors : vErrors.concat(validateProjectSessionTally.errors);errors = vErrors.length;}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.setup !== undefined){const _errs21: any = errors;if(!(validateProjectSetup.call(this, data.setup, {instancePath:instancePath+"/setup",parentData:data,parentDataProperty:"setup",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectSetup.errors : vErrors.concat(validateProjectSetup.errors);errors = vErrors.length;}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.environmentRows !== undefined){let data9: any = data.environmentRows;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data9)){var valid3: any = true;const len0: any = data9.length;for(let i0=0; i0<len0; i0++){const _errs24: any = errors;if(!(validateEnvironmentRow.call(this, data9[i0], {instancePath:instancePath+"/environmentRows/" + i0,parentData:data9,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEnvironmentRow.errors : vErrors.concat(validateEnvironmentRow.errors);errors = vErrors.length;}var valid3: any = _errs24 === errors;if(!valid3){break;}}}else {validateProjectListEntry.errors = [{instancePath:instancePath+"/environmentRows",schemaPath:"#/properties/environmentRows/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.branchPattern !== undefined){let data11: any = data.branchPattern;const _errs25: any = errors;const _errs26: any = errors;let valid4: any = false;const _errs27: any = errors;if(!(validateBranchNamePattern.call(this, data11, {instancePath:instancePath+"/branchPattern",parentData:data,parentDataProperty:"branchPattern",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBranchNamePattern.errors : vErrors.concat(validateBranchNamePattern.errors);errors = vErrors.length;}var _valid2: any = _errs27 === errors;valid4 = valid4 || _valid2;const _errs28: any = errors;if(data11 !== null){const err4: any = {instancePath:instancePath+"/branchPattern",schemaPath:"#/properties/branchPattern/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid2: any = _errs28 === errors;valid4 = valid4 || _valid2;if(!valid4){const err5: any = {instancePath:instancePath+"/branchPattern",schemaPath:"#/properties/branchPattern/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validateProjectListEntry.errors = vErrors;return false;}else {errors = _errs26;if(vErrors !== null){if(_errs26){vErrors.length = _errs26;}else {vErrors = null;}}}var valid0: any = _errs25 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs30: any = errors;if(!(validatePlace.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlace.errors : vErrors.concat(validatePlace.errors);errors = vErrors.length;}var valid0: any = _errs30 === errors;}else {var valid0: any = true;}if(valid0){if(data.isDistributionRemoved !== undefined){let data13: any = data.isDistributionRemoved;const _errs31: any = errors;if(typeof data13 !== "boolean"){validateProjectListEntry.errors = [{instancePath:instancePath+"/isDistributionRemoved",schemaPath:"#/properties/isDistributionRemoved/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data13){validateProjectListEntry.errors = [{instancePath:instancePath+"/isDistributionRemoved",schemaPath:"#/properties/isDistributionRemoved/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs31 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validateProjectListEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectListEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectListEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectList}. */
// prettier-ignore
export const validateProjectList: CompiledSchemaCheck<ProjectList> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectList {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectList.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projects === undefined) && (missing0 = "projects")){validateProjectList.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projects")){validateProjectList.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projects !== undefined){let data0: any = data.projects;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateProjectListEntry.call(this, data0[i0], {instancePath:instancePath+"/projects/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectListEntry.errors : vErrors.concat(validateProjectListEntry.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateProjectList.errors = [{instancePath:instancePath+"/projects",schemaPath:"#/properties/projects/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateProjectList.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectList.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectList.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectEditResponse}. */
// prettier-ignore
export const validateProjectEditResponse: CompiledSchemaCheck<ProjectEditResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectEditResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectEditResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.project === undefined) && (missing0 = "project")){validateProjectEditResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "project")){validateProjectEditResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.project !== undefined){if(!(validateProjectListEntry.call(this, data.project, {instancePath:instancePath+"/project",parentData:data,parentDataProperty:"project",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectListEntry.errors : vErrors.concat(validateProjectListEntry.errors);errors = vErrors.length;}}}}}else {validateProjectEditResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectEditResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectEditResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectRenameRequest}. */
// prettier-ignore
export const validateProjectRenameRequest: CompiledSchemaCheck<ProjectRenameRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectRenameRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectRenameRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.projectId === undefined) && (missing0 = "projectId")) || ((data.name === undefined) && (missing0 = "name"))){validateProjectRenameRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "projectId") || (key0 === "name"))){validateProjectRenameRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateProjectRenameRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateProjectRenameRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProjectRenameRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProjectRenameRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProjectRenameRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectRenameRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectRenameRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectStateChangeRequest}. */
// prettier-ignore
export const validateProjectStateChangeRequest: CompiledSchemaCheck<ProjectStateChangeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectStateChangeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectStateChangeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validateProjectStateChangeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projectId")){validateProjectStateChangeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}}}}}else {validateProjectStateChangeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectStateChangeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectStateChangeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectSetupUpdateRequest}. */
// prettier-ignore
export const validateProjectSetupUpdateRequest: CompiledSchemaCheck<ProjectSetupUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectSetupUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectSetupUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.projectId === undefined) && (missing0 = "projectId")) || ((data.setup === undefined) && (missing0 = "setup"))){validateProjectSetupUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "projectId") || (key0 === "setup"))){validateProjectSetupUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.setup !== undefined){const _errs3: any = errors;if(!(validateProjectSetup.call(this, data.setup, {instancePath:instancePath+"/setup",parentData:data,parentDataProperty:"setup",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectSetup.errors : vErrors.concat(validateProjectSetup.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProjectSetupUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectSetupUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectSetupUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectEnvironmentUpdateRequest}. */
// prettier-ignore
export const validateProjectEnvironmentUpdateRequest: CompiledSchemaCheck<ProjectEnvironmentUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectEnvironmentUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectEnvironmentUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.projectId === undefined) && (missing0 = "projectId")) || ((data.environmentRows === undefined) && (missing0 = "environmentRows"))){validateProjectEnvironmentUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "projectId") || (key0 === "environmentRows"))){validateProjectEnvironmentUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.environmentRows !== undefined){let data1: any = data.environmentRows;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateEnvironmentRow.call(this, data1[i0], {instancePath:instancePath+"/environmentRows/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEnvironmentRow.errors : vErrors.concat(validateEnvironmentRow.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateProjectEnvironmentUpdateRequest.errors = [{instancePath:instancePath+"/environmentRows",schemaPath:"#/properties/environmentRows/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProjectEnvironmentUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectEnvironmentUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectEnvironmentUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema903: any = {"type":"object","additionalProperties":false,"properties":{"projectId":{"$ref":"#/$defs/ProjectId","description":"The project."},"pattern":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its pattern, or `null` for the machine's."}},"required":["projectId","pattern"],"description":"`project.branchPattern.update`: the project's own branch pattern, or `null` to return the\nproject to the machine's pattern. A pattern git refuses, or one that clashes with a branch in\nthe repository, is refused and nothing is written."};
/** Checks that a value is a {@link ProjectBranchPatternUpdateRequest}. */
// prettier-ignore
export const validateProjectBranchPatternUpdateRequest: CompiledSchemaCheck<ProjectBranchPatternUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectBranchPatternUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectBranchPatternUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.projectId === undefined) && (missing0 = "projectId")) || ((data.pattern === undefined) && (missing0 = "pattern"))){validateProjectBranchPatternUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "projectId") || (key0 === "pattern"))){validateProjectBranchPatternUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pattern !== undefined){let data1: any = data.pattern;const _errs3: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validateProjectBranchPatternUpdateRequest.errors = [{instancePath:instancePath+"/pattern",schemaPath:"#/properties/pattern/type",keyword:"type",params:{type: schema903.properties.pattern.type}}];return false;}if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateProjectBranchPatternUpdateRequest.errors = [{instancePath:instancePath+"/pattern",schemaPath:"#/properties/pattern/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateProjectBranchPatternUpdateRequest.errors = [{instancePath:instancePath+"/pattern",schemaPath:"#/properties/pattern/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProjectBranchPatternUpdateRequest.errors = [{instancePath:instancePath+"/pattern",schemaPath:"#/properties/pattern/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateProjectBranchPatternUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectBranchPatternUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectBranchPatternUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
