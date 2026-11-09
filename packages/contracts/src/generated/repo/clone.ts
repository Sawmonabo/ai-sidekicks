// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Cloning: project.clone.start makes a project from a repository URL, and its card follows the clone live.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WslPlace } from "../place.js";
import type { ProjectId } from "../project.js";

/** The longest repository URL `project.clone.start` takes. */
export const PROJECT_CLONE_URL_MAX_LEN = 2048 as const;

/** The longest line of git's own words the clone card carries. */
export const PROJECT_CLONE_LINE_MAX_LEN = 1024 as const;

/** The longest answer to one of git's questions. */
export const PROJECT_CLONE_ANSWER_MAX_LEN = 4096 as const;

/** The code `project.clone.start` answers with when it refuses a clone before it starts. */
export const PROJECT_CLONE_REFUSED_CODE = "project.clone.refused" as const;

/**
 * The details of a `project.clone.refused` refusal: `destinationNotEmpty` when the destination
 * holds something, `noDirectoryName` when git can name no folder from the address, with git's
 * own line, which the clone card shows as it shows any clone's failure.
 */
export type ProjectCloneRefusedDetails =
  | {
      reason: "destinationNotEmpty";
    }
  | {
      reason: "noDirectoryName";
      /**
       * Git's own line.
       */
      line: string;
    };
/**
 * One question git is waiting on, minted when git's askpass program asks it.
 */
export type CloneQuestionId = string & { readonly __brand: "CloneQuestionId" };
/**
 * The step a failed clone failed at: `clone` or `largeFiles` with git's own line, or `sessions`
 * when the sessions that waited on the clone could not be started after it attached.
 */
export type ProjectCloneFailedStep = "clone" | "largeFiles" | "sessions";
/**
 * One `project.clone.subscribe` emission, the clone card's whole state. `largeFilesMissing` means
 * the clone finished but the repository keeps large files in Git LFS, which is not installed, so
 * they arrived as placeholders; `canceled` and `done` end the card.
 */
export type ProjectCloneStatus =
  | {
      state: "cloning";
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * Git's latest progress, or `null`.
       */
      progress: ProjectCloneProgress | null;
      /**
       * The question git is waiting on, or `null`.
       */
      question: ProjectCloneQuestion | null;
    }
  | {
      state: "pullingLargeFiles";
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * Git's latest progress, or `null`.
       */
      progress: ProjectCloneProgress | null;
      /**
       * The question git is waiting on, or `null`.
       */
      question: ProjectCloneQuestion | null;
    }
  | {
      state: "failed";
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * The step.
       */
      step: ProjectCloneFailedStep;
      /**
       * Its last error line; `null` only when the service restarted during the clone and git
       * left none.
       */
      failureLine: string | null;
    }
  | {
      state: "largeFilesMissing";
      /**
       * The project.
       */
      projectId: ProjectId;
    }
  | {
      state: "canceled";
      /**
       * The project.
       */
      projectId: ProjectId;
    }
  | {
      state: "done";
      /**
       * The project.
       */
      projectId: ProjectId;
    };
/**
 * The answer to one of git's questions: one line with no NUL, possibly empty (an empty
 * passphrase), since git's askpass program prints it as one line and a break would cut it
 * short or smuggle a second.
 */
export type AskpassAnswer = string;
/**
 * Why a clone goes where it does.
 */
export type ProjectCloneFolderSource = "setting" | "lastProject" | "home";

/**
 * `project.clone.start`: the repository's URL, the folder the clone goes into when it is not the
 * machine's clone folder, and the project whose failed or canceled clone this runs again. The
 * reply names the project, made at once and marked `cloning`; the clone ends in the ordinary
 * attach.
 */
export interface ProjectCloneStartRequest {
  /**
   * The repository's URL, handed to git as typed.
   */
  url: string;
  /**
   * The folder the clone goes into.
   */
  parentFolder?: string;
  /**
   * The distribution the folder is in, given in Linux form; absent wherever the folder's own
   * form says.
   */
  place?: WslPlace;
  /**
   * The project whose clone runs again.
   */
  projectId?: ProjectId;
  /**
   * The key that makes a repeated start one clone, answering the first clone's project.
   */
  clientIdempotencyKey: string;
}
/**
 * The `project.clone.start` result: the project the clone fills.
 */
export interface ProjectCloneStartResponse {
  /**
   * The project.
   */
  projectId: ProjectId;
}
/**
 * `project.clone.subscribe`, `project.clone.cancel` and `project.largeFile.pull`: the project a
 * clone-card request is about.
 */
export interface ProjectCloneRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
}
/**
 * Git's progress in its own words, `Receiving objects` at 42 percent.
 */
export interface ProjectCloneProgress {
  /**
   * The phase, in git's words.
   */
  phase: string;
  /**
   * The whole percent git printed, or `null`.
   */
  percent: number | null;
}
/**
 * A question git asked (a user name, a password or token, a key's passphrase, or whether to trust
 * a host's key), in git's own words. `masked` is true for a password or a passphrase.
 */
export interface ProjectCloneQuestion {
  /**
   * The question.
   */
  questionId: CloneQuestionId;
  /**
   * Git's words.
   */
  prompt: string;
  /**
   * Whether the answer is hidden as it is typed.
   */
  masked: boolean;
}
/**
 * `project.clone.answer`: the answer to one of git's questions. The daemon hands it to git's
 * askpass program and nowhere else; it is never stored, logged or echoed, and a transport that
 * logs request bodies must redact `answer`.
 */
export interface ProjectCloneAnswerRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * The question.
   */
  questionId: CloneQuestionId;
  /**
   * The answer.
   */
  answer: AskpassAnswer;
}
/**
 * Where a clone goes, and why: the folder the person set, else the folder holding the most
 * recently attached project, else the home folder. The session picker and Settings › Projects
 * both read this one answer.
 */
export interface ProjectCloneFolderReadResponse {
  /**
   * The folder.
   */
  folder: string;
  /**
   * The distribution the folder is in, in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * Why.
   */
  source: ProjectCloneFolderSource;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1618(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloneQuestionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1618.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1618.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1618.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1618.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1618.errors = null as any[] | null;
// prettier-ignore
validate1618.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern2026 = new RegExp("^[^\\x00\\r\\n]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1619(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneAnswerRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1619.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.projectId === undefined) && (missing0 = "projectId")) || ((data.questionId === undefined) && (missing0 = "questionId"))) || ((data.answer === undefined) && (missing0 = "answer"))){validate1619.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "projectId") || (key0 === "questionId")) || (key0 === "answer"))){validate1619.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){let data0: any = data.projectId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1619.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1619.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.questionId !== undefined){let data1: any = data.questionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1619.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/CloneQuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1619.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/CloneQuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.answer !== undefined){let data2: any = data.answer;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 4096){validate1619.errors = [{instancePath:instancePath+"/answer",schemaPath:"#/$defs/AskpassAnswer/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(!pattern2026.test(data2)){validate1619.errors = [{instancePath:instancePath+"/answer",schemaPath:"#/$defs/AskpassAnswer/pattern",keyword:"pattern",params:{pattern: "^[^\\x00\\r\\n]*$"}}];return false;}}}else {validate1619.errors = [{instancePath:instancePath+"/answer",schemaPath:"#/$defs/AskpassAnswer/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1619.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1619.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1619.errors = null as any[] | null;
// prettier-ignore
validate1619.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3021: any = {"description":"Why a clone goes where it does.","type":"string","enum":["setting","lastProject","home"]};
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1621(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1621.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.distro === undefined) && (missing0 = "distro")){validate1621.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "distro")){validate1621.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1621.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate1621.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1621.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1621.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1621.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1621.errors = null as any[] | null;
// prettier-ignore
validate1621.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1620(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneFolderReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1620.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.folder === undefined) && (missing0 = "folder")) || ((data.source === undefined) && (missing0 = "source"))){validate1620.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "folder") || (key0 === "place")) || (key0 === "source"))){validate1620.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validate1620.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validate1620.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data0)){validate1620.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1620.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs4: any = errors;if(!(validate1621.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1621.errors : vErrors.concat(validate1621.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){let data2: any = data.source;const _errs5: any = errors;if(typeof data2 !== "string"){validate1620.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/ProjectCloneFolderSource/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "setting") || (data2 === "lastProject")) || (data2 === "home"))){validate1620.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/ProjectCloneFolderSource/enum",keyword:"enum",params:{allowedValues: schema3021.enum}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validate1620.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1620.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1620.errors = null as any[] | null;
// prettier-ignore
validate1620.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1623(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1623.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validate1623.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projectId")){validate1623.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){let data0: any = data.projectId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1623.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1623.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1623.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1623.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1623.errors = null as any[] | null;
// prettier-ignore
validate1623.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
function validate1624(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1624.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.url === undefined) && (missing0 = "url")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate1624.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "url") || (key0 === "parentFolder")) || (key0 === "place")) || (key0 === "projectId")) || (key0 === "clientIdempotencyKey"))){validate1624.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.url !== undefined){let data0: any = data.url;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 2048){validate1624.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/maxLength",keyword:"maxLength",params:{limit: 2048}}];return false;}else {if(func1(data0) < 1){validate1624.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1624.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1624.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.parentFolder !== undefined){let data1: any = data.parentFolder;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1624.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1624.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1624.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1624.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs6: any = errors;if(!(validate1621.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1621.errors : vErrors.concat(validate1621.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){let data3: any = data.projectId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate1624.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1624.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs11: any = errors;if(errors === _errs11){if(typeof data4 === "string"){if(!pattern222.test(data4)){validate1624.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1624.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1624.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1624.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1624.errors = null as any[] | null;
// prettier-ignore
validate1624.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1626(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1626.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validate1626.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projectId")){validate1626.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){let data0: any = data.projectId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1626.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1626.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1626.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1626.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1626.errors = null as any[] | null;
// prettier-ignore
validate1626.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3028: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"cloning"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"progress":{"anyOf":[{"$ref":"#/$defs/ProjectCloneProgress"},{"type":"null"}],"description":"Git's latest progress, or `null`."},"question":{"anyOf":[{"$ref":"#/$defs/ProjectCloneQuestion"},{"type":"null"}],"description":"The question git is waiting on, or `null`."}},"required":["state","projectId","progress","question"],"description":"Git is cloning."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"pullingLargeFiles"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"progress":{"anyOf":[{"$ref":"#/$defs/ProjectCloneProgress"},{"type":"null"}],"description":"Git's latest progress, or `null`."},"question":{"anyOf":[{"$ref":"#/$defs/ProjectCloneQuestion"},{"type":"null"}],"description":"The question git is waiting on, or `null`."}},"required":["state","projectId","progress","question"],"description":"Git is pulling large files."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"failed"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"step":{"$ref":"#/$defs/ProjectCloneFailedStep","description":"The step."},"failureLine":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":1024,"description":"Its last error line; `null` only when the service restarted during the clone and git\nleft none."}},"required":["state","projectId","step","failureLine"],"description":"A step failed."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"largeFilesMissing"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."}},"required":["state","projectId"],"description":"The clone finished with its large files left as placeholders."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"canceled"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."}},"required":["state","projectId"],"description":"The clone was canceled."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"done"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."}},"required":["state","projectId"],"description":"The clone is done."}],"description":"One `project.clone.subscribe` emission, the clone card's whole state. `largeFilesMissing` means\nthe clone finished but the repository keeps large files in Git LFS, which is not installed, so\nthey arrived as placeholders; `canceled` and `done` end the card.","discriminator":{"propertyName":"state"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const schema3030: any = {"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":1024,"description":"The phase, in git's words."},"percent":{"type":["integer","null"],"minimum":0,"maximum":100,"description":"The whole percent git printed, or `null`."}},"required":["phase","percent"],"description":"Git's progress in its own words, `Receiving objects` at 42 percent."};
// prettier-ignore
const schema3036: any = {"description":"The step a failed clone failed at: `clone` or `largeFiles` with git's own line, or `sessions`\nwhen the sessions that waited on the clone could not be started after it attached.","type":"string","enum":["clone","largeFiles","sessions"]};
// prettier-ignore
function validate1628(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1628.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.questionId === undefined) && (missing0 = "questionId")) || ((data.prompt === undefined) && (missing0 = "prompt"))) || ((data.masked === undefined) && (missing0 = "masked"))){validate1628.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "questionId") || (key0 === "prompt")) || (key0 === "masked"))){validate1628.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.questionId !== undefined){let data0: any = data.questionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1628.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/CloneQuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1628.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/CloneQuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.prompt !== undefined){let data1: any = data.prompt;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 1024){validate1628.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data1) < 1){validate1628.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1628.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1628.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.masked !== undefined){const _errs8: any = errors;if(typeof data.masked !== "boolean"){validate1628.errors = [{instancePath:instancePath+"/masked",schemaPath:"#/properties/masked/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1628.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1628.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1628.errors = null as any[] | null;
// prettier-ignore
validate1628.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1627(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1627.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "cloning"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.state === undefined) && (missing0 = "state")) || ((data.projectId === undefined) && (missing0 = "projectId"))) || ((data.progress === undefined) && (missing0 = "progress"))) || ((data.question === undefined) && (missing0 = "question"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "state") || (key0 === "projectId")) || (key0 === "progress")) || (key0 === "question"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("cloning" !== data0){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "cloning"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.projectId !== undefined){let data1: any = data.projectId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.progress !== undefined){let data2: any = data.progress;const _errs11: any = errors;const _errs12: any = errors;let valid4: any = false;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((data2.phase === undefined) && (missing1 = "phase")) || ((data2.percent === undefined) && (missing1 = "percent"))){const err0: any = {instancePath:instancePath+"/progress",schemaPath:"#/$defs/ProjectCloneProgress/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs16: any = errors;for(const key1 in data2){if(!((key1 === "phase") || (key1 === "percent"))){const err1: any = {instancePath:instancePath+"/progress",schemaPath:"#/$defs/ProjectCloneProgress/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs16 === errors){if(data2.phase !== undefined){let data3: any = data2.phase;const _errs17: any = errors;if(errors === _errs17){if(typeof data3 === "string"){if(func1(data3) > 1024){const err2: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/maxLength",keyword:"maxLength",params:{limit: 1024}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data3) < 1){const err3: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(!pattern6.test(data3)){const err4: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data2.percent !== undefined){let data4: any = data2.percent;const _errs19: any = errors;if((!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))) && (data4 !== null)){const err6: any = {instancePath:instancePath+"/progress/percent",schemaPath:"#/$defs/ProjectCloneProgress/properties/percent/type",keyword:"type",params:{type: schema3030.properties.percent.type}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}if(errors === _errs19){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 100 || isNaN(data4)){const err7: any = {instancePath:instancePath+"/progress/percent",schemaPath:"#/$defs/ProjectCloneProgress/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {if(data4 < 0 || isNaN(data4)){const err8: any = {instancePath:instancePath+"/progress/percent",schemaPath:"#/$defs/ProjectCloneProgress/properties/percent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}}}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}}}}}else {const err9: any = {instancePath:instancePath+"/progress",schemaPath:"#/$defs/ProjectCloneProgress/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var _valid0: any = _errs13 === errors;valid4 = valid4 || _valid0;const _errs21: any = errors;if(data2 !== null){const err10: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}var _valid0: any = _errs21 === errors;valid4 = valid4 || _valid0;if(!valid4){const err11: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validate1627.errors = vErrors;return false;}else {errors = _errs12;if(vErrors !== null){if(_errs12){vErrors.length = _errs12;}else {vErrors = null;}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.question !== undefined){let data5: any = data.question;const _errs23: any = errors;const _errs24: any = errors;let valid7: any = false;const _errs25: any = errors;if(!(validate1628.call(this, data5, {instancePath:instancePath+"/question",parentData:data,parentDataProperty:"question",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1628.errors : vErrors.concat(validate1628.errors);errors = vErrors.length;}var _valid1: any = _errs25 === errors;valid7 = valid7 || _valid1;const _errs26: any = errors;if(data5 !== null){const err12: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/0/properties/question/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}var _valid1: any = _errs26 === errors;valid7 = valid7 || _valid1;if(!valid7){const err13: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/0/properties/question/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;validate1627.errors = vErrors;return false;}else {errors = _errs24;if(vErrors !== null){if(_errs24){vErrors.length = _errs24;}else {vErrors = null;}}}var valid2: any = _errs23 === errors;}else {var valid2: any = true;}}}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props2: any = true;valid0 = valid1;}else if(tag0 === "pullingLargeFiles"){const _errs28: any = errors;if(errors === _errs28){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.state === undefined) && (missing2 = "state")) || ((data.projectId === undefined) && (missing2 = "projectId"))) || ((data.progress === undefined) && (missing2 = "progress"))) || ((data.question === undefined) && (missing2 = "question"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs30: any = errors;for(const key2 in data){if(!((((key2 === "state") || (key2 === "projectId")) || (key2 === "progress")) || (key2 === "question"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs30 === errors){if(data.state !== undefined){let data6: any = data.state;const _errs31: any = errors;if(typeof data6 !== "string"){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("pullingLargeFiles" !== data6){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "pullingLargeFiles"}}];return false;}var valid9: any = _errs31 === errors;}else {var valid9: any = true;}if(valid9){if(data.projectId !== undefined){let data7: any = data.projectId;const _errs33: any = errors;const _errs34: any = errors;if(errors === _errs34){if(typeof data7 === "string"){if(!pattern4.test(data7)){validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs33 === errors;}else {var valid9: any = true;}if(valid9){if(data.progress !== undefined){let data8: any = data.progress;const _errs37: any = errors;const _errs38: any = errors;let valid11: any = false;const _errs39: any = errors;const _errs40: any = errors;if(errors === _errs40){if(data8 && typeof data8 == "object" && !Array.isArray(data8)){let missing3: any;if(((data8.phase === undefined) && (missing3 = "phase")) || ((data8.percent === undefined) && (missing3 = "percent"))){const err14: any = {instancePath:instancePath+"/progress",schemaPath:"#/$defs/ProjectCloneProgress/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {const _errs42: any = errors;for(const key3 in data8){if(!((key3 === "phase") || (key3 === "percent"))){const err15: any = {instancePath:instancePath+"/progress",schemaPath:"#/$defs/ProjectCloneProgress/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;break;}}if(_errs42 === errors){if(data8.phase !== undefined){let data9: any = data8.phase;const _errs43: any = errors;if(errors === _errs43){if(typeof data9 === "string"){if(func1(data9) > 1024){const err16: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/maxLength",keyword:"maxLength",params:{limit: 1024}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}else {if(func1(data9) < 1){const err17: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}else {if(!pattern6.test(data9)){const err18: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}}}else {const err19: any = {instancePath:instancePath+"/progress/phase",schemaPath:"#/$defs/ProjectCloneProgress/properties/phase/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}var valid13: any = _errs43 === errors;}else {var valid13: any = true;}if(valid13){if(data8.percent !== undefined){let data10: any = data8.percent;const _errs45: any = errors;if((!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))) && (data10 !== null)){const err20: any = {instancePath:instancePath+"/progress/percent",schemaPath:"#/$defs/ProjectCloneProgress/properties/percent/type",keyword:"type",params:{type: schema3030.properties.percent.type}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}if(errors === _errs45){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 100 || isNaN(data10)){const err21: any = {instancePath:instancePath+"/progress/percent",schemaPath:"#/$defs/ProjectCloneProgress/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}else {if(data10 < 0 || isNaN(data10)){const err22: any = {instancePath:instancePath+"/progress/percent",schemaPath:"#/$defs/ProjectCloneProgress/properties/percent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}}}var valid13: any = _errs45 === errors;}else {var valid13: any = true;}}}}}else {const err23: any = {instancePath:instancePath+"/progress",schemaPath:"#/$defs/ProjectCloneProgress/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}var _valid2: any = _errs39 === errors;valid11 = valid11 || _valid2;const _errs47: any = errors;if(data8 !== null){const err24: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/1/properties/progress/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}var _valid2: any = _errs47 === errors;valid11 = valid11 || _valid2;if(!valid11){const err25: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/1/properties/progress/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;validate1627.errors = vErrors;return false;}else {errors = _errs38;if(vErrors !== null){if(_errs38){vErrors.length = _errs38;}else {vErrors = null;}}}var valid9: any = _errs37 === errors;}else {var valid9: any = true;}if(valid9){if(data.question !== undefined){let data11: any = data.question;const _errs49: any = errors;const _errs50: any = errors;let valid14: any = false;const _errs51: any = errors;if(!(validate1628.call(this, data11, {instancePath:instancePath+"/question",parentData:data,parentDataProperty:"question",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1628.errors : vErrors.concat(validate1628.errors);errors = vErrors.length;}var _valid3: any = _errs51 === errors;valid14 = valid14 || _valid3;const _errs52: any = errors;if(data11 !== null){const err26: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/1/properties/question/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}var _valid3: any = _errs52 === errors;valid14 = valid14 || _valid3;if(!valid14){const err27: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/1/properties/question/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;validate1627.errors = vErrors;return false;}else {errors = _errs50;if(vErrors !== null){if(_errs50){vErrors.length = _errs50;}else {vErrors = null;}}}var valid9: any = _errs49 === errors;}else {var valid9: any = true;}}}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs28 === errors;if(props2 !== true){props2 = true;}valid0 = valid8;}else if(tag0 === "failed"){const _errs54: any = errors;if(errors === _errs54){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((((data.state === undefined) && (missing4 = "state")) || ((data.projectId === undefined) && (missing4 = "projectId"))) || ((data.step === undefined) && (missing4 = "step"))) || ((data.failureLine === undefined) && (missing4 = "failureLine"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs56: any = errors;for(const key4 in data){if(!((((key4 === "state") || (key4 === "projectId")) || (key4 === "step")) || (key4 === "failureLine"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs56 === errors){if(data.state !== undefined){let data12: any = data.state;const _errs57: any = errors;if(typeof data12 !== "string"){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data12){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid16: any = _errs57 === errors;}else {var valid16: any = true;}if(valid16){if(data.projectId !== undefined){let data13: any = data.projectId;const _errs59: any = errors;const _errs60: any = errors;if(errors === _errs60){if(typeof data13 === "string"){if(!pattern4.test(data13)){validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs59 === errors;}else {var valid16: any = true;}if(valid16){if(data.step !== undefined){let data14: any = data.step;const _errs63: any = errors;if(typeof data14 !== "string"){validate1627.errors = [{instancePath:instancePath+"/step",schemaPath:"#/$defs/ProjectCloneFailedStep/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data14 === "clone") || (data14 === "largeFiles")) || (data14 === "sessions"))){validate1627.errors = [{instancePath:instancePath+"/step",schemaPath:"#/$defs/ProjectCloneFailedStep/enum",keyword:"enum",params:{allowedValues: schema3036.enum}}];return false;}var valid16: any = _errs63 === errors;}else {var valid16: any = true;}if(valid16){if(data.failureLine !== undefined){let data15: any = data.failureLine;const _errs66: any = errors;if((typeof data15 !== "string") && (data15 !== null)){validate1627.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/type",keyword:"type",params:{type: schema3028.oneOf[2].properties.failureLine.type}}];return false;}if(errors === _errs66){if(typeof data15 === "string"){if(func1(data15) > 1024){validate1627.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data15) < 1){validate1627.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data15)){validate1627.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid16: any = _errs66 === errors;}else {var valid16: any = true;}}}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid15: any = _errs54 === errors;if(props2 !== true){props2 = true;}valid0 = valid15;}else if(tag0 === "largeFilesMissing"){const _errs68: any = errors;if(errors === _errs68){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((data.state === undefined) && (missing5 = "state")) || ((data.projectId === undefined) && (missing5 = "projectId"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs70: any = errors;for(const key5 in data){if(!((key5 === "state") || (key5 === "projectId"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs70 === errors){if(data.state !== undefined){let data16: any = data.state;const _errs71: any = errors;if(typeof data16 !== "string"){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("largeFilesMissing" !== data16){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "largeFilesMissing"}}];return false;}var valid20: any = _errs71 === errors;}else {var valid20: any = true;}if(valid20){if(data.projectId !== undefined){let data17: any = data.projectId;const _errs73: any = errors;const _errs74: any = errors;if(errors === _errs74){if(typeof data17 === "string"){if(!pattern4.test(data17)){validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid20: any = _errs73 === errors;}else {var valid20: any = true;}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid19: any = _errs68 === errors;if(props2 !== true){props2 = true;}valid0 = valid19;}else if(tag0 === "canceled"){const _errs77: any = errors;if(errors === _errs77){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((data.state === undefined) && (missing6 = "state")) || ((data.projectId === undefined) && (missing6 = "projectId"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing6}}];return false;}else {const _errs79: any = errors;for(const key6 in data){if(!((key6 === "state") || (key6 === "projectId"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}}];return false;break;}}if(_errs79 === errors){if(data.state !== undefined){let data18: any = data.state;const _errs80: any = errors;if(typeof data18 !== "string"){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data18){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid23: any = _errs80 === errors;}else {var valid23: any = true;}if(valid23){if(data.projectId !== undefined){let data19: any = data.projectId;const _errs82: any = errors;const _errs83: any = errors;if(errors === _errs83){if(typeof data19 === "string"){if(!pattern4.test(data19)){validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid23: any = _errs82 === errors;}else {var valid23: any = true;}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid22: any = _errs77 === errors;if(props2 !== true){props2 = true;}valid0 = valid22;}else if(tag0 === "done"){const _errs86: any = errors;if(errors === _errs86){if(data && typeof data == "object" && !Array.isArray(data)){let missing7: any;if(((data.state === undefined) && (missing7 = "state")) || ((data.projectId === undefined) && (missing7 = "projectId"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing7}}];return false;}else {const _errs88: any = errors;for(const key7 in data){if(!((key7 === "state") || (key7 === "projectId"))){validate1627.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key7}}];return false;break;}}if(_errs88 === errors){if(data.state !== undefined){let data20: any = data.state;const _errs89: any = errors;if(typeof data20 !== "string"){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("done" !== data20){validate1627.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/const",keyword:"const",params:{allowedValue: "done"}}];return false;}var valid26: any = _errs89 === errors;}else {var valid26: any = true;}if(valid26){if(data.projectId !== undefined){let data21: any = data.projectId;const _errs91: any = errors;const _errs92: any = errors;if(errors === _errs92){if(typeof data21 === "string"){if(!pattern4.test(data21)){validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1627.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid26: any = _errs91 === errors;}else {var valid26: any = true;}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid25: any = _errs86 === errors;if(props2 !== true){props2 = true;}valid0 = valid25;}else {validate1627.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate1627.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props2 !== true){for(const key8 in data){if(!props2 || !props2[key8]){validate1627.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key8}}];return false;break;}}}}}else {validate1627.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1627.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1627.errors = null as any[] | null;
// prettier-ignore
validate1627.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloneQuestionId}. */
export const validateCloneQuestionId: SchemaCheck<CloneQuestionId> = validate1618;
/** Checks that a value is a {@link ProjectCloneAnswerRequest}. */
export const validateProjectCloneAnswerRequest: SchemaCheck<ProjectCloneAnswerRequest> =
  validate1619;
/** Checks that a value is a {@link ProjectCloneFolderReadResponse}. */
export const validateProjectCloneFolderReadResponse: SchemaCheck<ProjectCloneFolderReadResponse> =
  validate1620;
/** Checks that a value is a {@link ProjectCloneRequest}. */
export const validateProjectCloneRequest: SchemaCheck<ProjectCloneRequest> = validate1623;
/** Checks that a value is a {@link ProjectCloneStartRequest}. */
export const validateProjectCloneStartRequest: SchemaCheck<ProjectCloneStartRequest> = validate1624;
/** Checks that a value is a {@link ProjectCloneStartResponse}. */
export const validateProjectCloneStartResponse: SchemaCheck<ProjectCloneStartResponse> =
  validate1626;
/** Checks that a value is a {@link ProjectCloneStatus}. */
export const validateProjectCloneStatus: SchemaCheck<ProjectCloneStatus> = validate1627;
