// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The shell commands an agent started: one live list, and the acts stop, background, write and end input.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  repeatsItemKey,
  ucs2length,
} from "../schema-check.js";
import { type ContentEncoding, validateContentEncoding } from "./event/declared-variants.js";
import {
  type SourceEpoch,
  type SourcePosition,
  validateSourceEpoch,
  validateSourcePosition,
} from "./event/envelope.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type NullPayload, validateNullPayload } from "./method-descriptor.js";
import { type ToolCallId, validateToolCallId } from "./provider/tool-call.js";
import { type RunId, validateRunId } from "./run/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";

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
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
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
const func1 = ucs2length;
/** Checks that a value is a {@link CommandId}. */
// prettier-ignore
export const validateCommandId: CompiledSchemaCheck<CommandId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CommandId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCommandId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateCommandId.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateCommandId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateCommandId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateCommandId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCommandId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link CommandPrompt}. */
// prettier-ignore
export const validateCommandPrompt: CompiledSchemaCheck<CommandPrompt> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CommandPrompt {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCommandPrompt.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.text === undefined) && (missing0 = "text")){validateCommandPrompt.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "text")){validateCommandPrompt.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.text !== undefined){let data0: any = data.text;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateCommandPrompt.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateCommandPrompt.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateCommandPrompt.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateCommandPrompt.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCommandPrompt.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema218: any = {"type":"object","additionalProperties":false,"properties":{"commandId":{"$ref":"#/$defs/CommandId","description":"The command."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that started it."},"name":{"type":"string","minLength":1,"description":"The command as the agent ran it."},"startedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it started."},"waitingInForeground":{"type":"boolean","description":"True only while the provider holds the agent's turn on this command."},"canMoveToBackground":{"type":"boolean","description":"True while the session's provider offers to move this waited-on command to the background,\nits output held until the command ends; only then does the row carry `Move to background`."},"acceptsInput":{"type":"boolean","description":"True when the command can take typed input for its whole run, so its row has an input line."},"waitingForInput":{"type":"boolean","description":"True while the daemon reads from the system that the command is blocked reading its input."},"echoOff":{"type":"boolean","description":"True while the command's terminal has echo off, as at a password prompt, so the input line\nmasks what is typed; read from the terminal's settings, a Windows console's input mode, or\nan open prompt's kind, whether or not the command is waiting."},"prompt":{"$ref":"#/$defs/CommandPrompt","description":"A git or ssh prompt open on the command; absent otherwise."}},"required":["commandId","runId","name","startedAt","waitingInForeground","canMoveToBackground","acceptsInput","waitingForInput","echoOff"],"description":"One running command in a session, as every device draws its row."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link RunningCommand}. */
// prettier-ignore
export const validateRunningCommand: CompiledSchemaCheck<RunningCommand> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RunningCommand {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRunningCommand.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.commandId === undefined) && (missing0 = "commandId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.startedAt === undefined) && (missing0 = "startedAt"))) || ((data.waitingInForeground === undefined) && (missing0 = "waitingInForeground"))) || ((data.canMoveToBackground === undefined) && (missing0 = "canMoveToBackground"))) || ((data.acceptsInput === undefined) && (missing0 = "acceptsInput"))) || ((data.waitingForInput === undefined) && (missing0 = "waitingForInput"))) || ((data.echoOff === undefined) && (missing0 = "echoOff"))){validateRunningCommand.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema218.properties, key0))){validateRunningCommand.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commandId !== undefined){const _errs2: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) < 1){validateRunningCommand.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateRunningCommand.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingInForeground !== undefined){const _errs7: any = errors;if(typeof data.waitingInForeground !== "boolean"){validateRunningCommand.errors = [{instancePath:instancePath+"/waitingInForeground",schemaPath:"#/properties/waitingInForeground/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.canMoveToBackground !== undefined){const _errs9: any = errors;if(typeof data.canMoveToBackground !== "boolean"){validateRunningCommand.errors = [{instancePath:instancePath+"/canMoveToBackground",schemaPath:"#/properties/canMoveToBackground/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.acceptsInput !== undefined){const _errs11: any = errors;if(typeof data.acceptsInput !== "boolean"){validateRunningCommand.errors = [{instancePath:instancePath+"/acceptsInput",schemaPath:"#/properties/acceptsInput/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingForInput !== undefined){const _errs13: any = errors;if(typeof data.waitingForInput !== "boolean"){validateRunningCommand.errors = [{instancePath:instancePath+"/waitingForInput",schemaPath:"#/properties/waitingForInput/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.echoOff !== undefined){const _errs15: any = errors;if(typeof data.echoOff !== "boolean"){validateRunningCommand.errors = [{instancePath:instancePath+"/echoOff",schemaPath:"#/properties/echoOff/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.prompt !== undefined){const _errs17: any = errors;if(!(validateCommandPrompt.call(this, data.prompt, {instancePath:instancePath+"/prompt",parentData:data,parentDataProperty:"prompt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandPrompt.errors : vErrors.concat(validateCommandPrompt.errors);errors = vErrors.length;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validateRunningCommand.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateRunningCommand.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRunningCommand.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandSubscribeRequest}. */
// prettier-ignore
export const validateAgentCommandSubscribeRequest: CompiledSchemaCheck<AgentCommandSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateAgentCommandSubscribeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateAgentCommandSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateAgentCommandSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link AgentCommandSubscribeFrame}. */
// prettier-ignore
export const validateAgentCommandSubscribeFrame: CompiledSchemaCheck<AgentCommandSubscribeFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandSubscribeFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandSubscribeFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "commands"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.commands === undefined) && (missing0 = "commands"))){validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "kind") || (key0 === "sessionId")) || (key0 === "commands"))){validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("commands" !== data0){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "commands"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.commands !== undefined){let data2: any = data.commands;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data2)){var valid3: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs10: any = errors;if(!(validateRunningCommand.call(this, data2[i0], {instancePath:instancePath+"/commands/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunningCommand.errors : vErrors.concat(validateRunningCommand.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;if(!valid3){break;}}if(valid3){let valid4: any;let i1: any = data2.length;let j0: any;valid4 = true;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data2[i1], data2[j0])){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/oneOf/0/properties/commands/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;valid4 = false;break outer0;}}}}if(valid4){if(repeatsItemKey(data2, "commandId")){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/oneOf/0/properties/commands/uniqueItemKey",keyword:"uniqueItemKey",params:{}}];return false;}}}}else {validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/commands",schemaPath:"#/oneOf/0/properties/commands/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}}else {validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "output"){const _errs11: any = errors;if(errors === _errs11){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.commandId === undefined) && (missing1 = "commandId"))) || ((data.data === undefined) && (missing1 = "data"))){validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "sessionId")) || (key1 === "commandId")) || (key1 === "data"))){validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs13 === errors){if(data.kind !== undefined){let data4: any = data.kind;const _errs14: any = errors;if(typeof data4 !== "string"){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("output" !== data4){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "output"}}];return false;}var valid6: any = _errs14 === errors;}else {var valid6: any = true;}if(valid6){if(data.sessionId !== undefined){const _errs16: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid6: any = _errs16 === errors;}else {var valid6: any = true;}if(valid6){if(data.commandId !== undefined){const _errs17: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data.data !== undefined){const _errs18: any = errors;if(typeof data.data !== "string"){validateAgentCommandSubscribeFrame.errors = [{instancePath:instancePath+"/data",schemaPath:"#/oneOf/1/properties/data/type",keyword:"type",params:{type: "string"}}];return false;}var valid6: any = _errs18 === errors;}else {var valid6: any = true;}}}}}}}else {validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs11 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateAgentCommandSubscribeFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandSubscribeFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandSubscribeFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandStopRequest}. */
// prettier-ignore
export const validateAgentCommandStopRequest: CompiledSchemaCheck<AgentCommandStopRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandStopRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandStopRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.commandId === undefined) && (missing0 = "commandId"))){validateAgentCommandStopRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "commandId"))){validateAgentCommandStopRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commandId !== undefined){const _errs3: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentCommandStopRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandStopRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandStopRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandStopResponse}. */
// prettier-ignore
export const validateAgentCommandStopResponse: CompiledSchemaCheck<AgentCommandStopResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandStopResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandStopResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.commandId === undefined) && (missing0 = "commandId")) || ((data.stopped === undefined) && (missing0 = "stopped"))){validateAgentCommandStopResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "commandId") || (key0 === "stopped"))){validateAgentCommandStopResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commandId !== undefined){const _errs2: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.stopped !== undefined){let data1: any = data.stopped;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateAgentCommandStopResponse.errors = [{instancePath:instancePath+"/stopped",schemaPath:"#/properties/stopped/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateAgentCommandStopResponse.errors = [{instancePath:instancePath+"/stopped",schemaPath:"#/properties/stopped/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentCommandStopResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandStopResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandStopResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandBackgroundRequest}. */
// prettier-ignore
export const validateAgentCommandBackgroundRequest: CompiledSchemaCheck<AgentCommandBackgroundRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandBackgroundRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandBackgroundRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.commandId === undefined) && (missing0 = "commandId"))){validateAgentCommandBackgroundRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "commandId"))){validateAgentCommandBackgroundRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.commandId !== undefined){const _errs3: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentCommandBackgroundRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandBackgroundRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandBackgroundRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandBackgroundResponse}. */
// prettier-ignore
export const validateAgentCommandBackgroundResponse: CompiledSchemaCheck<AgentCommandBackgroundResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandBackgroundResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandBackgroundResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.commandId === undefined) && (missing0 = "commandId")) || ((data.waitingInForeground === undefined) && (missing0 = "waitingInForeground"))){validateAgentCommandBackgroundResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "commandId") || (key0 === "waitingInForeground"))){validateAgentCommandBackgroundResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.commandId !== undefined){const _errs2: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitingInForeground !== undefined){let data1: any = data.waitingInForeground;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateAgentCommandBackgroundResponse.errors = [{instancePath:instancePath+"/waitingInForeground",schemaPath:"#/properties/waitingInForeground/type",keyword:"type",params:{type: "boolean"}}];return false;}if(false !== data1){validateAgentCommandBackgroundResponse.errors = [{instancePath:instancePath+"/waitingInForeground",schemaPath:"#/properties/waitingInForeground/const",keyword:"const",params:{allowedValue: false}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAgentCommandBackgroundResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandBackgroundResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandBackgroundResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentCommandWriteRequest}. */
// prettier-ignore
export const validateAgentCommandWriteRequest: CompiledSchemaCheck<AgentCommandWriteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandWriteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = false;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.text === undefined) && (missing0 = "text")){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = {};props0.text = true;}const _errs4: any = errors;if(errors === _errs4){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.endOfInput === undefined) && (missing1 = "endOfInput")){const err2: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(data.endOfInput !== undefined){if(true !== data.endOfInput){const err3: any = {instancePath:instancePath+"/endOfInput",schemaPath:"#/anyOf/1/properties/endOfInput/const",keyword:"const",params:{allowedValue: true}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs4 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = props0 || {};props0.endOfInput = true;}}if(!valid0){const err5: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validateAgentCommandWriteRequest.errors = vErrors;return false;}else {errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.sessionId === undefined) && (missing2 = "sessionId")) || ((data.commandId === undefined) && (missing2 = "commandId"))){validateAgentCommandWriteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs7: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "commandId")) || (key0 === "text")) || (key0 === "endOfInput"))){validateAgentCommandWriteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs7 === errors){if(data.sessionId !== undefined){const _errs8: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.commandId !== undefined){const _errs9: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.text !== undefined){let data3: any = data.text;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validateAgentCommandWriteRequest.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateAgentCommandWriteRequest.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.endOfInput !== undefined){const _errs12: any = errors;if(typeof data.endOfInput !== "boolean"){validateAgentCommandWriteRequest.errors = [{instancePath:instancePath+"/endOfInput",schemaPath:"#/properties/endOfInput/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}}else {validateAgentCommandWriteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandWriteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandWriteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema211: any = {"description":"How a command ended: it finished, it failed or the provider stopped it, or the person stopped\nit.","type":"string","enum":["finished","failed","endedByPerson"]};
/** Checks that a value is a {@link CommandEnding}. */
// prettier-ignore
export const validateCommandEnding: CompiledSchemaCheck<CommandEnding> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is CommandEnding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateCommandEnding.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateCommandEnding.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "finished") || (data === "failed")) || (data === "endedByPerson"))){validateCommandEnding.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema211.enum}}];return false;}validateCommandEnding.errors = vErrors;return errors === 0;};
// prettier-ignore
validateCommandEnding.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema210: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run."},"commandId":{"$ref":"#/$defs/CommandId","description":"The command."},"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The tool call that started the command, where the provider named one: the command's\nturn is the turn that call opened in."},"ending":{"$ref":"#/$defs/CommandEnding","description":"How it ended."},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"The process's exit code."},"durationMs":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How long it ran, in milliseconds."},"sourceEpoch":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourceEpoch","description":"The superseded execution epoch the row was delivered for; comes with `sourcePosition`."},"sourcePosition":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourcePosition","description":"The run position the row occupies within its epoch; comes with `sourceEpoch`."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"sidekicks-contracts:event/declared-variants#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","runId","commandId","ending","durationMs"],"description":"The `agent.command.ended` payload: one command's ending, which takes the epoch stamp. A\nprovider's summary of a command it stopped itself is the event's body, only on a `failed`\nending.","dependentRequired":{"sourceEpoch":["sourcePosition","runId"],"sourcePosition":["sourceEpoch","runId"]},"if":{"properties":{"contentLength":true},"required":["contentLength"]},"then":{"properties":{"ending":{"const":"failed"}}}};
/** Checks that a value is a {@link AgentCommandEndedPayload}. */
// prettier-ignore
export const validateAgentCommandEndedPayload: CompiledSchemaCheck<AgentCommandEndedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentCommandEndedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentCommandEndedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.contentLength === undefined) && (missing0 = "contentLength")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}if(_valid0){const _errs3: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.ending !== undefined){if("failed" !== data.ending){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/ending",schemaPath:"#/then/properties/ending/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}}}var _valid0: any = _errs3 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.ending = true;props0.contentLength = true;}}if(!valid0){const err1: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateAgentCommandEndedPayload.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((data.sessionId === undefined) && (missing1 = "sessionId")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.commandId === undefined) && (missing1 = "commandId"))) || ((data.ending === undefined) && (missing1 = "ending"))) || ((data.durationMs === undefined) && (missing1 = "durationMs"))){validateAgentCommandEndedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs5: any = errors;for(const key0 in data){if(!(func2.call(schema210.properties, key0))){validateAgentCommandEndedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs5 === errors){if(data.sessionId !== undefined){const _errs6: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){const _errs7: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.commandId !== undefined){const _errs8: any = errors;if(!(validateCommandId.call(this, data.commandId, {instancePath:instancePath+"/commandId",parentData:data,parentDataProperty:"commandId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandId.errors : vErrors.concat(validateCommandId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.toolCallId !== undefined){const _errs9: any = errors;if(!(validateToolCallId.call(this, data.toolCallId, {instancePath:instancePath+"/toolCallId",parentData:data,parentDataProperty:"toolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.ending !== undefined){const _errs10: any = errors;if(!(validateCommandEnding.call(this, data.ending, {instancePath:instancePath+"/ending",parentData:data,parentDataProperty:"ending",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateCommandEnding.errors : vErrors.concat(validateCommandEnding.errors);errors = vErrors.length;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.exitCode !== undefined){let data6: any = data.exitCode;const _errs11: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/properties/exitCode/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/properties/exitCode/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < -9007199254740991 || isNaN(data6)){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/exitCode",schemaPath:"#/properties/exitCode/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.durationMs !== undefined){let data7: any = data.durationMs;const _errs13: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourceEpoch !== undefined){const _errs15: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourcePosition !== undefined){const _errs16: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentLength !== undefined){let data10: any = data.contentLength;const _errs17: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validateAgentCommandEndedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentEncoding !== undefined){const _errs19: any = errors;if(!(validateContentEncoding.call(this, data.contentEncoding, {instancePath:instancePath+"/contentEncoding",parentData:data,parentDataProperty:"contentEncoding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateContentEncoding.errors : vErrors.concat(validateContentEncoding.errors);errors = vErrors.length;}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}if(valid2){let missing2: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing2 = "sourcePosition")) || ((data.runId === undefined) && (missing2 = "runId")))){validateAgentCommandEndedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing2,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing2 = "sourceEpoch")) || ((data.runId === undefined) && (missing2 = "runId")))){validateAgentCommandEndedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing2,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}}}}else {validateAgentCommandEndedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAgentCommandEndedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAgentCommandEndedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
