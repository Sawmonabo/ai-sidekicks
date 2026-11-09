/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The shell commands an agent started: one live list, and the acts stop, background, write and end input.

import { type SchemaCheck, deepEqual, ucs2length } from "../schema-check.js";
import type { ContentEncoding } from "./event/declared-variants.js";
import type { SourceEpoch, SourcePosition } from "./event/envelope.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type NullPayload, validateNullPayload } from "./method-descriptor.js";
import type { ToolCallId } from "./provider/tool-call.js";
import type { RunId } from "./run/id.js";
import type { SessionId } from "./session/id.js";

/** The longest command id the daemon accepts. */
export const COMMAND_ID_MAX_LEN = 256 as const;

/**
 * The daemon's id for one running command, opaque to every client.
 */
export type CommandId = string & { readonly __brand: "CommandId" };
/**
 * One frame of the running-commands subscription: the whole set in start order (an empty set
 * takes the list away), or a piece of one command's output as it printed.
 */
export type AgentCommandSubscribeFrame =
  | {
      kind: "commands";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The commands, in start order.
       */
      commands: RunningCommand[];
    }
  | {
      kind: "output";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The command.
       */
      commandId: CommandId;
      /**
       * The output as it printed.
       */
      data: string;
    };
/**
 * How a command ended: it finished, it failed or the provider stopped it, or the person stopped
 * it.
 */
export type CommandEnding = "finished" | "failed" | "endedByPerson";

/**
 * A git or ssh prompt open on a command, in the prompt's own words.
 */
export interface CommandPrompt {
  /**
   * The prompt's words.
   */
  text: string;
}
/**
 * One running command in a session, as every device draws its row.
 */
export interface RunningCommand {
  /**
   * The command.
   */
  commandId: CommandId;
  /**
   * The run that started it.
   */
  runId: RunId;
  /**
   * The command as the agent ran it.
   */
  name: string;
  /**
   * When it started.
   */
  startedAt: WireInstant;
  /**
   * True only while the provider holds the agent's turn on this command.
   */
  waitingInForeground: boolean;
  /**
   * True while the session's provider offers to move this waited-on command to the background,
   * its output held until the command ends; only then does the row carry `Move to background`.
   */
  canMoveToBackground: boolean;
  /**
   * True when the command can take typed input for its whole run, so its row has an input line.
   */
  acceptsInput: boolean;
  /**
   * True while the daemon reads from the system that the command is blocked reading its input.
   */
  waitingForInput: boolean;
  /**
   * True while the command's terminal has echo off, as at a password prompt, so the input line
   * masks what is typed; read from the terminal's settings, a Windows console's input mode, or
   * an open prompt's kind, whether or not the command is waiting.
   */
  echoOff: boolean;
  /**
   * A git or ssh prompt open on the command; absent otherwise.
   */
  prompt?: CommandPrompt;
}
/**
 * `agent.command.subscribe`: the session whose running commands the subscription follows.
 */
export interface AgentCommandSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * `agent.command.stop`: stops one running command. The agent receives one short message naming it,
 * never a bare failure; `Stop all commands` sends this once per running command.
 */
export interface AgentCommandStopRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The command.
   */
  commandId: CommandId;
}
/**
 * The provider acknowledged the command's stop.
 */
export interface AgentCommandStopResponse {
  /**
   * The command.
   */
  commandId: CommandId;
  /**
   * True once the provider acknowledged the stop.
   */
  stopped: true;
}
/**
 * `agent.command.background`: moves a command the agent is waiting on to the background, so the
 * agent's turn continues and the command's output streams into its row. Sent only for a command
 * whose entry reads `canMoveToBackground`; where no entry does, the control does not exist.
 */
export interface AgentCommandBackgroundRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The command.
   */
  commandId: CommandId;
}
/**
 * The command no longer holds the agent's turn.
 */
export interface AgentCommandBackgroundResponse {
  /**
   * The command.
   */
  commandId: CommandId;
  /**
   * Always false.
   */
  waitingInForeground: false;
}
/**
 * `agent.command.write`: typed input, `End input`, or both, for a command that takes input or has
 * a prompt open, whether or not it is waiting. `text` goes to the command or answers its prompt,
 * and `endOfInput` then ends its input as end of file does on a terminal, or answers an open
 * prompt with nothing. A write carries text, the end of input, or both.
 */
export interface AgentCommandWriteRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The command.
   */
  commandId: CommandId;
  /**
   * The typed text.
   */
  text?: string;
  /**
   * Whether the input ends after the text.
   */
  endOfInput?: boolean;
}
/**
 * The `agent.command.ended` payload: one command's ending, which takes the epoch stamp. A
 * provider's summary of a command it stopped itself is the event's body, only on a `failed`
 * ending.
 */
export interface AgentCommandEndedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The command.
   */
  commandId: CommandId;
  /**
   * The tool call that started the command, where the provider named one: the command's
   * turn is the turn that call opened in.
   */
  toolCallId?: ToolCallId;
  /**
   * How it ended.
   */
  ending: CommandEnding;
  /**
   * The process's exit code.
   */
  exitCode?: number;
  /**
   * How long it ran, in milliseconds.
   */
  durationMs: number;
  /**
   * The superseded execution epoch the row was delivered for; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The turn position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate295(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandBackgroundRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate295.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.commandId === undefined) && (missing0 = "commandId"))){validate295.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "commandId"))){validate295.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate295.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate295.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commandId !== undefined){let data1: any = data.commandId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate295.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate295.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate295.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate295.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate295.errors = vErrors;return errors === 0;}
// prettier-ignore
validate295.errors = null as any[] | null;
// prettier-ignore
validate295.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate296(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandBackgroundResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate296.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.commandId === undefined) && (missing0 = "commandId")) || ((data.waitingInForeground === undefined) && (missing0 = "waitingInForeground"))){validate296.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "commandId") || (key0 === "waitingInForeground"))){validate296.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commandId !== undefined){let data0: any = data.commandId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate296.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate296.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate296.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingInForeground !== undefined){let data1: any = data.waitingInForeground;const _errs6: any = errors;if(typeof data1 !== "boolean"){validate296.errors = [{instancePath:instancePath+"/waitingInForeground",schemaPath:"#/properties/waitingInForeground/type",keyword:"type",params:{type: "boolean"}}];return false;}if(false !== data1){validate296.errors = [{instancePath:instancePath+"/waitingInForeground",schemaPath:"#/properties/waitingInForeground/const",keyword:"const",params:{allowedValue: false}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate296.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate296.errors = vErrors;return errors === 0;}
// prettier-ignore
validate296.errors = null as any[] | null;
// prettier-ignore
validate296.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema559: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run."},"commandId":{"$ref":"#/$defs/CommandId","description":"The command."},"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The tool call that started the command, where the provider named one: the command's\nturn is the turn that call opened in."},"ending":{"$ref":"#/$defs/CommandEnding","description":"How it ended."},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"The process's exit code."},"durationMs":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How long it ran, in milliseconds."},"sourceEpoch":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourceEpoch","description":"The superseded execution epoch the row was delivered for; comes with `sourcePosition`."},"sourcePosition":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourcePosition","description":"The turn position the row occupies within its epoch; comes with `sourceEpoch`."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"sidekicks-contracts:event/declared-variants#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","runId","commandId","ending","durationMs"],"description":"The `agent.command.ended` payload: one command's ending, which takes the epoch stamp. A\nprovider's summary of a command it stopped itself is the event's body, only on a `failed`\nending.","dependentRequired":{"sourceEpoch":["sourcePosition","runId"],"sourcePosition":["sourceEpoch","runId"]},"if":{"properties":{"contentLength":true},"required":["contentLength"]},"then":{"properties":{"ending":{"const":"failed"}}}};
// prettier-ignore
const schema564: any = {"description":"How a command ended: it finished, it failed or the provider stopped it, or the person stopped\nit.","type":"string","enum":["finished","failed","endedByPerson"]};
// prettier-ignore
const schema569: any = {"description":"How a stored body's bytes are encoded when they are not its UTF-8 as it is: a body of 1 KiB or\nmore is compressed, and its payload names the encoding so a reader decodes it.","type":"string","enum":["zstd"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate297(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandEndedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate297.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.contentLength === undefined) && (missing0 = "contentLength")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}if(_valid0){const _errs3: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.ending !== undefined){if("failed" !== data.ending){validate297.errors = [{instancePath:instancePath+"/ending",schemaPath:"#/then/properties/ending/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}}}var _valid0: any = _errs3 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.ending = true;props0.contentLength = true;}}if(!valid0){const err1: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate297.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.sessionId === undefined) && (missing1 = "sessionId")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.commandId === undefined) && (missing1 = "commandId"))) || ((data.ending === undefined) && (missing1 = "ending"))) || ((data.durationMs === undefined) && (missing1 = "durationMs"))){validate297.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key0 in data){if(!(func2.call(schema559.properties, key0))){validate297.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs5 === errors){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate297.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate297.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){let data2: any = data.runId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate297.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate297.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.commandId !== undefined){let data3: any = data.commandId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(func1(data3) > 256){validate297.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate297.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate297.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.toolCallId !== undefined){let data4: any = data.toolCallId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data4 === "string"){if(func1(data4) > 256){validate297.errors = [{instancePath:instancePath+"/toolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate297.errors = [{instancePath:instancePath+"/toolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate297.errors = [{instancePath:instancePath+"/toolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate297.errors = [{instancePath:instancePath+"/toolCallId",schemaPath:"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.ending !== undefined){let data5: any = data.ending;const _errs22: any = errors;if(typeof data5 !== "string"){validate297.errors = [{instancePath:instancePath+"/ending",schemaPath:"#/$defs/CommandEnding/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data5 === "finished") || (data5 === "failed")) || (data5 === "endedByPerson"))){validate297.errors = [{instancePath:instancePath+"/ending",schemaPath:"#/$defs/CommandEnding/enum",keyword:"enum",params:{allowedValues: schema564.enum}}];return false;}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.exitCode !== undefined){let data6: any = data.exitCode;const _errs25: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate297.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs25){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate297.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < -9007199254740991 || isNaN(data6)){validate297.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid2: any = _errs25 === errors;}else {var valid2: any = true;}if(valid2){if(data.durationMs !== undefined){let data7: any = data.durationMs;const _errs27: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate297.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs27){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate297.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validate297.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs27 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourceEpoch !== undefined){let data8: any = data.sourceEpoch;const _errs29: any = errors;const _errs30: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate297.errors = [{instancePath:instancePath+"/sourceEpoch",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourceEpoch/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validate297.errors = [{instancePath:instancePath+"/sourceEpoch",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourceEpoch/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validate297.errors = [{instancePath:instancePath+"/sourceEpoch",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourceEpoch/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs29 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourcePosition !== undefined){let data9: any = data.sourcePosition;const _errs32: any = errors;const _errs33: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate297.errors = [{instancePath:instancePath+"/sourcePosition",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs33){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate297.errors = [{instancePath:instancePath+"/sourcePosition",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate297.errors = [{instancePath:instancePath+"/sourcePosition",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs32 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentLength !== undefined){let data10: any = data.contentLength;const _errs35: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate297.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs35){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate297.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate297.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs35 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentEncoding !== undefined){let data11: any = data.contentEncoding;const _errs37: any = errors;if(typeof data11 !== "string"){validate297.errors = [{instancePath:instancePath+"/contentEncoding",schemaPath:"sidekicks-contracts:event/declared-variants#/$defs/ContentEncoding/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data11 === "zstd")){validate297.errors = [{instancePath:instancePath+"/contentEncoding",schemaPath:"sidekicks-contracts:event/declared-variants#/$defs/ContentEncoding/enum",keyword:"enum",params:{allowedValues: schema569.enum}}];return false;}var valid2: any = _errs37 === errors;}else {var valid2: any = true;}if(valid2){let missing2: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing2 = "sourcePosition")) || ((data.runId === undefined) && (missing2 = "runId")))){validate297.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing2,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing2 = "sourceEpoch")) || ((data.runId === undefined) && (missing2 = "runId")))){validate297.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing2,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}}}}else {validate297.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate297.errors = vErrors;return errors === 0;}
// prettier-ignore
validate297.errors = null as any[] | null;
// prettier-ignore
validate297.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate300(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandStopRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate300.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.commandId === undefined) && (missing0 = "commandId"))){validate300.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "commandId"))){validate300.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate300.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate300.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commandId !== undefined){let data1: any = data.commandId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate300.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate300.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate300.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate300.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate300.errors = vErrors;return errors === 0;}
// prettier-ignore
validate300.errors = null as any[] | null;
// prettier-ignore
validate300.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate301(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandStopResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate301.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.commandId === undefined) && (missing0 = "commandId")) || ((data.stopped === undefined) && (missing0 = "stopped"))){validate301.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "commandId") || (key0 === "stopped"))){validate301.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commandId !== undefined){let data0: any = data.commandId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate301.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate301.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate301.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.stopped !== undefined){let data1: any = data.stopped;const _errs6: any = errors;if(typeof data1 !== "boolean"){validate301.errors = [{instancePath:instancePath+"/stopped",schemaPath:"#/properties/stopped/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validate301.errors = [{instancePath:instancePath+"/stopped",schemaPath:"#/properties/stopped/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate301.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate301.errors = vErrors;return errors === 0;}
// prettier-ignore
validate301.errors = null as any[] | null;
// prettier-ignore
validate301.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema577: any = {"type":"object","additionalProperties":false,"properties":{"commandId":{"$ref":"#/$defs/CommandId","description":"The command."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that started it."},"name":{"type":"string","minLength":1,"description":"The command as the agent ran it."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"waitingInForeground":{"type":"boolean","description":"True only while the provider holds the agent's turn on this command."},"canMoveToBackground":{"type":"boolean","description":"True while the session's provider offers to move this waited-on command to the background,\nits output held until the command ends; only then does the row carry `Move to background`."},"acceptsInput":{"type":"boolean","description":"True when the command can take typed input for its whole run, so its row has an input line."},"waitingForInput":{"type":"boolean","description":"True while the daemon reads from the system that the command is blocked reading its input."},"echoOff":{"type":"boolean","description":"True while the command's terminal has echo off, as at a password prompt, so the input line\nmasks what is typed; read from the terminal's settings, a Windows console's input mode, or\nan open prompt's kind, whether or not the command is waiting."},"prompt":{"$ref":"#/$defs/CommandPrompt","description":"A git or ssh prompt open on the command; absent otherwise."}},"required":["commandId","runId","name","startedAt","waitingInForeground","canMoveToBackground","acceptsInput","waitingForInput","echoOff"],"description":"One running command in a session, as every device draws its row."};
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate303(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate303.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.commandId === undefined) && (missing0 = "commandId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.startedAt === undefined) && (missing0 = "startedAt"))) || ((data.waitingInForeground === undefined) && (missing0 = "waitingInForeground"))) || ((data.canMoveToBackground === undefined) && (missing0 = "canMoveToBackground"))) || ((data.acceptsInput === undefined) && (missing0 = "acceptsInput"))) || ((data.waitingForInput === undefined) && (missing0 = "waitingForInput"))) || ((data.echoOff === undefined) && (missing0 = "echoOff"))){validate303.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema577.properties, key0))){validate303.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commandId !== undefined){let data0: any = data.commandId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate303.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate303.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate303.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate303.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate303.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){validate303.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate303.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedAt !== undefined){let data3: any = data.startedAt;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate303.errors = [{instancePath:instancePath+"/startedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate303.errors = [{instancePath:instancePath+"/startedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingInForeground !== undefined){const _errs15: any = errors;if(typeof data.waitingInForeground !== "boolean"){validate303.errors = [{instancePath:instancePath+"/waitingInForeground",schemaPath:"#/properties/waitingInForeground/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.canMoveToBackground !== undefined){const _errs17: any = errors;if(typeof data.canMoveToBackground !== "boolean"){validate303.errors = [{instancePath:instancePath+"/canMoveToBackground",schemaPath:"#/properties/canMoveToBackground/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.acceptsInput !== undefined){const _errs19: any = errors;if(typeof data.acceptsInput !== "boolean"){validate303.errors = [{instancePath:instancePath+"/acceptsInput",schemaPath:"#/properties/acceptsInput/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingForInput !== undefined){const _errs21: any = errors;if(typeof data.waitingForInput !== "boolean"){validate303.errors = [{instancePath:instancePath+"/waitingForInput",schemaPath:"#/properties/waitingForInput/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.echoOff !== undefined){const _errs23: any = errors;if(typeof data.echoOff !== "boolean"){validate303.errors = [{instancePath:instancePath+"/echoOff",schemaPath:"#/properties/echoOff/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.prompt !== undefined){let data9: any = data.prompt;const _errs25: any = errors;const _errs26: any = errors;if(errors === _errs26){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){let missing1: any;if((data9.text === undefined) && (missing1 = "text")){validate303.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/$defs/CommandPrompt/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs28: any = errors;for(const key1 in data9){if(!(key1 === "text")){validate303.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/$defs/CommandPrompt/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs28 === errors){if(data9.text !== undefined){let data10: any = data9.text;const _errs29: any = errors;if(errors === _errs29){if(typeof data10 === "string"){if(func1(data10) < 1){validate303.errors = [{instancePath:instancePath+"/prompt/text",schemaPath:"#/$defs/CommandPrompt/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate303.errors = [{instancePath:instancePath+"/prompt/text",schemaPath:"#/$defs/CommandPrompt/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate303.errors = [{instancePath:instancePath+"/prompt",schemaPath:"#/$defs/CommandPrompt/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs25 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validate303.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate303.errors = vErrors;return errors === 0;}
// prettier-ignore
validate303.errors = null as any[] | null;
// prettier-ignore
validate303.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
function validate302(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandSubscribeFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate302.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate302.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "commands"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.commands === undefined) && (missing0 = "commands"))){validate302.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "sessionId")) || (key1 === "commands"))){validate302.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate302.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("commands" !== data0){validate302.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "commands"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate302.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate302.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.commands !== undefined){let data2: any = data.commands;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data2)){var valid4: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs14: any = errors;if(!(validate303.call(this, data2[i0], {instancePath:instancePath+"/commands/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate303.errors : vErrors.concat(validate303.errors);errors = vErrors.length;}var valid4: any = _errs14 === errors;if(!valid4){break;}}if(valid4){let i1: any = data2.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data2[i1], data2[j0])){validate302.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/oneOf/0/properties/commands/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}else {validate302.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/oneOf/0/properties/commands/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}else {validate302.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "output"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.commandId === undefined) && (missing1 = "commandId"))) || ((data.data === undefined) && (missing1 = "data"))){validate302.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs17: any = errors;for(const key2 in data){if(!((((key2 === "kind") || (key2 === "sessionId")) || (key2 === "commandId")) || (key2 === "data"))){validate302.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs17 === errors){if(data.kind !== undefined){let data4: any = data.kind;const _errs18: any = errors;if(typeof data4 !== "string"){validate302.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("output" !== data4){validate302.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "output"}}];return false;}var valid7: any = _errs18 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data5: any = data.sessionId;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate302.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate302.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs20 === errors;}else {var valid7: any = true;}if(valid7){if(data.commandId !== undefined){let data6: any = data.commandId;const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(typeof data6 === "string"){if(func1(data6) > 256){validate302.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validate302.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate302.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs24 === errors;}else {var valid7: any = true;}if(valid7){if(data.data !== undefined){const _errs28: any = errors;if(typeof data.data !== "string"){validate302.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/type",keyword:"type",params:{type: "string"}}];return false;}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}}}}}}}else {validate302.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate302.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate302.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate302.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate302.errors = vErrors;return errors === 0;}
// prettier-ignore
validate302.errors = null as any[] | null;
// prettier-ignore
validate302.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate305(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate305.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate305.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate305.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate305.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate305.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate305.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate305.errors = vErrors;return errors === 0;}
// prettier-ignore
validate305.errors = null as any[] | null;
// prettier-ignore
validate305.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate306(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate306.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = false;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.text === undefined) && (missing0 = "text")){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = {};props0.text = true;}const _errs4: any = errors;if(errors === _errs4){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.endOfInput === undefined) && (missing1 = "endOfInput")){const err2: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(data.endOfInput !== undefined){if(true !== data.endOfInput){const err3: any = {instancePath:instancePath+"/endOfInput",schemaPath:"#/anyOf/1/properties/endOfInput/const",keyword:"const",params:{allowedValue: true}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = props0 || {};props0.endOfInput = true;}}if(!valid0){const err5: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate306.errors = vErrors;return false;}else {errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.sessionId === undefined) && (missing2 = "sessionId")) || ((data.commandId === undefined) && (missing2 = "commandId"))){validate306.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs7: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "commandId")) || (key0 === "text")) || (key0 === "endOfInput"))){validate306.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs7 === errors){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate306.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate306.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.commandId !== undefined){let data2: any = data.commandId;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data2 === "string"){if(func1(data2) > 256){validate306.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate306.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate306.errors = [{instancePath:instancePath+"/commandId",schemaPath:"#/$defs/CommandId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.text !== undefined){let data3: any = data.text;const _errs16: any = errors;if(errors === _errs16){if(typeof data3 === "string"){if(func1(data3) < 1){validate306.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate306.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.endOfInput !== undefined){const _errs18: any = errors;if(typeof data.endOfInput !== "boolean"){validate306.errors = [{instancePath:instancePath+"/endOfInput",schemaPath:"#/properties/endOfInput/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}}}}}}}else {validate306.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate306.errors = vErrors;return errors === 0;}
// prettier-ignore
validate306.errors = null as any[] | null;
// prettier-ignore
validate306.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate307(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CommandId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate307.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate307.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate307.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate307.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate307.errors = vErrors;return errors === 0;}
// prettier-ignore
validate307.errors = null as any[] | null;
// prettier-ignore
validate307.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandBackgroundRequest}. */
export const validateAgentCommandBackgroundRequest: SchemaCheck<AgentCommandBackgroundRequest> =
  validate295;
/** Checks that a value is a {@link AgentCommandBackgroundResponse}. */
export const validateAgentCommandBackgroundResponse: SchemaCheck<AgentCommandBackgroundResponse> =
  validate296;
/** Checks that a value is a {@link AgentCommandEndedPayload}. */
export const validateAgentCommandEndedPayload: SchemaCheck<AgentCommandEndedPayload> = validate297;
/** Checks that a value is a {@link AgentCommandStopRequest}. */
export const validateAgentCommandStopRequest: SchemaCheck<AgentCommandStopRequest> = validate300;
/** Checks that a value is a {@link AgentCommandStopResponse}. */
export const validateAgentCommandStopResponse: SchemaCheck<AgentCommandStopResponse> = validate301;
/** Checks that a value is a {@link AgentCommandSubscribeFrame}. */
export const validateAgentCommandSubscribeFrame: SchemaCheck<AgentCommandSubscribeFrame> =
  validate302;
/** Checks that a value is a {@link AgentCommandSubscribeRequest}. */
export const validateAgentCommandSubscribeRequest: SchemaCheck<AgentCommandSubscribeRequest> =
  validate305;
/** Checks that a value is a {@link AgentCommandWriteRequest}. */
export const validateAgentCommandWriteRequest: SchemaCheck<AgentCommandWriteRequest> = validate306;
/** Checks that a value is a {@link CommandId}. */
export const validateCommandId: SchemaCheck<CommandId> = validate307;

/** The methods of {@link COMMAND_METHOD_DESCRIPTORS}, each with its checks. */
export interface CommandMethodDescriptors {
  readonly "agent.command.subscribe": {
    readonly method: "agent.command.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AgentCommandSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<AgentCommandSubscribeFrame>;
  };
  readonly "agent.command.stop": {
    readonly method: "agent.command.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentCommandStopRequest>;
    readonly responseCheck: SchemaCheck<AgentCommandStopResponse>;
  };
  readonly "agent.command.background": {
    readonly method: "agent.command.background";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentCommandBackgroundRequest>;
    readonly responseCheck: SchemaCheck<AgentCommandBackgroundResponse>;
  };
  readonly "agent.command.write": {
    readonly method: "agent.command.write";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AgentCommandWriteRequest>;
    readonly responseCheck: SchemaCheck<NullPayload>;
  };
}
/** The `agent.command.*` methods. */
export const COMMAND_METHOD_DESCRIPTORS: CommandMethodDescriptors = Object.freeze({
  "agent.command.subscribe": Object.freeze({
    method: "agent.command.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAgentCommandSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateAgentCommandSubscribeFrame,
  }),
  "agent.command.stop": Object.freeze({
    method: "agent.command.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentCommandStopRequest,
    responseCheck: validateAgentCommandStopResponse,
  }),
  "agent.command.background": Object.freeze({
    method: "agent.command.background",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentCommandBackgroundRequest,
    responseCheck: validateAgentCommandBackgroundResponse,
  }),
  "agent.command.write": Object.freeze({
    method: "agent.command.write",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAgentCommandWriteRequest,
    responseCheck: validateNullPayload,
  }),
});
