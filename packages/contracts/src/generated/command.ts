// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The shell commands an agent started: one live list, and the acts stop, background, write and end input.

import type { ContentEncoding } from "./event/declared-variants.js";
import type { SourceEpoch, SourcePosition } from "./event/envelope.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { NullPayload } from "./method-descriptor.js";
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

export {
  validateAgentCommandEndedPayload,
  validateCommandEnding,
  validateCommandId,
} from "./checks/command.js";

/** The methods of {@link COMMAND_METHOD_DESCRIPTORS}, each with its kind. */
export interface CommandMethodDescriptors {
  readonly "agent.command.subscribe": {
    readonly method: "agent.command.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "agent.command.stop": {
    readonly method: "agent.command.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.command.background": {
    readonly method: "agent.command.background";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.command.write": {
    readonly method: "agent.command.write";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link COMMAND_METHOD_DESCRIPTORS}. */
export interface CommandMethodTypes {
  readonly "agent.command.subscribe": {
    readonly params: AgentCommandSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: AgentCommandSubscribeFrame;
  };
  readonly "agent.command.stop": {
    readonly params: AgentCommandStopRequest;
    readonly result: AgentCommandStopResponse;
  };
  readonly "agent.command.background": {
    readonly params: AgentCommandBackgroundRequest;
    readonly result: AgentCommandBackgroundResponse;
  };
  readonly "agent.command.write": {
    readonly params: AgentCommandWriteRequest;
    readonly result: NullPayload;
  };
}
/** The `agent.command.*` methods. */
export const COMMAND_METHOD_DESCRIPTORS: CommandMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "agent.command.subscribe": /* @__PURE__ */ Object.freeze({
    method: "agent.command.subscribe",
    procedureType: "subscription",
    mutating: false,
  }),
  "agent.command.stop": /* @__PURE__ */ Object.freeze({
    method: "agent.command.stop",
    procedureType: "mutation",
    mutating: true,
  }),
  "agent.command.background": /* @__PURE__ */ Object.freeze({
    method: "agent.command.background",
    procedureType: "mutation",
    mutating: true,
  }),
  "agent.command.write": /* @__PURE__ */ Object.freeze({
    method: "agent.command.write",
    procedureType: "mutation",
    mutating: true,
  }),
});
