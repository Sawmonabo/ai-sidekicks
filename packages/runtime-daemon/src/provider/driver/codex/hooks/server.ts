// The daemon's end of the Codex hooks: a local socket the hook program hands each pre-tool and
// post-tool input to, answered at one dispatch point where each answerer in turn may answer or let
// the next one. A held pre-tool call is denied shortly before Codex's own hook deadline, since a
// hook that times out lets the call run.

import * as net from "node:net";

import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { CODEX_MAX_RECEIVED_MESSAGE_BYTES } from "../server-requests.js";
import { CODEX_HOOK_TIMEOUT_SECONDS, type CodexDaemonHooks } from "../service/command-line.js";
import { normalizeProviderFailureDetail } from "../session/errors.js";
import { CODEX_DEFAULT_REQUEST_TIMEOUT_MS } from "../transport/connection.js";
import { CODEX_HOOK_PROGRAM_PATH } from "./program-path.js";
import {
  type CodexDiagnosticSink,
  type CodexScheduleTimeout,
  reportDiagnosticFromDetachedFrame,
} from "../transport/diagnostics.js";

/** The hook events the daemon registers. */
type CodexHookEventName = "PreToolUse" | "PostToolUse";

/** One hook input as Codex hands it to the hook program, read at the socket. */
export interface CodexHookInput {
  readonly eventName: CodexHookEventName;
  /** The conversation the call runs in: the session's own thread or a helper's. */
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly toolName: string | undefined;
  readonly toolUseId: string | undefined;
  readonly toolInput: unknown;
}

/**
 * What the hook program prints: nothing, a pre-tool denial whose reason the model reads, or words
 * a post-tool hook adds to the model's context.
 */
export type CodexHookAnswer =
  | { readonly decision: "pass" }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "context"; readonly additionalContext: string };

/**
 * One answerer at the dispatch point; `undefined` lets the next one answer. `signal` aborts when
 * the call no longer waits, because its deadline came or Codex ended the hook.
 */
export type CodexHookAnswerer = (
  input: CodexHookInput,
  signal: AbortSignal,
) => Promise<CodexHookAnswer | undefined> | CodexHookAnswer | undefined;

/** The sentence a held call is denied with at its deadline; the model reads it. */
export const CODEX_HOOK_DEADLINE_REASON = "No answer before the deadline; the command was not run.";

// Said of a hook line that is not JSON, in place of the parser's message, which quotes the line and
// so the tool's input.
const CODEX_HOOK_INPUT_UNREADABLE = "The hook program sent a line that is not JSON.";

// Said of a hook input past the message bound, which is not read.
const CODEX_HOOK_INPUT_TOO_LARGE = "The hook program sent an input too large to read.";

// Said of a hook input not ended within the request deadline.
const CODEX_HOOK_INPUT_TOO_SLOW = "The hook program did not finish sending its input in time.";

// How long before Codex's hook deadline a held call is denied, leaving the answer time to reach
// Codex. No source gives a figure; any few seconds covers a local socket round trip.
const CODEX_HOOK_DEADLINE_MARGIN_MS = 5_000;

// The longest delay one timer takes; a longer wait is chained across several.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const PASS: CodexHookAnswer = { decision: "pass" };

/** What the hook server needs. */
export interface CodexHookServerDependencies {
  /** The address the server listens on and the hook programs connect to. */
  readonly endpoint: string;
  /**
   * How the system readies the address and quotes the hook's command line, which Codex runs with
   * the system's command shell.
   */
  readonly operatingSystem: Pick<
    ProviderOperatingSystem,
    "prepareLocalSocketEndpoint" | "quoteShellWord"
  >;
  /** Answer in order; the first that answers wins, and a call none answers passes. */
  readonly answerers: readonly CodexHookAnswerer[];
  readonly reportDiagnostic: CodexDiagnosticSink;
  readonly scheduleTimeout: CodexScheduleTimeout;
  readonly now: () => number;
}

/** Serves the daemon's hook programs on one local socket for every service of one driver. */
export class CodexHookServer implements CodexDaemonHooks {
  readonly commands: CodexDaemonHooks["commands"];
  readonly #dependencies: CodexHookServerDependencies;
  readonly #connections = new Set<net.Socket>();
  #listening: Promise<void> | undefined;
  #server: net.Server | undefined;
  #closing: Promise<void> | undefined;

  constructor(dependencies: CodexHookServerDependencies) {
    this.#dependencies = dependencies;
    // One command per event, so Codex lists and trusts each, and the program knows its event
    // even when the input cannot be read.
    this.commands = {
      preToolUse: composeCodexHookCommand(dependencies, "PreToolUse"),
      postToolUse: composeCodexHookCommand(dependencies, "PostToolUse"),
    };
  }

  /** Starts listening, once; what a stopped daemon left at the address is removed first. */
  async listen(): Promise<void> {
    this.#listening ??= this.#listen();
    await this.#listening;
  }

  /**
   * Stops listening as the daemon stops: every hook still waiting is cut off, which Codex reads as
   * the hook failing, and the address is let go. Idempotent.
   */
  async close(): Promise<void> {
    this.#closing ??= this.#close();
    await this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#listening !== undefined) {
      try {
        await this.#listening;
      } catch {
        // A listen that failed opened nothing to close; its own caller received the failure.
        return;
      }
    }
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    for (const socket of this.#connections) {
      socket.destroy();
    }
    // Closing a server on a socket path also removes the path; a named pipe ends with it.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  async #listen(): Promise<void> {
    await this.#dependencies.operatingSystem.prepareLocalSocketEndpoint(
      this.#dependencies.endpoint,
    );
    const server = net.createServer((socket) => {
      this.#serve(socket);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#dependencies.endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // The daemon's own servers keep it running; this one never does on its own.
    server.unref();
  }

  // One connection carries one hook input line and gets one answer line back. A line past the
  // message bound, or one not ended in time, is denied unread.
  #serve(socket: net.Socket): void {
    const abort = new AbortController();
    this.#connections.add(socket);
    let received = "";
    let receivedBytes = 0;
    const refuse = (reason: string): void => {
      socket.removeAllListeners("data");
      this.#reportDetail(reason);
      socket.end(`${JSON.stringify({ decision: "deny", reason })}\n`);
    };
    const cancelIdle = this.#dependencies.scheduleTimeout(() => {
      refuse(CODEX_HOOK_INPUT_TOO_SLOW);
    }, CODEX_DEFAULT_REQUEST_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      receivedBytes += Buffer.byteLength(chunk);
      const end = received.indexOf("\n");
      if (end < 0) {
        if (receivedBytes > CODEX_MAX_RECEIVED_MESSAGE_BYTES) {
          cancelIdle();
          refuse(CODEX_HOOK_INPUT_TOO_LARGE);
        }
        return;
      }
      cancelIdle();
      socket.removeAllListeners("data");
      void this.#answer(received.slice(0, end), abort.signal).then((answer) => {
        // A connection the daemon's stop cut off takes no answer.
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify(answer)}\n`);
        }
      });
    });
    // Codex ended the hook, or the program went away: nothing waits for the answer any more.
    socket.on("close", () => {
      cancelIdle();
      this.#connections.delete(socket);
      abort.abort();
    });
    socket.on("error", (error) => {
      this.#report(error);
    });
  }

  async #answer(line: string, closed: AbortSignal): Promise<CodexHookAnswer> {
    // An input the daemon cannot read is denied before a tool runs, never let through.
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#reportDetail(CODEX_HOOK_INPUT_UNREADABLE);
      return { decision: "deny", reason: CODEX_HOOK_INPUT_UNREADABLE };
    }
    let input: CodexHookInput;
    try {
      input = readCodexHookInput(message);
    } catch (cause) {
      this.#report(cause);
      return { decision: "deny", reason: normalizeProviderFailureDetail(cause) };
    }
    const settled = new AbortController();
    const signal = AbortSignal.any([closed, settled.signal]);
    const cancelDeadline = this.#scheduleDeadline(this.#dependencies.now(), () => {
      settled.abort();
    });
    try {
      const answered = this.#dispatch(input, signal);
      const stopped = new Promise<"stopped">((resolve) => {
        signal.addEventListener("abort", () => {
          resolve("stopped");
        });
      });
      const answer = await Promise.race([answered, stopped]);
      if (answer !== "stopped") {
        return answer;
      }
      return input.eventName === "PreToolUse"
        ? { decision: "deny", reason: CODEX_HOOK_DEADLINE_REASON }
        : PASS;
    } catch (cause) {
      this.#report(cause);
      return input.eventName === "PreToolUse"
        ? { decision: "deny", reason: normalizeProviderFailureDetail(cause) }
        : PASS;
    } finally {
      cancelDeadline();
      settled.abort();
    }
  }

  async #dispatch(input: CodexHookInput, signal: AbortSignal): Promise<CodexHookAnswer> {
    for (const answerer of this.#dependencies.answerers) {
      const answer = await answerer(input, signal);
      if (answer !== undefined) {
        return answer;
      }
    }
    return PASS;
  }

  // Fires the margin before Codex's own deadline for a hook that started at `startedAtMs`, chaining
  // timers since the deadline is past the longest one.
  #scheduleDeadline(startedAtMs: number, onDeadline: () => void): () => void {
    const deadlineMs =
      startedAtMs + Number(CODEX_HOOK_TIMEOUT_SECONDS) * 1000 - CODEX_HOOK_DEADLINE_MARGIN_MS;
    let cancel = (): void => {};
    const arm = (): void => {
      const remainingMs = deadlineMs - this.#dependencies.now();
      if (remainingMs <= 0) {
        onDeadline();
        return;
      }
      cancel = this.#dependencies.scheduleTimeout(arm, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
    };
    arm();
    return () => {
      cancel();
    };
  }

  #report(cause: unknown): void {
    this.#reportDetail(normalizeProviderFailureDetail(cause));
  }

  #reportDetail(detail: string): void {
    reportDiagnosticFromDetachedFrame(this.#dependencies.reportDiagnostic, {
      kind: "hook-answer-failed",
      detail,
    });
  }
}

// The command line Codex runs for one daemon hook: this Node, the program, the address, the event.
function composeCodexHookCommand(
  { endpoint, operatingSystem }: CodexHookServerDependencies,
  eventName: CodexHookEventName,
): string {
  return [process.execPath, CODEX_HOOK_PROGRAM_PATH, endpoint, eventName]
    .map(operatingSystem.quoteShellWord)
    .join(" ");
}

// Reads one hook input line's message; throws `TypeError` for one that is not a daemon hook's.
function readCodexHookInput(message: unknown): CodexHookInput {
  const input = isPlainObject(message) ? message["input"] : undefined;
  if (!isPlainObject(input)) {
    throw new TypeError("The hook program sent no hook input.");
  }
  const eventName = input["hook_event_name"];
  // A helper's call names its own thread as `agent_id`; the session's own call names none, and
  // its `session_id` is the root thread's id, which is the session's thread.
  const threadId = readNonEmptyString(input, "agent_id") ?? readNonEmptyString(input, "session_id");
  if ((eventName !== "PreToolUse" && eventName !== "PostToolUse") || threadId === undefined) {
    throw new TypeError("The hook input names no tool event or no conversation.");
  }
  return {
    eventName,
    threadId,
    turnId: readNonEmptyString(input, "turn_id"),
    toolName: readNonEmptyString(input, "tool_name"),
    toolUseId: readNonEmptyString(input, "tool_use_id"),
    toolInput: input["tool_input"],
  };
}
