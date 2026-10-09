// One running Claude Code process over stream-json: user frames and control requests written to
// its stdin, newline-delimited JSON frames read off its stdout, the requests it sends the daemon
// answered under their own ids, and its exit reported once with the tail of its stderr.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "@ai-sidekicks/contracts/provider/driver/length-limits";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";

import type { OutboundText } from "../../../outbound-text.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { SpawnEnvPair } from "../../../spawn-env.js";
import type { ThreadFrameRoute } from "../../../thread-frame-router.js";
import type { DriverDiagnosticsEmitter } from "../../diagnostics.js";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { ClaudeControlRequestTable } from "./control-requests.js";
import { readClaudeFrameObservation } from "./frame-observation.js";
import { writeStdinLine } from "./stdin-write.js";
import {
  CLAUDE_REQUEST_DEADLINE_MS,
  composeClaudeUserFrame,
  type ClaudeControlRequest,
  type ClaudeControlResponse,
  type ClaudeInboundFrameObservation,
  type ClaudeInboundRequestEvent,
  type ClaudeProviderProcess,
  type ClaudeUserTextWriteAttempt,
} from "./transport.js";

// The route decisions a frame is handed on under; any other leaves it with the router.
const DELIVERED_ROUTE_DECISIONS: ReadonlySet<ThreadFrameRoute["decision"]> = new Set([
  "project",
  "route-connection-scoped",
  "carve-out-interactive-request",
]);

/**
 * Ceiling on one stdout line, in UTF-8 bytes; Claude Code publishes no limit. It stops a process
 * from growing one line until the daemon dies.
 */
const CLAUDE_MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** What starting one Claude Code process takes; the command is already resolved to a path. */
export interface ClaudeCodeProcessLaunch {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  /** The process's whole environment; nothing of the daemon's own is inherited. */
  readonly environment: readonly SpawnEnvPair[];
  /** The id the process runs its conversation under. */
  readonly providerSessionId: string;
  readonly diagnostics: DriverDiagnosticsEmitter;
}

/**
 * Starts a Claude Code process with no shell and resolves once the operating system started it.
 * Rejects when the executable could not be started.
 */
export async function startClaudeCodeProcess(
  launch: ClaudeCodeProcessLaunch,
): Promise<ClaudeCodeProcess> {
  const child = spawn(launch.executablePath, [...launch.args], {
    cwd: launch.workingDirectory,
    env: Object.fromEntries(launch.environment),
    shell: false,
    windowsHide: true,
  });
  // Built before the wait, so no output or exit can arrive ahead of its listeners.
  const claudeProcess = new ClaudeCodeProcess(child, launch);
  await once(child, "spawn");
  return claudeProcess;
}

/** One live Claude Code process; see {@link ClaudeProviderProcess}. */
export class ClaudeCodeProcess implements ClaudeProviderProcess {
  readonly providerSessionId: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #controlRequests: ClaudeControlRequestTable;
  /** Settles once, with how the process ended, when it has exited. */
  readonly exited: Promise<ProcessExit>;
  #closed = false;
  #stderrTail = "";
  // The bytes of the stdout line still being read, and whether a line passed the ceiling.
  #partialLine: Buffer[] = [];
  #partialLineBytes = 0;
  #isOversized = false;
  #turnTerminalListener: ((terminalFrame: unknown) => void) | undefined;
  #inboundFrameObserver:
    | ((observation: ClaudeInboundFrameObservation) => ThreadFrameRoute)
    | undefined;
  #deliveredFrameConsumer:
    | ((frame: Readonly<Record<string, unknown>>, route: ThreadFrameRoute) => void)
    | undefined;
  #inboundRequestObserver: ((event: ClaudeInboundRequestEvent) => void) | undefined;
  #exitObserver: ((exit: ProcessExit) => void) | undefined;

  constructor(child: ChildProcessWithoutNullStreams, launch: ClaudeCodeProcessLaunch) {
    this.providerSessionId = launch.providerSessionId;
    this.#child = child;
    this.#diagnostics = launch.diagnostics;
    this.#controlRequests = new ClaudeControlRequestTable();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#appendOutputTail(chunk);
    });
    // A failed signal or start is told in the exit's tail, where the person reads why it ended.
    child.on("error", (error: Error) => {
      this.#appendOutputTail(`\n${error.message}`);
    });
    // A write to a pipe the process closed fails the write itself; the stream's own error also
    // goes to the exit's tail and must not surface as an unhandled event.
    child.stdin.on("error", (error: Error) => {
      this.#appendOutputTail(`\n${error.message}`);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.#readChunk(chunk);
    });
    child.stdout.once("end", () => {
      this.#flushPartialLine();
    });
    this.exited = new Promise((resolve) => {
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        this.#closed = true;
        // Node gives an exit code whenever it gives no signal.
        const outputTail = this.#stderrTail.trim().length > 0 ? this.#stderrTail : "(no output)";
        const exit: ProcessExit =
          signal === null ? { exitCode: exitCode ?? 0, outputTail } : { signal, outputTail };
        this.#controlRequests.failAllOnExit(
          signal === null
            ? `It exited with code ${String(exitCode)}.`
            : `It was ended by ${signal}.`,
        );
        this.#exitObserver?.(exit);
        resolve(exit);
      });
    });
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async sendUserText(
    outboundText: OutboundText,
    messageUuid: string,
  ): Promise<ClaudeUserTextWriteAttempt> {
    const frame = composeClaudeUserFrame(outboundText, messageUuid);
    return await writeStdinLine(this.#child.stdin, `${JSON.stringify(frame)}\n`);
  }

  async sendControlRequest(request: ClaudeControlRequest): Promise<ClaudeControlResponse> {
    return await this.sendControlRequestWithin(request, CLAUDE_REQUEST_DEADLINE_MS);
  }

  /**
   * Sends one control request with its own deadline, for the one request whose deadline is
   * longer than the rest; see {@link ClaudeProviderProcess.sendControlRequest}.
   */
  async sendControlRequestWithin(
    request: ClaudeControlRequest,
    deadlineMs: number,
  ): Promise<ClaudeControlResponse> {
    return await this.#sendControlRequest(request, deadlineMs);
  }

  /**
   * Sends one capability probe: a control request naming `probeName` and nothing else, answered
   * as any control request is, a refusal of an unknown name included.
   */
  async sendCapabilityProbe(probeName: string): Promise<ClaudeControlResponse> {
    return await this.#sendControlRequest({ subtype: probeName }, CLAUDE_REQUEST_DEADLINE_MS);
  }

  async #sendControlRequest(
    request: { readonly subtype: string },
    deadlineMs: number,
  ): Promise<ClaudeControlResponse> {
    const opened = this.#controlRequests.open(request.subtype, deadlineMs);
    const line = JSON.stringify({ type: "control_request", request_id: opened.requestId, request });
    const attempt = await writeStdinLine(this.#child.stdin, `${line}\n`, deadlineMs);
    if (attempt.settled === "failed") {
      this.#controlRequests.fail(
        opened.requestId,
        attempt.cause instanceof Error
          ? attempt.cause
          : new Error(`The ${request.subtype} request could not be written`),
      );
    }
    return await opened.settled;
  }

  onInboundRequest(observer: (event: ClaudeInboundRequestEvent) => void): void {
    this.#inboundRequestObserver = observer;
  }

  async answerInboundRequest(requestId: string, response: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    const attempt = await writeStdinLine(this.#child.stdin, `${line}\n`);
    if (attempt.settled === "failed") {
      throw attempt.cause;
    }
  }

  onTurnTerminal(listener: (terminalFrame: unknown) => void): void {
    this.#turnTerminalListener = listener;
  }

  onInboundFrame(observer: (observation: ClaudeInboundFrameObservation) => ThreadFrameRoute): void {
    this.#inboundFrameObserver = observer;
  }

  onDeliveredFrame(
    consumer: (frame: Readonly<Record<string, unknown>>, route: ThreadFrameRoute) => void,
  ): void {
    this.#deliveredFrameConsumer = consumer;
  }

  onExit(observer: (exit: ProcessExit) => void): void {
    this.#exitObserver = observer;
  }

  async terminate(): Promise<void> {
    if (!this.#closed) {
      this.#child.kill("SIGTERM");
    }
    await this.exited;
  }

  /** Closes the input, then kills the process if it has not exited within the request deadline. */
  async dispose(): Promise<void> {
    await this.stop(CLAUDE_REQUEST_DEADLINE_MS);
  }

  /**
   * Ends the process as a deliberate stop: closes its input, then kills it if it has not exited
   * within `exitWaitMs`; resolves once it exited.
   */
  async stop(exitWaitMs: number): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#child.stdin.end();
    const kill = setTimeout(() => {
      this.#child.kill("SIGKILL");
    }, exitWaitMs);
    try {
      await this.exited;
    } finally {
      clearTimeout(kill);
    }
  }

  // NUL bytes are dropped: the tail is written into the run's end, which refuses them.
  #appendOutputTail(text: string): void {
    this.#stderrTail = (this.#stderrTail + text.replaceAll("\0", "")).slice(
      -DRIVER_FAILURE_DETAIL_MAX_LEN,
    );
  }

  #readChunk(chunk: Buffer): void {
    if (this.#isOversized) {
      return;
    }
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      this.#partialLine.push(chunk.subarray(start, newline));
      this.#flushPartialLine();
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    const rest = chunk.subarray(start);
    this.#partialLine.push(rest);
    this.#partialLineBytes += rest.length;
    if (this.#partialLineBytes > CLAUDE_MAX_FRAME_BYTES) {
      this.#isOversized = true;
      this.#partialLine = [];
      this.#partialLineBytes = 0;
      this.#diagnostics.emit({
        provider: CLAUDE_DRIVER_NAME,
        kind: "provider_frame_oversized",
        rawWireType: null,
        dispositionReason: "a stdout line passed the frame ceiling, so the process was ended",
        details: { providerSessionId: this.providerSessionId, limit: CLAUDE_MAX_FRAME_BYTES },
      });
      void this.terminate();
    }
  }

  #flushPartialLine(): void {
    const line = Buffer.concat(this.#partialLine).toString("utf8");
    this.#partialLine = [];
    this.#partialLineBytes = 0;
    this.#readLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  #readLine(line: string): void {
    if (line.trim() === "") {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      frame = undefined;
    }
    if (!isPlainObject(frame)) {
      // Fails closed: a line that is no frame is never routed as one.
      this.#diagnostics.emit({
        provider: CLAUDE_DRIVER_NAME,
        kind: "unmapped_wire_kind",
        rawWireType: null,
        dispositionReason: "a stdout line that is not a JSON object was dropped at the read loop",
        details: { providerSessionId: this.providerSessionId },
      });
      return;
    }
    switch (frame["type"]) {
      case "control_response":
        this.#settleControlResponse(frame);
        return;
      case "control_request":
        this.#takeInboundRequest(frame);
        return;
      case "control_cancel_request": {
        const requestId = readNonEmptyString(frame, "request_id");
        if (requestId === undefined) {
          this.#reportMalformedControlFrame("control_cancel_request");
          return;
        }
        this.#inboundRequestObserver?.({ kind: "cancel", requestId });
        return;
      }
      default:
        this.#routeStreamFrame(frame);
    }
  }

  #settleControlResponse(frame: Record<string, unknown>): void {
    const response = frame["response"];
    const requestId = isPlainObject(response)
      ? readNonEmptyString(response, "request_id")
      : undefined;
    if (!isPlainObject(response) || requestId === undefined) {
      this.#reportMalformedControlFrame("control_response");
      return;
    }
    const payload = response["response"];
    this.#controlRequests.settle(
      requestId,
      response["subtype"] === "error"
        ? { subtype: "error", error: readNonEmptyString(response, "error") ?? "" }
        : { subtype: "success", response: isPlainObject(payload) ? payload : undefined },
    );
  }

  #takeInboundRequest(frame: Record<string, unknown>): void {
    const requestId = readNonEmptyString(frame, "request_id");
    const request = frame["request"];
    const subtype = isPlainObject(request) ? readNonEmptyString(request, "subtype") : undefined;
    if (requestId === undefined || !isPlainObject(request) || subtype === undefined) {
      this.#reportMalformedControlFrame("control_request");
      return;
    }
    this.#inboundRequestObserver?.({ kind: "request", request: { requestId, subtype, request } });
  }

  // A control frame nothing can take is recorded: its sender waits on an answer that never comes.
  #reportMalformedControlFrame(rawWireType: string): void {
    this.#diagnostics.emit({
      provider: CLAUDE_DRIVER_NAME,
      kind: "control_frame_malformed",
      rawWireType,
      dispositionReason: "a control frame with no request id or subtype was dropped",
      details: { providerSessionId: this.providerSessionId },
    });
  }

  #routeStreamFrame(frame: Record<string, unknown>): void {
    const observation = readClaudeFrameObservation(frame);
    const route: ThreadFrameRoute = this.#inboundFrameObserver?.(observation) ?? {
      decision: "project",
    };
    if (!DELIVERED_ROUTE_DECISIONS.has(route.decision)) {
      return;
    }
    this.#deliveredFrameConsumer?.(frame, route);
    // A `result` from a helper ends the helper's work, never the session's turn.
    if (frame["type"] === "result" && observation.subagentId === null) {
      this.#turnTerminalListener?.(frame);
    }
  }
}
