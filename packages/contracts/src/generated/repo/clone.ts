// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Cloning: project.clone.start makes a project from a repository URL, and its card follows the clone live.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type WslPlace, validateWslPlace } from "../place.js";
import { type ProjectId, validateProjectId } from "../project.js";

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
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link ProjectCloneStartRequest}. */
// prettier-ignore
export const validateProjectCloneStartRequest: CompiledSchemaCheck<ProjectCloneStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.url === undefined) && (missing0 = "url")) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateProjectCloneStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "url") || (key0 === "parentFolder")) || (key0 === "place")) || (key0 === "projectId")) || (key0 === "clientIdempotencyKey"))){validateProjectCloneStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.url !== undefined){let data0: any = data.url;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 2048){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/maxLength",keyword:"maxLength",params:{limit: 2048}}];return false;}else {if(func1(data0) < 1){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/url",schemaPath:"#/properties/url/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.parentFolder !== undefined){let data1: any = data.parentFolder;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/parentFolder",schemaPath:"#/properties/parentFolder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs6: any = errors;if(!(validateWslPlace.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWslPlace.errors : vErrors.concat(validateWslPlace.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){const _errs7: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs8: any = errors;if(errors === _errs8){if(typeof data4 === "string"){if(!pattern88.test(data4)){validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateProjectCloneStartRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}else {validateProjectCloneStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectCloneStartResponse}. */
// prettier-ignore
export const validateProjectCloneStartResponse: CompiledSchemaCheck<ProjectCloneStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validateProjectCloneStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projectId")){validateProjectCloneStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}}}}}else {validateProjectCloneStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectCloneRequest}. */
// prettier-ignore
export const validateProjectCloneRequest: CompiledSchemaCheck<ProjectCloneRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.projectId === undefined) && (missing0 = "projectId")){validateProjectCloneRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "projectId")){validateProjectCloneRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}}}}}else {validateProjectCloneRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CloneQuestionId}. */
// prettier-ignore
export const validateCloneQuestionId: CompiledSchemaCheck<CloneQuestionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CloneQuestionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCloneQuestionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateCloneQuestionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateCloneQuestionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateCloneQuestionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCloneQuestionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1047: any = {"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":1024,"description":"The phase, in git's words."},"percent":{"type":["integer","null"],"minimum":0,"maximum":100,"description":"The whole percent git printed, or `null`."}},"required":["phase","percent"],"description":"Git's progress in its own words, `Receiving objects` at 42 percent."};
/** Checks that a value is a {@link ProjectCloneProgress}. */
// prettier-ignore
export const validateProjectCloneProgress: CompiledSchemaCheck<ProjectCloneProgress> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneProgress.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.phase === undefined) && (missing0 = "phase")) || ((data.percent === undefined) && (missing0 = "percent"))){validateProjectCloneProgress.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "phase") || (key0 === "percent"))){validateProjectCloneProgress.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.phase !== undefined){let data0: any = data.phase;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1024){validateProjectCloneProgress.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/properties/phase/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data0) < 1){validateProjectCloneProgress.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/properties/phase/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateProjectCloneProgress.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/properties/phase/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProjectCloneProgress.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/properties/phase/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.percent !== undefined){let data1: any = data.percent;const _errs4: any = errors;if((!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))) && (data1 !== null)){validateProjectCloneProgress.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/type",keyword:"type",params:{type: schema1047.properties.percent.type}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 100 || isNaN(data1)){validateProjectCloneProgress.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/maximum",keyword:"maximum",params:{comparison: "<=", limit: 100}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateProjectCloneProgress.errors = [{instancePath:instancePath+"/percent",schemaPath:"#/properties/percent/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateProjectCloneProgress.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneProgress.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneProgress.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectCloneQuestion}. */
// prettier-ignore
export const validateProjectCloneQuestion: CompiledSchemaCheck<ProjectCloneQuestion> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneQuestion {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneQuestion.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.questionId === undefined) && (missing0 = "questionId")) || ((data.prompt === undefined) && (missing0 = "prompt"))) || ((data.masked === undefined) && (missing0 = "masked"))){validateProjectCloneQuestion.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "questionId") || (key0 === "prompt")) || (key0 === "masked"))){validateProjectCloneQuestion.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.questionId !== undefined){const _errs2: any = errors;if(!(validateCloneQuestionId.call(this, data.questionId, {instancePath:instancePath+"/questionId",parentData:data,parentDataProperty:"questionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloneQuestionId.errors : vErrors.concat(validateCloneQuestionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.prompt !== undefined){let data1: any = data.prompt;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 1024){validateProjectCloneQuestion.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data1) < 1){validateProjectCloneQuestion.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateProjectCloneQuestion.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateProjectCloneQuestion.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/properties/prompt/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.masked !== undefined){const _errs5: any = errors;if(typeof data.masked !== "boolean"){validateProjectCloneQuestion.errors = [{instancePath:instancePath+"/masked",schemaPath:"#/properties/masked/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateProjectCloneQuestion.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneQuestion.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneQuestion.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1049: any = {"description":"The step a failed clone failed at: `clone` or `largeFiles` with git's own line, or `sessions`\nwhen the sessions that waited on the clone could not be started after it attached.","type":"string","enum":["clone","largeFiles","sessions"]};
/** Checks that a value is a {@link ProjectCloneFailedStep}. */
// prettier-ignore
export const validateProjectCloneFailedStep: CompiledSchemaCheck<ProjectCloneFailedStep> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneFailedStep {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneFailedStep.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProjectCloneFailedStep.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "clone") || (data === "largeFiles")) || (data === "sessions"))){validateProjectCloneFailedStep.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1049.enum}}];return false;}validateProjectCloneFailedStep.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneFailedStep.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1046: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"cloning"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"progress":{"anyOf":[{"$ref":"#/$defs/ProjectCloneProgress"},{"type":"null"}],"description":"Git's latest progress, or `null`."},"question":{"anyOf":[{"$ref":"#/$defs/ProjectCloneQuestion"},{"type":"null"}],"description":"The question git is waiting on, or `null`."}},"required":["state","projectId","progress","question"],"description":"Git is cloning."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"pullingLargeFiles"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"progress":{"anyOf":[{"$ref":"#/$defs/ProjectCloneProgress"},{"type":"null"}],"description":"Git's latest progress, or `null`."},"question":{"anyOf":[{"$ref":"#/$defs/ProjectCloneQuestion"},{"type":"null"}],"description":"The question git is waiting on, or `null`."}},"required":["state","projectId","progress","question"],"description":"Git is pulling large files."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"failed"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"step":{"$ref":"#/$defs/ProjectCloneFailedStep","description":"The step."},"failureLine":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":1024,"description":"Its last error line; `null` only when the service restarted during the clone and git\nleft none."}},"required":["state","projectId","step","failureLine"],"description":"A step failed."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"largeFilesMissing"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."}},"required":["state","projectId"],"description":"The clone finished with its large files left as placeholders."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"canceled"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."}},"required":["state","projectId"],"description":"The clone was canceled."},{"type":"object","additionalProperties":false,"properties":{"state":{"type":"string","const":"done"},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."}},"required":["state","projectId"],"description":"The clone is done."}],"description":"One `project.clone.subscribe` emission, the clone card's whole state. `largeFilesMissing` means\nthe clone finished but the repository keeps large files in Git LFS, which is not installed, so\nthey arrived as placeholders; `canceled` and `done` end the card.","discriminator":{"propertyName":"state"},"type":"object","unevaluatedProperties":false};
/** Checks that a value is a {@link ProjectCloneStatus}. */
// prettier-ignore
export const validateProjectCloneStatus: CompiledSchemaCheck<ProjectCloneStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "cloning"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.state === undefined) && (missing0 = "state")) || ((data.projectId === undefined) && (missing0 = "projectId"))) || ((data.progress === undefined) && (missing0 = "progress"))) || ((data.question === undefined) && (missing0 = "question"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "state") || (key0 === "projectId")) || (key0 === "progress")) || (key0 === "question"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("cloning" !== data0){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "cloning"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.projectId !== undefined){const _errs7: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.progress !== undefined){let data2: any = data.progress;const _errs8: any = errors;const _errs9: any = errors;let valid3: any = false;const _errs10: any = errors;if(!(validateProjectCloneProgress.call(this, data2, {instancePath:instancePath+"/progress",parentData:data,parentDataProperty:"progress",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectCloneProgress.errors : vErrors.concat(validateProjectCloneProgress.errors);errors = vErrors.length;}var _valid0: any = _errs10 === errors;valid3 = valid3 || _valid0;const _errs11: any = errors;if(data2 !== null){const err0: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs11 === errors;valid3 = valid3 || _valid0;if(!valid3){const err1: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/0/properties/progress/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateProjectCloneStatus.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.question !== undefined){let data3: any = data.question;const _errs13: any = errors;const _errs14: any = errors;let valid4: any = false;const _errs15: any = errors;if(!(validateProjectCloneQuestion.call(this, data3, {instancePath:instancePath+"/question",parentData:data,parentDataProperty:"question",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectCloneQuestion.errors : vErrors.concat(validateProjectCloneQuestion.errors);errors = vErrors.length;}var _valid1: any = _errs15 === errors;valid4 = valid4 || _valid1;const _errs16: any = errors;if(data3 !== null){const err2: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/0/properties/question/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid1: any = _errs16 === errors;valid4 = valid4 || _valid1;if(!valid4){const err3: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/0/properties/question/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateProjectCloneStatus.errors = vErrors;return false;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}}}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props2: any = true;valid0 = valid1;}else if(tag0 === "pullingLargeFiles"){const _errs18: any = errors;if(errors === _errs18){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.projectId === undefined) && (missing1 = "projectId"))) || ((data.progress === undefined) && (missing1 = "progress"))) || ((data.question === undefined) && (missing1 = "question"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs20: any = errors;for(const key1 in data){if(!((((key1 === "state") || (key1 === "projectId")) || (key1 === "progress")) || (key1 === "question"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs20 === errors){if(data.state !== undefined){let data4: any = data.state;const _errs21: any = errors;if(typeof data4 !== "string"){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("pullingLargeFiles" !== data4){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "pullingLargeFiles"}}];return false;}var valid6: any = _errs21 === errors;}else {var valid6: any = true;}if(valid6){if(data.projectId !== undefined){const _errs23: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid6: any = _errs23 === errors;}else {var valid6: any = true;}if(valid6){if(data.progress !== undefined){let data6: any = data.progress;const _errs24: any = errors;const _errs25: any = errors;let valid7: any = false;const _errs26: any = errors;if(!(validateProjectCloneProgress.call(this, data6, {instancePath:instancePath+"/progress",parentData:data,parentDataProperty:"progress",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectCloneProgress.errors : vErrors.concat(validateProjectCloneProgress.errors);errors = vErrors.length;}var _valid2: any = _errs26 === errors;valid7 = valid7 || _valid2;const _errs27: any = errors;if(data6 !== null){const err4: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/1/properties/progress/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid2: any = _errs27 === errors;valid7 = valid7 || _valid2;if(!valid7){const err5: any = {instancePath:instancePath+"/progress",schemaPath:"#/oneOf/1/properties/progress/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validateProjectCloneStatus.errors = vErrors;return false;}else {errors = _errs25;if(vErrors !== null){if(_errs25){vErrors.length = _errs25;}else {vErrors = null;}}}var valid6: any = _errs24 === errors;}else {var valid6: any = true;}if(valid6){if(data.question !== undefined){let data7: any = data.question;const _errs29: any = errors;const _errs30: any = errors;let valid8: any = false;const _errs31: any = errors;if(!(validateProjectCloneQuestion.call(this, data7, {instancePath:instancePath+"/question",parentData:data,parentDataProperty:"question",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectCloneQuestion.errors : vErrors.concat(validateProjectCloneQuestion.errors);errors = vErrors.length;}var _valid3: any = _errs31 === errors;valid8 = valid8 || _valid3;const _errs32: any = errors;if(data7 !== null){const err6: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/1/properties/question/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var _valid3: any = _errs32 === errors;valid8 = valid8 || _valid3;if(!valid8){const err7: any = {instancePath:instancePath+"/question",schemaPath:"#/oneOf/1/properties/question/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;validateProjectCloneStatus.errors = vErrors;return false;}else {errors = _errs30;if(vErrors !== null){if(_errs30){vErrors.length = _errs30;}else {vErrors = null;}}}var valid6: any = _errs29 === errors;}else {var valid6: any = true;}}}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs18 === errors;if(props2 !== true){props2 = true;}valid0 = valid5;}else if(tag0 === "failed"){const _errs34: any = errors;if(errors === _errs34){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.state === undefined) && (missing2 = "state")) || ((data.projectId === undefined) && (missing2 = "projectId"))) || ((data.step === undefined) && (missing2 = "step"))) || ((data.failureLine === undefined) && (missing2 = "failureLine"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs36: any = errors;for(const key2 in data){if(!((((key2 === "state") || (key2 === "projectId")) || (key2 === "step")) || (key2 === "failureLine"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs36 === errors){if(data.state !== undefined){let data8: any = data.state;const _errs37: any = errors;if(typeof data8 !== "string"){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data8){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid10: any = _errs37 === errors;}else {var valid10: any = true;}if(valid10){if(data.projectId !== undefined){const _errs39: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid10: any = _errs39 === errors;}else {var valid10: any = true;}if(valid10){if(data.step !== undefined){const _errs40: any = errors;if(!(validateProjectCloneFailedStep.call(this, data.step, {instancePath:instancePath+"/step",parentData:data,parentDataProperty:"step",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectCloneFailedStep.errors : vErrors.concat(validateProjectCloneFailedStep.errors);errors = vErrors.length;}var valid10: any = _errs40 === errors;}else {var valid10: any = true;}if(valid10){if(data.failureLine !== undefined){let data11: any = data.failureLine;const _errs41: any = errors;if((typeof data11 !== "string") && (data11 !== null)){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/type",keyword:"type",params:{type: schema1046.oneOf[2].properties.failureLine.type}}];return false;}if(errors === _errs41){if(typeof data11 === "string"){if(func1(data11) > 1024){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data11) < 1){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data11)){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/failureLine",schemaPath:"#/oneOf/2/properties/failureLine/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid10: any = _errs41 === errors;}else {var valid10: any = true;}}}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs34 === errors;if(props2 !== true){props2 = true;}valid0 = valid9;}else if(tag0 === "largeFilesMissing"){const _errs43: any = errors;if(errors === _errs43){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((data.state === undefined) && (missing3 = "state")) || ((data.projectId === undefined) && (missing3 = "projectId"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs45: any = errors;for(const key3 in data){if(!((key3 === "state") || (key3 === "projectId"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs45 === errors){if(data.state !== undefined){let data12: any = data.state;const _errs46: any = errors;if(typeof data12 !== "string"){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("largeFilesMissing" !== data12){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "largeFilesMissing"}}];return false;}var valid12: any = _errs46 === errors;}else {var valid12: any = true;}if(valid12){if(data.projectId !== undefined){const _errs48: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid12: any = _errs48 === errors;}else {var valid12: any = true;}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs43 === errors;if(props2 !== true){props2 = true;}valid0 = valid11;}else if(tag0 === "canceled"){const _errs49: any = errors;if(errors === _errs49){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if(((data.state === undefined) && (missing4 = "state")) || ((data.projectId === undefined) && (missing4 = "projectId"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs51: any = errors;for(const key4 in data){if(!((key4 === "state") || (key4 === "projectId"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs51 === errors){if(data.state !== undefined){let data14: any = data.state;const _errs52: any = errors;if(typeof data14 !== "string"){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("canceled" !== data14){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "canceled"}}];return false;}var valid14: any = _errs52 === errors;}else {var valid14: any = true;}if(valid14){if(data.projectId !== undefined){const _errs54: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid14: any = _errs54 === errors;}else {var valid14: any = true;}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}var valid13: any = _errs49 === errors;if(props2 !== true){props2 = true;}valid0 = valid13;}else if(tag0 === "done"){const _errs55: any = errors;if(errors === _errs55){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((data.state === undefined) && (missing5 = "state")) || ((data.projectId === undefined) && (missing5 = "projectId"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/5/required",keyword:"required",params:{missingProperty: missing5}}];return false;}else {const _errs57: any = errors;for(const key5 in data){if(!((key5 === "state") || (key5 === "projectId"))){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs57 === errors){if(data.state !== undefined){let data16: any = data.state;const _errs58: any = errors;if(typeof data16 !== "string"){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("done" !== data16){validateProjectCloneStatus.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/5/properties/state/const",keyword:"const",params:{allowedValue: "done"}}];return false;}var valid16: any = _errs58 === errors;}else {var valid16: any = true;}if(valid16){if(data.projectId !== undefined){const _errs60: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid16: any = _errs60 === errors;}else {var valid16: any = true;}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/oneOf/5/type",keyword:"type",params:{type: "object"}}];return false;}}var valid15: any = _errs55 === errors;if(props2 !== true){props2 = true;}valid0 = valid15;}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props2 !== true){for(const key6 in data){if(!props2 || !props2[key6]){validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key6}}];return false;break;}}}}}else {validateProjectCloneStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneStatus.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern712 = new RegExp("^[^\\x00\\r\\n]*$", "u");
/** Checks that a value is a {@link AskpassAnswer}. */
// prettier-ignore
export const validateAskpassAnswer: CompiledSchemaCheck<AskpassAnswer> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AskpassAnswer {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAskpassAnswer.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 4096){validateAskpassAnswer.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(!pattern712.test(data)){validateAskpassAnswer.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00\\r\\n]*$"}}];return false;}}}else {validateAskpassAnswer.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateAskpassAnswer.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAskpassAnswer.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectCloneAnswerRequest}. */
// prettier-ignore
export const validateProjectCloneAnswerRequest: CompiledSchemaCheck<ProjectCloneAnswerRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneAnswerRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneAnswerRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.projectId === undefined) && (missing0 = "projectId")) || ((data.questionId === undefined) && (missing0 = "questionId"))) || ((data.answer === undefined) && (missing0 = "answer"))){validateProjectCloneAnswerRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "projectId") || (key0 === "questionId")) || (key0 === "answer"))){validateProjectCloneAnswerRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.projectId !== undefined){const _errs2: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.questionId !== undefined){const _errs3: any = errors;if(!(validateCloneQuestionId.call(this, data.questionId, {instancePath:instancePath+"/questionId",parentData:data,parentDataProperty:"questionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCloneQuestionId.errors : vErrors.concat(validateCloneQuestionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.answer !== undefined){const _errs4: any = errors;if(!(validateAskpassAnswer.call(this, data.answer, {instancePath:instancePath+"/answer",parentData:data,parentDataProperty:"answer",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAskpassAnswer.errors : vErrors.concat(validateAskpassAnswer.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateProjectCloneAnswerRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneAnswerRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneAnswerRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1042: any = {"description":"Why a clone goes where it does.","type":"string","enum":["setting","lastProject","home"]};
/** Checks that a value is a {@link ProjectCloneFolderSource}. */
// prettier-ignore
export const validateProjectCloneFolderSource: CompiledSchemaCheck<ProjectCloneFolderSource> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneFolderSource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneFolderSource.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateProjectCloneFolderSource.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "setting") || (data === "lastProject")) || (data === "home"))){validateProjectCloneFolderSource.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1042.enum}}];return false;}validateProjectCloneFolderSource.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneFolderSource.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProjectCloneFolderReadResponse}. */
// prettier-ignore
export const validateProjectCloneFolderReadResponse: CompiledSchemaCheck<ProjectCloneFolderReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProjectCloneFolderReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProjectCloneFolderReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.folder === undefined) && (missing0 = "folder")) || ((data.source === undefined) && (missing0 = "source"))){validateProjectCloneFolderReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "folder") || (key0 === "place")) || (key0 === "source"))){validateProjectCloneFolderReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.folder !== undefined){let data0: any = data.folder;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateProjectCloneFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateProjectCloneFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateProjectCloneFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateProjectCloneFolderReadResponse.errors = [{instancePath:instancePath+"/folder",schemaPath:"#/properties/folder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs4: any = errors;if(!(validateWslPlace.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWslPlace.errors : vErrors.concat(validateWslPlace.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){const _errs5: any = errors;if(!(validateProjectCloneFolderSource.call(this, data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectCloneFolderSource.errors : vErrors.concat(validateProjectCloneFolderSource.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateProjectCloneFolderReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProjectCloneFolderReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProjectCloneFolderReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
