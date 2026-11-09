// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A question record and the one call that answers it.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";

/**
 * The daemon-minted id of one question record.
 */
export type QuestionId = string & { readonly __brand: "QuestionId" };
/**
 * The answer a form field starts from, as the form declared it: the label of the option it
 * preselects (several labels on a field of several picks), or a typed field's value in its own
 * type.
 */
export type QuestionDefault = string | number | boolean | string[];
/**
 * Where a run's question record stands when it is written: open, answerable at once; or waiting
 * for its run, asked while the run was not running, which the card shows greyed under the line
 * `Waiting for the run` until `question.opened` makes it answerable, in the order its run's
 * questions came.
 */
export type QuestionAskedState = "open" | "waitingForRun";
/**
 * The `question.asked` payload: exactly one of `runId` and `waitId` names what is waiting.
 */
export type QuestionAskedPayload =
  | {
      /**
       * The question.
       */
      questionId: QuestionId;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run that waits.
       */
      runId: RunId;
      /**
       * Whether the question is answerable at once or waits for its run.
       */
      state: QuestionAskedState;
      /**
       * The provider's own id of the request the question came on, by which a request the
       * provider sends again after the daemon's restart finds its record; absent where the id
       * is longer than a provider handle.
       */
      providerRequestId?: string;
      /**
       * Only a workflow step's question names a wait.
       */
      waitId?: never;
      /**
       * False only on a question the agent does not wait for: its run keeps running, no card
       * of its own is raised, and the admission of the queued message naming it as
       * `answersQuestionId` marks it answered.
       */
      isAgentWaiting: boolean;
      /**
       * Every question of the record in page order, so a rebuilt card pages through them
       * with no further read.
       *
       * @minItems 1
       */
      questions: [QuestionPrompt, ...QuestionPrompt[]];
    }
  | {
      /**
       * The question.
       */
      questionId: QuestionId;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Only an agent's or a tool server's question names a run.
       */
      runId?: never;
      /**
       * The workflow wait.
       */
      waitId: string;
      /**
       * Only a run's question can wait for its run; a workflow wait's is open at once.
       */
      state?: never;
      /**
       * False only on a question the agent does not wait for: its run keeps running, no card
       * of its own is raised, and the admission of the queued message naming it as
       * `answersQuestionId` marks it answered.
       */
      isAgentWaiting: boolean;
      /**
       * Every question of the record in page order, so a rebuilt card pages through them
       * with no further read.
       *
       * @minItems 1
       */
      questions: [QuestionPrompt, ...QuestionPrompt[]];
    };
/**
 * Why an open question ended unanswered: its turn was interrupted, its provider withdrew the
 * request, or its run ended, a restart of the background service among the ways a run ends.
 */
export type QuestionCanceledReason = "interrupted" | "withdrawn" | "runEnded";
/**
 * The answer to one question: the picked labels, typed text, a secret, or a skip; each question
 * takes exactly one.
 */
export type QuestionAnswer =
  | {
      kind: "picked";
      /**
       * Their labels.
       *
       * @minItems 1
       */
      labels: [string, ...string[]];
    }
  | {
      kind: "typed";
      /**
       * The text.
       */
      text: string;
    }
  | {
      kind: "secret";
      /**
       * The secret.
       */
      value: string;
    }
  | {
      kind: "skipped";
    };
/**
 * Why `question.answerInvalid` refused one answer, carried as its `reason`: a secret for a plain
 * question, a label the question does not offer, several labels for a question that takes one,
 * or typed text for a question that takes only its options.
 */
export type QuestionAnswerInvalidReason =
  | "secretOnPlain"
  | "labelNotOffered"
  | "severalOnSingle"
  | "textOnChoice";
/**
 * The state `question.resolve` replies with: the record answered or canceled, or the answer kept
 * for the tool server's next ask.
 */
export type QuestionResolveState = "answered" | "canceled" | "kept";

/**
 * One option row; `preview` is present only where the provider attached one to the option.
 */
export interface QuestionOption {
  /**
   * The option's label.
   */
  label: string;
  /**
   * What it means.
   */
  description?: string;
  /**
   * What picking it would look like.
   */
  preview?: string;
}
/**
 * One question of the record, one page of the card. A secret question takes a masked answer and
 * has no option rows; a numeric field's smallest number is at most its largest; a question with
 * option rows starts from its own options, which the schema states as `defaultAmongOptions`.
 */
export interface QuestionPrompt {
  /**
   * The agent's own short header, a tool server's name, or a workflow's name.
   */
  header?: string;
  /**
   * The question.
   */
  text: string;
  /**
   * The summary line, where the agent sent one.
   */
  heading?: string;
  /**
   * The question's own helper line, drawn faint under its text.
   */
  description?: string;
  /**
   * The option rows; empty on a secret question.
   */
  options: QuestionOption[];
  /**
   * The provider's own reading of whether several picks go back together.
   */
  severalAnswers: boolean;
  /**
   * Whether the answer is masked and never stored.
   */
  secret: boolean;
  /**
   * Whether the form must have this field answered. Only a tool server's form field sets it, and
   * a producer that sets it on an agent's question makes that question refuse typed text.
   */
  required?: boolean;
  /**
   * The answer the field starts from, present only where the form declared one.
   */
  default?: QuestionDefault;
  /**
   * The smallest number a numeric field takes, where the form bounds it.
   */
  minimum?: number;
  /**
   * The largest number a numeric field takes, where the form bounds it.
   */
  maximum?: number;
  /**
   * How far the arrow keys move a number field, where the question sets it.
   */
  step?: number;
  /**
   * A short unit drawn as a suffix inside a number field, where the question sets one.
   */
  unit?: string;
  /**
   * A text field's faint hint while it is empty, where the question sets one.
   */
  placeholder?: string;
}
/**
 * `question.opened`: a question waiting for its run became answerable once the run read running,
 * in the write that moves the run to `waitingForInput` on it, so its card is no longer greyed.
 */
export interface QuestionOpenedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The question.
   */
  questionId: QuestionId;
}
/**
 * `question.canceled`: an open question, or one waiting for its run, ended unanswered, so its card
 * stays closed after a reload and on every device, and no `user.message.sent` is written.
 */
export interface QuestionCanceledPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The question.
   */
  questionId: QuestionId;
  /**
   * Why it ended.
   */
  reason: QuestionCanceledReason;
}
/**
 * `question.resolve`: every answer at once, one per question in the record's own order. The
 * daemon refuses a list that does not answer every question rather than applying half of it.
 */
export interface QuestionResolveRequest {
  /**
   * The question.
   */
  questionId: QuestionId;
  /**
   * The answers.
   *
   * @minItems 1
   */
  answers: [QuestionAnswer, ...QuestionAnswer[]];
}
/**
 * The `question.resolve` result: the record's settled state, or the kept answer.
 */
export interface QuestionResolveResponse {
  /**
   * The question.
   */
  questionId: QuestionId;
  /**
   * The record's settled state, or `kept` for an answer kept for the tool server's next ask.
   */
  state: QuestionResolveState;
}

// prettier-ignore
const schema1025: any = {"description":"Where a run's question record stands when it is written: open, answerable at once; or waiting\nfor its run, asked while the run was not running, which the card shows greyed under the line\n`Waiting for the run` until `question.opened` makes it answerable, in the order its run's\nquestions came.","type":"string","enum":["open","waitingForRun"]};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const schema1026: any = {"type":"object","additionalProperties":false,"properties":{"header":{"type":"string","minLength":1,"description":"The agent's own short header, a tool server's name, or a workflow's name."},"text":{"type":"string","minLength":1,"description":"The question."},"heading":{"type":"string","minLength":1,"description":"The summary line, where the agent sent one."},"description":{"type":"string","minLength":1,"description":"The question's own helper line, drawn faint under its text."},"options":{"type":"array","items":{"$ref":"#/$defs/QuestionOption"},"description":"The option rows; empty on a secret question."},"severalAnswers":{"type":"boolean","description":"The provider's own reading of whether several picks go back together."},"secret":{"type":"boolean","description":"Whether the answer is masked and never stored."},"required":{"type":"boolean","description":"Whether the form must have this field answered. Only a tool server's form field sets it, and\na producer that sets it on an agent's question makes that question refuse typed text."},"default":{"$ref":"#/$defs/QuestionDefault","description":"The answer the field starts from, present only where the form declared one."},"minimum":{"type":"number","description":"The smallest number a numeric field takes, where the form bounds it.","maximum":{"$data":"1/maximum"}},"maximum":{"type":"number","description":"The largest number a numeric field takes, where the form bounds it."},"step":{"type":"number","description":"How far the arrow keys move a number field, where the question sets it."},"unit":{"type":"string","minLength":1,"description":"A short unit drawn as a suffix inside a number field, where the question sets one."},"placeholder":{"type":"string","minLength":1,"description":"A text field's faint hint while it is empty, where the question sets one."}},"required":["text","options","severalAnswers","secret"],"description":"One question of the record, one page of the card. A secret question takes a masked answer and\nhas no option rows; a numeric field's smallest number is at most its largest; a question with\noption rows starts from its own options, which the schema states as `defaultAmongOptions`.","if":{"type":"object","properties":{"secret":{"const":true}},"required":["secret"]},"then":{"type":"object","properties":{"options":{"type":"array","maxItems":0}}},"defaultAmongOptions":true};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate552(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate552.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.secret === undefined) && (missing0 = "secret")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.secret !== undefined){if(true !== data.secret){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}if(_valid0){const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){if(data.options !== undefined){let data1: any = data.options;const _errs7: any = errors;if(errors === _errs7){if(Array.isArray(data1)){if(data1.length > 0){validate552.errors = [{instancePath:instancePath+"/options",schemaPath:"#/then/properties/options/maxItems",keyword:"maxItems",params:{limit: 0}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/options",schemaPath:"#/then/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}}}else {validate552.errors = [{instancePath,schemaPath:"#/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs5 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.options = true;props0.secret = true;}}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate552.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.text === undefined) && (missing1 = "text")) || ((data.options === undefined) && (missing1 = "options"))) || ((data.severalAnswers === undefined) && (missing1 = "severalAnswers"))) || ((data.secret === undefined) && (missing1 = "secret"))){validate552.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key0 in data){if(!(func2.call(schema1026.properties, key0))){validate552.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs9 === errors){if(data.header !== undefined){let data2: any = data.header;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate552.errors = [{instancePath:instancePath+"/header",schemaPath:"#/properties/header/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/header",schemaPath:"#/properties/header/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}if(valid3){if(data.text !== undefined){let data3: any = data.text;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) < 1){validate552.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data.heading !== undefined){let data4: any = data.heading;const _errs14: any = errors;if(errors === _errs14){if(typeof data4 === "string"){if(func1(data4) < 1){validate552.errors = [{instancePath:instancePath+"/heading",schemaPath:"#/properties/heading/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/heading",schemaPath:"#/properties/heading/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data.description !== undefined){let data5: any = data.description;const _errs16: any = errors;if(errors === _errs16){if(typeof data5 === "string"){if(func1(data5) < 1){validate552.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}if(valid3){if(data.options !== undefined){let data6: any = data.options;const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data6)){var valid4: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(data7 && typeof data7 == "object" && !Array.isArray(data7)){let missing2: any;if((data7.label === undefined) && (missing2 = "label")){validate552.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/QuestionOption/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key1 in data7){if(!(((key1 === "label") || (key1 === "description")) || (key1 === "preview"))){validate552.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/QuestionOption/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs23 === errors){if(data7.label !== undefined){let data8: any = data7.label;const _errs24: any = errors;if(errors === _errs24){if(typeof data8 === "string"){if(func1(data8) < 1){validate552.errors = [{instancePath:instancePath+"/options/" + i0+"/label",schemaPath:"#/$defs/QuestionOption/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/options/" + i0+"/label",schemaPath:"#/$defs/QuestionOption/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs24 === errors;}else {var valid6: any = true;}if(valid6){if(data7.description !== undefined){const _errs26: any = errors;if(typeof data7.description !== "string"){validate552.errors = [{instancePath:instancePath+"/options/" + i0+"/description",schemaPath:"#/$defs/QuestionOption/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid6: any = _errs26 === errors;}else {var valid6: any = true;}if(valid6){if(data7.preview !== undefined){const _errs28: any = errors;if(typeof data7.preview !== "string"){validate552.errors = [{instancePath:instancePath+"/options/" + i0+"/preview",schemaPath:"#/$defs/QuestionOption/properties/preview/type",keyword:"type",params:{type: "string"}}];return false;}var valid6: any = _errs28 === errors;}else {var valid6: any = true;}}}}}}else {validate552.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/QuestionOption/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs20 === errors;if(!valid4){break;}}}else {validate552.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid3: any = _errs18 === errors;}else {var valid3: any = true;}if(valid3){if(data.severalAnswers !== undefined){const _errs30: any = errors;if(typeof data.severalAnswers !== "boolean"){validate552.errors = [{instancePath:instancePath+"/severalAnswers",schemaPath:"#/properties/severalAnswers/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid3: any = _errs30 === errors;}else {var valid3: any = true;}if(valid3){if(data.secret !== undefined){const _errs32: any = errors;if(typeof data.secret !== "boolean"){validate552.errors = [{instancePath:instancePath+"/secret",schemaPath:"#/properties/secret/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid3: any = _errs32 === errors;}else {var valid3: any = true;}if(valid3){if(data.required !== undefined){const _errs34: any = errors;if(typeof data.required !== "boolean"){validate552.errors = [{instancePath:instancePath+"/required",schemaPath:"#/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid3: any = _errs34 === errors;}else {var valid3: any = true;}if(valid3){if(data.default !== undefined){let data14: any = data.default;const _errs36: any = errors;const _errs38: any = errors;let valid8: any = false;const _errs39: any = errors;if(typeof data14 !== "string"){const err4: any = {instancePath:instancePath+"/default",schemaPath:"#/$defs/QuestionDefault/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid1: any = _errs39 === errors;valid8 = valid8 || _valid1;const _errs41: any = errors;if(!((typeof data14 == "number") && (isFinite(data14)))){const err5: any = {instancePath:instancePath+"/default",schemaPath:"#/$defs/QuestionDefault/anyOf/1/type",keyword:"type",params:{type: "number"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}var _valid1: any = _errs41 === errors;valid8 = valid8 || _valid1;const _errs43: any = errors;if(typeof data14 !== "boolean"){const err6: any = {instancePath:instancePath+"/default",schemaPath:"#/$defs/QuestionDefault/anyOf/2/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var _valid1: any = _errs43 === errors;valid8 = valid8 || _valid1;const _errs45: any = errors;if(errors === _errs45){if(Array.isArray(data14)){var valid9: any = true;const len1: any = data14.length;for(let i1=0; i1<len1; i1++){let data15: any = data14[i1];const _errs47: any = errors;if(errors === _errs47){if(typeof data15 === "string"){if(func1(data15) < 1){const err7: any = {instancePath:instancePath+"/default/" + i1,schemaPath:"#/$defs/QuestionDefault/anyOf/3/items/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}else {const err8: any = {instancePath:instancePath+"/default/" + i1,schemaPath:"#/$defs/QuestionDefault/anyOf/3/items/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var valid9: any = _errs47 === errors;if(!valid9){break;}}}else {const err9: any = {instancePath:instancePath+"/default",schemaPath:"#/$defs/QuestionDefault/anyOf/3/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var _valid1: any = _errs45 === errors;valid8 = valid8 || _valid1;if(!valid8){const err10: any = {instancePath:instancePath+"/default",schemaPath:"#/$defs/QuestionDefault/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;validate552.errors = vErrors;return false;}else {errors = _errs38;if(vErrors !== null){if(_errs38){vErrors.length = _errs38;}else {vErrors = null;}}}var valid3: any = _errs36 === errors;}else {var valid3: any = true;}if(valid3){if(data.minimum !== undefined){let data16: any = data.minimum;const _errs49: any = errors;if(errors === _errs49){if((typeof data16 == "number") && (isFinite(data16))){const vSchema0: any = data && data.maximum;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data16 > vSchema0 || isNaN(data16)))){validate552.errors = [{instancePath:instancePath+"/minimum",schemaPath:"#/properties/minimum/maximum",keyword:"maximum",params:{comparison: "<=", limit: vSchema0}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/minimum",schemaPath:"#/properties/minimum/type",keyword:"type",params:{type: "number"}}];return false;}}var valid3: any = _errs49 === errors;}else {var valid3: any = true;}if(valid3){if(data.maximum !== undefined){let data17: any = data.maximum;const _errs51: any = errors;if(!((typeof data17 == "number") && (isFinite(data17)))){validate552.errors = [{instancePath:instancePath+"/maximum",schemaPath:"#/properties/maximum/type",keyword:"type",params:{type: "number"}}];return false;}var valid3: any = _errs51 === errors;}else {var valid3: any = true;}if(valid3){if(data.step !== undefined){let data18: any = data.step;const _errs53: any = errors;if(!((typeof data18 == "number") && (isFinite(data18)))){validate552.errors = [{instancePath:instancePath+"/step",schemaPath:"#/properties/step/type",keyword:"type",params:{type: "number"}}];return false;}var valid3: any = _errs53 === errors;}else {var valid3: any = true;}if(valid3){if(data.unit !== undefined){let data19: any = data.unit;const _errs55: any = errors;if(errors === _errs55){if(typeof data19 === "string"){if(func1(data19) < 1){validate552.errors = [{instancePath:instancePath+"/unit",schemaPath:"#/properties/unit/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/unit",schemaPath:"#/properties/unit/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs55 === errors;}else {var valid3: any = true;}if(valid3){if(data.placeholder !== undefined){let data20: any = data.placeholder;const _errs57: any = errors;if(errors === _errs57){if(typeof data20 === "string"){if(func1(data20) < 1){validate552.errors = [{instancePath:instancePath+"/placeholder",schemaPath:"#/properties/placeholder/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate552.errors = [{instancePath:instancePath+"/placeholder",schemaPath:"#/properties/placeholder/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs57 === errors;}else {var valid3: any = true;}if(valid3){let isAmongOptions0: any = true;if(Array.isArray(data.options) && data.options.length > 0){const labels0: any = typeof data.default == "string" ? [data.default] : Array.isArray(data.default) ? data.default : [];for(const label0 of labels0){let isOption0: any = false;for(const option0 of data.options){if(option0 && option0.label === label0){isOption0 = true;}}if(!isOption0){isAmongOptions0 = false;}}}if(!isAmongOptions0){validate552.errors = [{instancePath,schemaPath:"#/defaultAmongOptions",keyword:"defaultAmongOptions",params:{}}];return false;}}}}}}}}}}}}}}}}}}else {validate552.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate552.errors = vErrors;return errors === 0;}
// prettier-ignore
validate552.errors = null as any[] | null;
// prettier-ignore
validate552.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1606(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QuestionAskedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1606.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.questionId === undefined) && (missing0 = "questionId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.isAgentWaiting === undefined) && (missing0 = "isAgentWaiting"))) || ((data.questions === undefined) && (missing0 = "questions"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((((((key0 === "questionId") || (key0 === "sessionId")) || (key0 === "runId")) || (key0 === "state")) || (key0 === "providerRequestId")) || (key0 === "waitId")) || (key0 === "isAgentWaiting")) || (key0 === "questions"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.questionId !== undefined){let data0: any = data.questionId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data0 === "string"){if(!pattern4.test(data0)){const err2: any = {instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){const err4: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.runId !== undefined){let data2: any = data.runId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(!pattern4.test(data2)){const err6: any = {instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}else {const err7: any = {instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}var valid1: any = _errs12 === errors;}else {var valid1: any = true;}if(valid1){if(data.state !== undefined){let data3: any = data.state;const _errs16: any = errors;if(typeof data3 !== "string"){const err8: any = {instancePath:instancePath+"/state",schemaPath:"#/$defs/QuestionAskedState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}if(!((data3 === "open") || (data3 === "waitingForRun"))){const err9: any = {instancePath:instancePath+"/state",schemaPath:"#/$defs/QuestionAskedState/enum",keyword:"enum",params:{allowedValues: schema1025.enum}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}var valid1: any = _errs16 === errors;}else {var valid1: any = true;}if(valid1){if(data.providerRequestId !== undefined){let data4: any = data.providerRequestId;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(func1(data4) > 256){const err10: any = {instancePath:instancePath+"/providerRequestId",schemaPath:"#/anyOf/0/properties/providerRequestId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(func1(data4) < 1){const err11: any = {instancePath:instancePath+"/providerRequestId",schemaPath:"#/anyOf/0/properties/providerRequestId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(!pattern6.test(data4)){const err12: any = {instancePath:instancePath+"/providerRequestId",schemaPath:"#/anyOf/0/properties/providerRequestId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}}else {const err13: any = {instancePath:instancePath+"/providerRequestId",schemaPath:"#/anyOf/0/properties/providerRequestId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid1: any = _errs19 === errors;}else {var valid1: any = true;}if(valid1){if(data.waitId !== undefined){const _errs21: any = errors;const err14: any = {instancePath:instancePath+"/waitId",schemaPath:"#/anyOf/0/properties/waitId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;var valid1: any = _errs21 === errors;}else {var valid1: any = true;}if(valid1){if(data.isAgentWaiting !== undefined){const _errs24: any = errors;if(typeof data.isAgentWaiting !== "boolean"){const err15: any = {instancePath:instancePath+"/isAgentWaiting",schemaPath:"#/anyOf/0/properties/isAgentWaiting/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}var valid1: any = _errs24 === errors;}else {var valid1: any = true;}if(valid1){if(data.questions !== undefined){let data7: any = data.questions;const _errs26: any = errors;if(errors === _errs26){if(Array.isArray(data7)){if(data7.length < 1){const err16: any = {instancePath:instancePath+"/questions",schemaPath:"#/anyOf/0/properties/questions/minItems",keyword:"minItems",params:{limit: 1}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}else {var valid6: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){const _errs28: any = errors;if(!(validate552.call(this, data7[i0], {instancePath:instancePath+"/questions/" + i0,parentData:data7,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate552.errors : vErrors.concat(validate552.errors);errors = vErrors.length;}var valid6: any = _errs28 === errors;if(!valid6){break;}}}}else {const err17: any = {instancePath:instancePath+"/questions",schemaPath:"#/anyOf/0/properties/questions/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var valid1: any = _errs26 === errors;}else {var valid1: any = true;}}}}}}}}}}}else {const err18: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs29: any = errors;if(errors === _errs29){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.questionId === undefined) && (missing1 = "questionId")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.waitId === undefined) && (missing1 = "waitId"))) || ((data.isAgentWaiting === undefined) && (missing1 = "isAgentWaiting"))) || ((data.questions === undefined) && (missing1 = "questions"))){const err19: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}else {const _errs31: any = errors;for(const key1 in data){if(!(((((((key1 === "questionId") || (key1 === "sessionId")) || (key1 === "runId")) || (key1 === "waitId")) || (key1 === "state")) || (key1 === "isAgentWaiting")) || (key1 === "questions"))){const err20: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;break;}}if(_errs31 === errors){if(data.questionId !== undefined){let data9: any = data.questionId;const _errs32: any = errors;const _errs33: any = errors;if(errors === _errs33){if(typeof data9 === "string"){if(!pattern4.test(data9)){const err21: any = {instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}else {const err22: any = {instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid7: any = _errs32 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data10: any = data.sessionId;const _errs36: any = errors;const _errs37: any = errors;if(errors === _errs37){if(typeof data10 === "string"){if(!pattern4.test(data10)){const err23: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}else {const err24: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}var valid7: any = _errs36 === errors;}else {var valid7: any = true;}if(valid7){if(data.runId !== undefined){const _errs40: any = errors;const err25: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;var valid7: any = _errs40 === errors;}else {var valid7: any = true;}if(valid7){if(data.waitId !== undefined){let data12: any = data.waitId;const _errs43: any = errors;if(errors === _errs43){if(typeof data12 === "string"){if(!pattern4.test(data12)){const err26: any = {instancePath:instancePath+"/waitId",schemaPath:"#/anyOf/1/properties/waitId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}}else {const err27: any = {instancePath:instancePath+"/waitId",schemaPath:"#/anyOf/1/properties/waitId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}var valid7: any = _errs43 === errors;}else {var valid7: any = true;}if(valid7){if(data.state !== undefined){const _errs45: any = errors;const err28: any = {instancePath:instancePath+"/state",schemaPath:"#/anyOf/1/properties/state/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;var valid7: any = _errs45 === errors;}else {var valid7: any = true;}if(valid7){if(data.isAgentWaiting !== undefined){const _errs48: any = errors;if(typeof data.isAgentWaiting !== "boolean"){const err29: any = {instancePath:instancePath+"/isAgentWaiting",schemaPath:"#/anyOf/1/properties/isAgentWaiting/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}var valid7: any = _errs48 === errors;}else {var valid7: any = true;}if(valid7){if(data.questions !== undefined){let data15: any = data.questions;const _errs50: any = errors;if(errors === _errs50){if(Array.isArray(data15)){if(data15.length < 1){const err30: any = {instancePath:instancePath+"/questions",schemaPath:"#/anyOf/1/properties/questions/minItems",keyword:"minItems",params:{limit: 1}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}else {var valid10: any = true;const len1: any = data15.length;for(let i1=0; i1<len1; i1++){const _errs52: any = errors;if(!(validate552.call(this, data15[i1], {instancePath:instancePath+"/questions/" + i1,parentData:data15,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate552.errors : vErrors.concat(validate552.errors);errors = vErrors.length;}var valid10: any = _errs52 === errors;if(!valid10){break;}}}}else {const err31: any = {instancePath:instancePath+"/questions",schemaPath:"#/anyOf/1/properties/questions/type",keyword:"type",params:{type: "array"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}}var valid7: any = _errs50 === errors;}else {var valid7: any = true;}}}}}}}}}}else {const err32: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}}var _valid0: any = _errs29 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err33: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;validate1606.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1606.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1606.errors = null as any[] | null;
// prettier-ignore
validate1606.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema1037: any = {"description":"Why an open question ended unanswered: its turn was interrupted, its provider withdrew the\nrequest, or its run ended, a restart of the background service among the ways a run ends.","type":"string","enum":["interrupted","withdrawn","runEnded"]};
// prettier-ignore
function validate1609(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QuestionCanceledPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1609.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.questionId === undefined) && (missing0 = "questionId"))) || ((data.reason === undefined) && (missing0 = "reason"))){validate1609.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "questionId")) || (key0 === "reason"))){validate1609.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1609.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1609.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.questionId !== undefined){let data1: any = data.questionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1609.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1609.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs10: any = errors;if(typeof data2 !== "string"){validate1609.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/QuestionCanceledReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "interrupted") || (data2 === "withdrawn")) || (data2 === "runEnded"))){validate1609.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/QuestionCanceledReason/enum",keyword:"enum",params:{allowedValues: schema1037.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1609.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1609.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1609.errors = null as any[] | null;
// prettier-ignore
validate1609.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1610(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QuestionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1610.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1610.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1610.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1610.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1610.errors = null as any[] | null;
// prettier-ignore
validate1610.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1611(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QuestionOpenedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1611.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.questionId === undefined) && (missing0 = "questionId"))){validate1611.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "questionId"))){validate1611.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1611.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1611.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.questionId !== undefined){let data1: any = data.questionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1611.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1611.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1611.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1611.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1611.errors = null as any[] | null;
// prettier-ignore
validate1611.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1612(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QuestionResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1612.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.questionId === undefined) && (missing0 = "questionId")) || ((data.answers === undefined) && (missing0 = "answers"))){validate1612.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "questionId") || (key0 === "answers"))){validate1612.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.questionId !== undefined){let data0: any = data.questionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1612.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1612.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.answers !== undefined){let data1: any = data.answers;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data1)){if(data1.length < 1){validate1612.errors = [{instancePath:instancePath+"/answers",schemaPath:"#/properties/answers/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){let data2: any = data1[i0];const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let valid4: any = false;const tag0: any = data2.kind;if(typeof tag0 == "string"){if(tag0 === "picked"){const _errs12: any = errors;if(errors === _errs12){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing1: any;if(((data2.kind === undefined) && (missing1 = "kind")) || ((data2.labels === undefined) && (missing1 = "labels"))){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data2){if(!((key1 === "kind") || (key1 === "labels"))){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data2.kind !== undefined){let data3: any = data2.kind;const _errs15: any = errors;if(typeof data3 !== "string"){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("picked" !== data3){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "picked"}}];return false;}var valid6: any = _errs15 === errors;}else {var valid6: any = true;}if(valid6){if(data2.labels !== undefined){let data4: any = data2.labels;const _errs17: any = errors;if(errors === _errs17){if(Array.isArray(data4)){if(data4.length < 1){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/labels",schemaPath:"#/$defs/QuestionAnswer/oneOf/0/properties/labels/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid7: any = true;const len1: any = data4.length;for(let i1=0; i1<len1; i1++){let data5: any = data4[i1];const _errs19: any = errors;if(errors === _errs19){if(typeof data5 === "string"){if(func1(data5) < 1){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/labels/" + i1,schemaPath:"#/$defs/QuestionAnswer/oneOf/0/properties/labels/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/labels/" + i1,schemaPath:"#/$defs/QuestionAnswer/oneOf/0/properties/labels/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs19 === errors;if(!valid7){break;}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/labels",schemaPath:"#/$defs/QuestionAnswer/oneOf/0/properties/labels/type",keyword:"type",params:{type: "array"}}];return false;}}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs12 === errors;var props0: any = true;valid4 = valid5;}else if(tag0 === "typed"){const _errs21: any = errors;if(errors === _errs21){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing2: any;if(((data2.kind === undefined) && (missing2 = "kind")) || ((data2.text === undefined) && (missing2 = "text"))){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key2 in data2){if(!((key2 === "kind") || (key2 === "text"))){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs23 === errors){if(data2.kind !== undefined){let data6: any = data2.kind;const _errs24: any = errors;if(typeof data6 !== "string"){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("typed" !== data6){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "typed"}}];return false;}var valid9: any = _errs24 === errors;}else {var valid9: any = true;}if(valid9){if(data2.text !== undefined){let data7: any = data2.text;const _errs26: any = errors;if(errors === _errs26){if(typeof data7 === "string"){if(func1(data7) < 1){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/text",schemaPath:"#/$defs/QuestionAnswer/oneOf/1/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/text",schemaPath:"#/$defs/QuestionAnswer/oneOf/1/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs26 === errors;}else {var valid9: any = true;}}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid8: any = _errs21 === errors;if(props0 !== true){props0 = true;}valid4 = valid8;}else if(tag0 === "secret"){const _errs28: any = errors;if(errors === _errs28){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing3: any;if(((data2.kind === undefined) && (missing3 = "kind")) || ((data2.value === undefined) && (missing3 = "value"))){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/2/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs30: any = errors;for(const key3 in data2){if(!((key3 === "kind") || (key3 === "value"))){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs30 === errors){if(data2.kind !== undefined){let data8: any = data2.kind;const _errs31: any = errors;if(typeof data8 !== "string"){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("secret" !== data8){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "secret"}}];return false;}var valid11: any = _errs31 === errors;}else {var valid11: any = true;}if(valid11){if(data2.value !== undefined){let data9: any = data2.value;const _errs33: any = errors;if(errors === _errs33){if(typeof data9 === "string"){if(func1(data9) < 1){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/value",schemaPath:"#/$defs/QuestionAnswer/oneOf/2/properties/value/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/value",schemaPath:"#/$defs/QuestionAnswer/oneOf/2/properties/value/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs33 === errors;}else {var valid11: any = true;}}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs28 === errors;if(props0 !== true){props0 = true;}valid4 = valid10;}else if(tag0 === "skipped"){const _errs35: any = errors;if(errors === _errs35){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){let missing4: any;if((data2.kind === undefined) && (missing4 = "kind")){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/3/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs37: any = errors;for(const key4 in data2){if(!(key4 === "kind")){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs37 === errors){if(data2.kind !== undefined){let data10: any = data2.kind;if(typeof data10 !== "string"){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("skipped" !== data10){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0+"/kind",schemaPath:"#/$defs/QuestionAnswer/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "skipped"}}];return false;}}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid12: any = _errs35 === errors;if(props0 !== true){props0 = true;}valid4 = valid12;}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid4){if(props0 !== true){for(const key5 in data2){if(!props0 || !props0[key5]){validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key5}}];return false;break;}}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers/" + i0,schemaPath:"#/$defs/QuestionAnswer/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs8 === errors;if(!valid2){break;}}}}else {validate1612.errors = [{instancePath:instancePath+"/answers",schemaPath:"#/properties/answers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1612.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1612.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1612.errors = null as any[] | null;
// prettier-ignore
validate1612.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3006: any = {"description":"The state `question.resolve` replies with: the record answered or canceled, or the answer kept\nfor the tool server's next ask.","type":"string","enum":["answered","canceled","kept"]};
// prettier-ignore
function validate1613(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is QuestionResolveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1613.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.questionId === undefined) && (missing0 = "questionId")) || ((data.state === undefined) && (missing0 = "state"))){validate1613.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "questionId") || (key0 === "state"))){validate1613.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.questionId !== undefined){let data0: any = data.questionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1613.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1613.errors = [{instancePath:instancePath+"/questionId",schemaPath:"#/$defs/QuestionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs6: any = errors;if(typeof data1 !== "string"){validate1613.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/QuestionResolveState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "answered") || (data1 === "canceled")) || (data1 === "kept"))){validate1613.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/QuestionResolveState/enum",keyword:"enum",params:{allowedValues: schema3006.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1613.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1613.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1613.errors = null as any[] | null;
// prettier-ignore
validate1613.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link QuestionAskedPayload}. */
export const validateQuestionAskedPayload: SchemaCheck<QuestionAskedPayload> = validate1606;
/** Checks that a value is a {@link QuestionCanceledPayload}. */
export const validateQuestionCanceledPayload: SchemaCheck<QuestionCanceledPayload> = validate1609;
/** Checks that a value is a {@link QuestionId}. */
export const validateQuestionId: SchemaCheck<QuestionId> = validate1610;
/** Checks that a value is a {@link QuestionOpenedPayload}. */
export const validateQuestionOpenedPayload: SchemaCheck<QuestionOpenedPayload> = validate1611;
/** Checks that a value is a {@link QuestionResolveRequest}. */
export const validateQuestionResolveRequest: SchemaCheck<QuestionResolveRequest> = validate1612;
/** Checks that a value is a {@link QuestionResolveResponse}. */
export const validateQuestionResolveResponse: SchemaCheck<QuestionResolveResponse> = validate1613;

/** The methods of {@link QUESTION_METHOD_DESCRIPTORS}, each with its checks. */
export interface QuestionMethodDescriptors {
  readonly "question.resolve": {
    readonly method: "question.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<QuestionResolveRequest>;
    readonly responseCheck: SchemaCheck<QuestionResolveResponse>;
  };
}
/** The `question.*` methods a client calls. */
export const QUESTION_METHOD_DESCRIPTORS: QuestionMethodDescriptors = Object.freeze({
  "question.resolve": Object.freeze({
    method: "question.resolve",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateQuestionResolveRequest,
    responseCheck: validateQuestionResolveResponse,
  }),
});
