// A session's shells: the session → shell → PTY-handle table and every act on it. Each shell's
// record holds its control lease, its flow control, its scrollback window and its ordered input,
// and the table routes the terminal host's output and exits to it by the host's session id.
//
// A request naming a shell its session does not have is refused `pty.not_found`, and a take or a
// write naming an output subscription that is not the calling connection's own open subscription
// to that shell is refused `pty.output_subscription_not_found` before the lease reads it. A
// connection's end releases its bindings on every shell before its subscriptions end, so a hold
// that ends with it is released as a disconnect. A shell keeps running until it is closed or its
// program exits; an exited shell keeps its record, its scrollback and its holds.

import { stat } from "node:fs/promises";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import {
  PTY_CHAT_UNSUPPORTED_CODE,
  PTY_NOT_FOUND_CODE,
  PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
  TerminalIdSchema,
  type PtyCloseRequest,
  type PtyControlChangedPayload,
  type PtyListEntry,
  type PtyListUpdate,
  type PtyOpenRequest,
  type PtyOpenResponse,
  type PtyOutputSubscribeRequest,
  type PtyReorderRequest,
  type PtyResizeRequest,
  type PtyShellStatus,
  type PtyWriteRequest,
  type SessionSetTerminalFlowControlRequest,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { SESSION_WORKING_FOLDER_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/session/methods";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { DaemonDomainError } from "../ipc/domain-error.js";
import type { OutboundQueue } from "../ipc/handlers/session/subscribe.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";
import type { SessionWorkingFolder } from "../session/working-folder/read.js";
import { mintUuidV7 } from "../uuid-v7.js";
import { ShellControlLease, type ShellConnection, type ShellLeaseCaller } from "./control-lease.js";
import { ShellFlowControl } from "./flow-control.js";
import type { PtyHost } from "./host/contract.js";
import type { FollowPtySession } from "./host/session-events.js";
import { ShellMarkReader } from "./shell/integration/marks.js";
import { ShellOutputScanner } from "./shell/output/scanner.js";
import { ShellOutputStream, type ShellOutputOutlet } from "./shell/output/stream.js";
import { ShellResizeQueue, type ShellSize } from "./shell/resize-queue.js";
import { ScrollbackWindow } from "./shell/scrollback.js";
import { prepareShellStart } from "./shell/start.js";
import { ShellPaste, ShellWriteQueue } from "./shell/write-queue.js";

/** The size a shell starts at before any pane sizes it: the conventional terminal's. */
const INITIAL_SHELL_SIZE: ShellSize = { columns: 80, rows: 24 };

// The terminal type a shell's `TERM` names: the one xterm.js, which draws every pane, implements.
const SHELL_TERMINAL_NAME = "xterm-256color";

/** What the shell table is built from. */
interface TerminalSessionsDeps {
  /** The terminal host every shell runs in. */
  readonly host: PtyHost;
  /** Follows one host session's output and exit until the returned call. */
  readonly followHostSession: FollowPtySession;
  /** This machine's own device id, which a run's hold names. */
  readonly machineDeviceId: DeviceId;
  /** Reads a session's shape and working folder; throws `session.not_found` for no session. */
  readonly readWorkingFolder: (sessionId: SessionId) => SessionWorkingFolder;
  /** Appends one change of a shell's holder to its session's event log. */
  readonly appendControlChange: (change: PtyControlChangedPayload) => Promise<void>;
  /** Reads whether `Simplify for a screen reader` is on, from the machine's settings file. */
  readonly readScreenReaderMode: () => Promise<boolean>;
  /** Reads the account's login shell from its record, at each shell's start; `null` for none. */
  readonly readLoginShell: () => string | null;
  /** The login shell's environment captured at the daemon's start. */
  readonly baseEnvironment: readonly SpawnEnvPair[];
  /** The connections' outbound queues, which an output stream reads before it sends. */
  readonly outboundQueue: OutboundQueue;
  /** Writes one line to the service log, where work no caller waits on reports its failure. */
  readonly writeServiceLog: (line: string) => void;
}

// One shell of a session.
interface ShellRecord {
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  readonly clientIdempotencyKey: string;
  // The base name of the program started, its title until it sets its own.
  readonly programName: string;
  // The terminal host's id for the shell's PTY while it runs.
  hostSessionId: string | null;
  // Stops following the host session's output and exit; set while the shell runs.
  unfollowHost: (() => void) | null;
  status: PtyShellStatus;
  readonly lease: ShellControlLease;
  readonly flowControl: ShellFlowControl;
  readonly scanner: ShellOutputScanner;
  readonly markReader: ShellMarkReader | null;
  // Whether a prompt mark carrying the shell's nonce has arrived; one that never comes reports none.
  isReportingMarks: boolean;
  readonly scrollback: ScrollbackWindow;
  // Bytes of output, its marks taken out, since the shell started.
  outputOffset: number;
  // The size the shell was last drawn at, which stays while nobody holds it.
  size: ShellSize;
  readonly writeQueue: ShellWriteQueue;
  // The pastes whose last part has not come yet, by their paste id.
  readonly pastes: Map<string, ShellPaste>;
  readonly resizeQueue: ShellResizeQueue;
  // The write frames awaiting their lease check, one after another in arrival order.
  admissions: Promise<void>;
  readonly streams: Map<SubscriptionId, ShellOutputStream>;
  // Whether a device typed into the shell since its last prompt mark.
  hasInputSincePrompt: boolean;
}

// One session's shells, in tab order, and who follows its list.
interface SessionShells {
  readonly order: TerminalId[];
  readonly shells: Map<TerminalId, ShellRecord>;
  // The opens under way by their idempotency key, so a retry joins the first.
  readonly opening: Map<string, Promise<PtyOpenResponse>>;
  readonly listListeners: Set<(update: PtyListUpdate) => void>;
  // Followers that joined since the list was last sent and have not had their first one yet.
  readonly awaitingFirstList: Set<(update: PtyListUpdate) => void>;
  isListStale: boolean;
  isListRefreshing: boolean;
}

// One open output subscription and the shell it streams.
interface OutputSubscription {
  readonly shell: ShellRecord;
  readonly stream: ShellOutputStream;
}

/** A request naming a shell its session does not have; another session's is not told apart. */
class PtyNotFoundError extends DaemonDomainError {
  constructor(terminalId: TerminalId) {
    super(`this session has no shell ${terminalId}`, {
      code: PTY_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { terminalId },
    });
  }
}

/** A take or write naming a subscription that is not the caller's own open one to the shell. */
class PtyOutputSubscriptionNotFoundError extends DaemonDomainError {
  constructor(terminalId: TerminalId, outputSubscriptionId: SubscriptionId) {
    super(`no open output subscription of this connection to shell ${terminalId}`, {
      code: PTY_OUTPUT_SUBSCRIPTION_NOT_FOUND_CODE,
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      detail: { terminalId, outputSubscriptionId },
    });
  }
}

/** `pty.open` on a chat session, which has no shell. */
class PtyChatUnsupportedError extends DaemonDomainError {
  constructor(sessionId: SessionId) {
    super("A chat session has no shell.", {
      code: PTY_CHAT_UNSUPPORTED_CODE,
      detail: { sessionId },
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

// Refuses a shell start where the session's working folder is not in place, with why.
async function checkWorkingFolder(
  sessionId: SessionId,
  workingFolder: string | null,
): Promise<string> {
  const refuse = (cause: string): DaemonDomainError =>
    new DaemonDomainError(cause, {
      code: SESSION_WORKING_FOLDER_UNAVAILABLE_CODE,
      detail: { sessionId },
    });
  if (workingFolder === null) {
    throw refuse("The session's working folder is not ready yet, so no shell can start in it.");
  }
  try {
    if ((await stat(workingFolder)).isDirectory()) {
      return workingFolder;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  throw refuse("The session's working folder is gone from disk, so no shell can start in it.");
}

/**
 * Every session's shells in this daemon. Each running shell follows its own host session's output
 * and exit through the daemon's one hand-off of the terminal host's events.
 */
export class TerminalSessions {
  readonly #deps: TerminalSessionsDeps;
  readonly #sessions = new Map<SessionId, SessionShells>();
  readonly #outputSubscriptions = new Map<SubscriptionId, OutputSubscription>();

  constructor(deps: TerminalSessionsDeps) {
    this.#deps = deps;
  }

  /**
   * Follows a session's shells: `listener` gets the whole list now and after every change, and the
   * followers already there get nothing for its joining. Throws `session.not_found` for a session
   * this daemon does not hold. Returns the unfollow.
   */
  followList(sessionId: SessionId, listener: (update: PtyListUpdate) => void): () => void {
    this.#deps.readWorkingFolder(sessionId);
    const session = this.#sessionShellsOf(sessionId);
    session.listListeners.add(listener);
    session.awaitingFirstList.add(listener);
    this.#sendList(sessionId);
    return () => {
      session.listListeners.delete(listener);
      session.awaitingFirstList.delete(listener);
      this.#forgetIfIdle(sessionId);
    };
  }

  /**
   * Starts a shell for the session, or answers the shell a retry with the same key already
   * started. Refuses a chat session `pty.chat_unsupported` and a session whose working folder is
   * not in place `session.working_folder_unavailable`; a login shell the check before the start
   * finds cannot start gives way to the platform's default shell, and a shell that fails to start
   * keeps its record as `did_not_start` with the system's words for why.
   */
  open(request: PtyOpenRequest): Promise<PtyOpenResponse> {
    const session = this.#sessionShellsOf(request.sessionId);
    for (const shell of session.shells.values()) {
      if (shell.clientIdempotencyKey === request.clientIdempotencyKey) {
        return Promise.resolve({ terminalId: shell.terminalId });
      }
    }
    const underWay = session.opening.get(request.clientIdempotencyKey);
    if (underWay !== undefined) {
      return underWay;
    }
    const opening = this.#startShell(request, session).finally(() => {
      session.opening.delete(request.clientIdempotencyKey);
      this.#forgetIfIdle(request.sessionId);
    });
    session.opening.set(request.clientIdempotencyKey, opening);
    return opening;
  }

  /**
   * Ends a shell and removes it, ending its subscriptions; refused while a run holds it, and while
   * another device holds it unless `force` is true. Of two closes of one shell, the second is
   * refused `pty.not_found`.
   */
  async close(request: PtyCloseRequest, deviceId: DeviceId): Promise<void> {
    const shell = this.#findShell(request.sessionId, request.terminalId);
    let hostClosed: Promise<void> = Promise.resolve();
    await shell.lease.admitClose(deviceId, request.force === true, () => {
      // Another close may have removed the shell while this one waited on its lease.
      hostClosed = this.#removeShell(this.#sessionHolding(shell));
    });
    await hostClosed;
  }

  /** Puts the named shells first in the given order; any it does not name keep theirs after. */
  reorder(request: PtyReorderRequest): void {
    for (const terminalId of request.terminalIds) {
      this.#findShell(request.sessionId, terminalId);
    }
    const session = this.#sessionShellsOf(request.sessionId);
    const unnamed = session.order.filter((terminalId) => !request.terminalIds.includes(terminalId));
    session.order.splice(0, session.order.length, ...request.terminalIds, ...unnamed);
    this.#refreshList(request.sessionId);
  }

  /**
   * Streams a shell's output to `outlet`: its scrollback, then its output. A shell that no longer
   * runs is sent as its scrollback and how it ended, and the subscription ends. Each open
   * subscription counts its connection as a watcher of the shell until it ends.
   */
  async subscribeOutput(
    request: PtyOutputSubscribeRequest,
    outlet: ShellOutputOutlet,
  ): Promise<void> {
    const shell = this.#findShell(request.sessionId, request.terminalId);
    const stream = new ShellOutputStream(
      outlet,
      {
        sessionId: shell.sessionId,
        terminalId: shell.terminalId,
        readHolder: () => shell.lease.readHolder(),
        readScrollback: () => ({
          bytes: shell.scrollback.read(),
          cursor: shell.outputOffset,
          size: shell.size,
        }),
        isConnectionBehind: () => shell.flowControl.isBehind(outlet.transportId),
      },
      this.#deps.outboundQueue,
    );
    if (shell.hostSessionId === null) {
      await stream.replay(
        shell.status.state === "exited"
          ? { exitCode: shell.status.exitCode, cursor: shell.outputOffset }
          : null,
      );
      return;
    }
    shell.streams.set(outlet.subscriptionId, stream);
    this.#outputSubscriptions.set(outlet.subscriptionId, { shell, stream });
    await Promise.all([stream.open(), shell.flowControl.addWatcher(outlet.transportId)]);
  }

  /**
   * Ends what an output subscription carried, once it has been canceled or its connection closed:
   * its connection's watch of the shell when it was that connection's last on it, the hold
   * bindings it carried, and any paste written through it, closed with its end mark. An unknown or
   * already ended subscription changes nothing.
   */
  endOutputSubscription(subscriptionId: SubscriptionId): void {
    const subscription = this.#outputSubscriptions.get(subscriptionId);
    if (subscription === undefined) {
      return;
    }
    const { shell, stream } = subscription;
    stream.detach();
    this.#forgetOutputSubscription(subscriptionId, shell);
    const transportId = stream.transportId;
    const isConnectionStillWatching = [...shell.streams.values()].some(
      (other) => other.transportId === transportId,
    );
    if (!isConnectionStillWatching) {
      this.#reportFailure(
        shell.flowControl.removeWatcher(transportId),
        `Shell ${shell.terminalId} could not read again after a watcher left`,
      );
    }
    this.#releaseSubscription(shell, subscriptionId);
    this.#closePastes(shell, subscriptionId);
  }

  /**
   * Whether the shell reports its prompt and command marks: false until its first prompt mark
   * carrying its nonce arrives, so a shell with no script, or whose startup files turned it off,
   * reports none. Throws `pty.not_found` for a shell the session does not have.
   *
   * @consumedBy an agent's command in a session's shell
   */
  isReportingMarks(sessionId: SessionId, terminalId: TerminalId): boolean {
    return this.#findShell(sessionId, terminalId).isReportingMarks;
  }

  /**
   * The lease of the shell the caller's output subscription streams, for a take through that
   * pane. Throws `pty.not_found` for a shell the session does not have, and
   * `pty.output_subscription_not_found` for a subscription that is not the calling connection's
   * own open one to that shell.
   */
  leaseForOutputSubscription(
    sessionId: SessionId,
    terminalId: TerminalId,
    caller: Pick<ShellLeaseCaller, "transportId" | "outputSubscriptionId">,
  ): ShellControlLease {
    return this.#shellForOutputSubscription(sessionId, terminalId, caller).lease;
  }

  /**
   * Writes one frame of input once the shell's lease admits it, in arrival order, after the frames
   * before it; a paste's parts are marked as one paste. Resolves once the host has every byte of
   * it; refuses as the take does for the shell and the subscription, also when either ended while
   * the frame waited, and as the lease does for the writer.
   */
  async write(request: PtyWriteRequest, caller: ShellLeaseCaller): Promise<void> {
    const shell = this.#shellForOutputSubscription(request.sessionId, request.terminalId, caller);
    let delivered: Promise<void> = Promise.resolve();
    const admitted = shell.admissions.then(() =>
      shell.lease.admitWrite({ kind: "device", ...caller }, () => {
        shell.hasInputSincePrompt = true;
        delivered = shell.writeQueue.enqueue(this.#encodeInput(shell, request));
      }),
    );
    // The chain only orders the next frame's check after this one; this frame's outcome reaches
    // its caller below. A refused part ends its paste, so the program is not left inside it.
    shell.admissions = admitted.catch(() => {
      if (request.kind !== "paste") {
        return;
      }
      const paste = shell.pastes.get(request.pasteId);
      if (paste !== undefined) {
        shell.pastes.delete(request.pasteId);
        this.#writePasteEnd(shell, paste);
      }
    });
    await admitted;
    await delivered;
  }

  /**
   * Sizes a shell from a connection its hold is bound to. Resolves once the host has this size or
   * a newer one.
   */
  async resize(request: PtyResizeRequest, caller: ShellConnection): Promise<void> {
    const shell = this.#findShell(request.sessionId, request.terminalId);
    let applied: Promise<void> = Promise.resolve();
    await shell.lease.admitResize(caller, () => {
      shell.size = { columns: request.columns, rows: request.rows };
      applied = shell.resizeQueue.request(shell.size);
    });
    await applied;
  }

  /**
   * Records whether a connection has fallen behind on a shell; a watcher that caught up and missed
   * output is reseeded from the scrollback. Naming a shell the session does not have, or one that
   * no longer runs, changes nothing, since the call may race a closing shell.
   */
  async declareFlowControl(
    request: SessionSetTerminalFlowControlRequest,
    transportId: number,
  ): Promise<void> {
    const shell = this.#sessions.get(request.sessionId)?.shells.get(request.terminalId);
    if (shell === undefined || shell.hostSessionId === null) {
      return;
    }
    const declared = shell.flowControl.declare(transportId, request.paused);
    if (!request.paused) {
      for (const stream of shell.streams.values()) {
        if (stream.transportId === transportId) {
          stream.catchUp();
        }
      }
    }
    await declared;
  }

  /**
   * Ends a closed connection's bindings on every shell's hold, a hold ending with its last as a
   * disconnect. Called before the connection's subscriptions end, so their ends find nothing left.
   */
  releaseConnection(transportId: number): void {
    for (const session of this.#sessions.values()) {
      for (const shell of session.shells.values()) {
        this.#reportFailure(
          shell.lease.releaseConnection(transportId),
          `Shell ${shell.terminalId}'s hold could not be released at a disconnect`,
        );
      }
    }
  }

  // The bytes one write frame puts on the shell's input; a paste's first part decides, once for
  // all its parts, whether it is marked as pasted.
  #encodeInput(shell: ShellRecord, request: PtyWriteRequest): Uint8Array {
    if (request.kind === "keys") {
      return Buffer.from(request.data, "utf8");
    }
    let paste = shell.pastes.get(request.pasteId);
    if (paste === undefined) {
      paste = new ShellPaste(shell.scanner.isBracketedPasteRequested, request.outputSubscriptionId);
      shell.pastes.set(request.pasteId, paste);
    }
    if (request.isLastPart) {
      shell.pastes.delete(request.pasteId);
    }
    return paste.encodePart(request.data, request.isLastPart);
  }

  // Closes every paste written through an ended subscription with its end mark, after the frames
  // already waiting their turn, so the program in the shell is never left inside a paste.
  #closePastes(shell: ShellRecord, subscriptionId: SubscriptionId): void {
    const unfinished = [...shell.pastes].filter(
      ([, paste]) => paste.outputSubscriptionId === subscriptionId,
    );
    if (unfinished.length === 0) {
      return;
    }
    for (const [pasteId] of unfinished) {
      shell.pastes.delete(pasteId);
    }
    shell.admissions = shell.admissions.then(() => {
      for (const [, paste] of unfinished) {
        this.#writePasteEnd(shell, paste);
      }
    });
  }

  // Writes what a paste left unfinished still holds, and its end mark, behind the admitted input.
  #writePasteEnd(shell: ShellRecord, paste: ShellPaste): void {
    this.#reportFailure(
      shell.writeQueue.enqueue(paste.close()),
      `Shell ${shell.terminalId} could not close a paste left unfinished`,
    );
  }

  async #startShell(request: PtyOpenRequest, session: SessionShells): Promise<PtyOpenResponse> {
    const { shape, workingFolder } = this.#deps.readWorkingFolder(request.sessionId);
    if (shape === "chat") {
      throw new PtyChatUnsupportedError(request.sessionId);
    }
    const folder = await checkWorkingFolder(request.sessionId, workingFolder);
    const start = await prepareShellStart({
      loginShell: this.#deps.readLoginShell(),
      baseEnvironment: this.#deps.baseEnvironment,
      isScreenReaderModeOn: await this.#deps.readScreenReaderMode(),
    });
    let hostSessionId: string | null = null;
    let status: PtyShellStatus;
    try {
      const spawned = await this.#deps.host.spawn({
        kind: "spawn_request",
        command: start.command,
        args: [...start.args],
        env: start.environment.map(([name, value]): [string, string] => [name, value]),
        cwd: folder,
        rows: INITIAL_SHELL_SIZE.rows,
        cols: INITIAL_SHELL_SIZE.columns,
        terminal_name: SHELL_TERMINAL_NAME,
      });
      hostSessionId = spawned.session_id;
      status = { state: "running" };
    } catch (error) {
      status = { state: "did_not_start", cause: describeError(error) };
    }
    const shell = this.#createShell(request, start.programName, status, hostSessionId, start.nonce);
    session.shells.set(shell.terminalId, shell);
    session.order.push(shell.terminalId);
    if (hostSessionId !== null) {
      shell.unfollowHost = this.#deps.followHostSession(hostSessionId, {
        onData: (chunk) => {
          this.#takeOutput(shell, chunk);
        },
        onExit: (exitCode) => {
          this.#takeExit(shell, exitCode);
        },
      });
    }
    if (start.fallbackNotice !== null) {
      this.#appendOutput(shell, Buffer.from(start.fallbackNotice, "utf8"));
    }
    this.#refreshList(request.sessionId);
    return { terminalId: shell.terminalId };
  }

  #createShell(
    request: PtyOpenRequest,
    programName: string,
    status: PtyShellStatus,
    hostSessionId: string | null,
    nonce: string | null,
  ): ShellRecord {
    const { sessionId } = request;
    const terminalId = TerminalIdSchema.parse(mintUuidV7());
    const runningHostSession = (): string => {
      if (shell.hostSessionId === null) {
        throw new Error(`Shell ${terminalId} no longer runs`);
      }
      return shell.hostSessionId;
    };
    const shell: ShellRecord = {
      sessionId,
      terminalId,
      clientIdempotencyKey: request.clientIdempotencyKey,
      programName,
      hostSessionId,
      unfollowHost: null,
      status,
      lease: new ShellControlLease({
        sessionId,
        terminalId,
        machineDeviceId: this.#deps.machineDeviceId,
        broadcast: async (change) => {
          try {
            await this.#deps.appendControlChange(change);
          } finally {
            this.#refreshList(sessionId);
          }
        },
        refuseEndedCaller: (caller) => {
          this.#refuseEndedCaller(shell, caller);
        },
      }),
      flowControl: new ShellFlowControl({
        pause: () => this.#deps.host.pause(runningHostSession()),
        resume: () => this.#deps.host.resume(runningHostSession()),
      }),
      scanner: new ShellOutputScanner(),
      markReader: nonce === null ? null : new ShellMarkReader(nonce),
      isReportingMarks: false,
      scrollback: new ScrollbackWindow(),
      outputOffset: 0,
      size: INITIAL_SHELL_SIZE,
      writeQueue: new ShellWriteQueue((bytes) =>
        this.#deps.host.write(runningHostSession(), bytes),
      ),
      pastes: new Map(),
      resizeQueue: new ShellResizeQueue((size) =>
        this.#deps.host.resize(runningHostSession(), size.rows, size.columns),
      ),
      admissions: Promise.resolve(),
      streams: new Map(),
      hasInputSincePrompt: false,
    };
    return shell;
  }

  #takeOutput(shell: ShellRecord, chunk: Uint8Array): void {
    if (shell.markReader === null) {
      this.#appendOutput(shell, chunk);
      return;
    }
    const { output, marks } = shell.markReader.read(chunk);
    if (marks.some((mark) => mark.kind === "prompt")) {
      shell.hasInputSincePrompt = false;
      shell.isReportingMarks = true;
    }
    this.#appendOutput(shell, output);
  }

  #appendOutput(shell: ShellRecord, output: Uint8Array): void {
    if (output.byteLength === 0) {
      return;
    }
    shell.scrollback.append(output);
    shell.outputOffset += output.byteLength;
    if (shell.scanner.scan(output)) {
      this.#refreshList(shell.sessionId);
    }
    for (const stream of shell.streams.values()) {
      stream.deliver(output, shell.outputOffset);
    }
  }

  // An exited shell keeps its record and its holds, which end with their connections or its
  // close; a prefix its mark reader held is output, its subscriptions get the exit and end, and
  // the host lets the session go.
  #takeExit(shell: ShellRecord, exitCode: number): void {
    // The host reports an exit only while the shell is followed, so it still has its session.
    const { hostSessionId } = shell;
    if (hostSessionId === null) {
      return;
    }
    if (shell.markReader !== null) {
      this.#appendOutput(shell, shell.markReader.flush());
    }
    shell.hostSessionId = null;
    shell.unfollowHost = null;
    shell.status = { state: "exited", exitCode };
    // An exited shell takes no input, so a paste left open has nothing to close.
    shell.pastes.clear();
    for (const [subscriptionId, stream] of [...shell.streams]) {
      stream.exit({ exitCode, cursor: shell.outputOffset });
      this.#forgetOutputSubscription(subscriptionId, shell);
    }
    this.#reportFailure(
      this.#deps.host.close(hostSessionId),
      `The terminal host could not let exited shell ${shell.terminalId} go`,
    );
    this.#refreshList(shell.sessionId);
  }

  // Takes the shell out of its session at once and ends its subscriptions; answers the host's
  // close of a shell that still runs.
  #removeShell({ session, shell }: { session: SessionShells; shell: ShellRecord }): Promise<void> {
    session.shells.delete(shell.terminalId);
    session.order.splice(session.order.indexOf(shell.terminalId), 1);
    for (const [subscriptionId, stream] of [...shell.streams]) {
      stream.end();
      this.#forgetOutputSubscription(subscriptionId, shell);
    }
    this.#refreshList(shell.sessionId);
    this.#forgetIfIdle(shell.sessionId);
    const { hostSessionId } = shell;
    if (hostSessionId === null) {
      return Promise.resolve();
    }
    shell.unfollowHost?.();
    shell.unfollowHost = null;
    shell.hostSessionId = null;
    return this.#deps.host.close(hostSessionId);
  }

  #forgetOutputSubscription(subscriptionId: SubscriptionId, shell: ShellRecord): void {
    this.#outputSubscriptions.delete(subscriptionId);
    shell.streams.delete(subscriptionId);
  }

  #releaseSubscription(shell: ShellRecord, subscriptionId: SubscriptionId): void {
    this.#reportFailure(
      shell.lease.releaseSubscription(subscriptionId),
      `Shell ${shell.terminalId}'s hold could not be released as a pane closed`,
    );
  }

  // The shell's session while the shell is still in it; throws `pty.not_found` once it is not.
  #sessionHolding(shell: ShellRecord): { session: SessionShells; shell: ShellRecord } {
    const session = this.#sessions.get(shell.sessionId);
    if (session?.shells.get(shell.terminalId) !== shell) {
      throw new PtyNotFoundError(shell.terminalId);
    }
    return { session, shell };
  }

  // Throws `pty.not_found` for a shell no longer in its session, and
  // `pty.output_subscription_not_found` for a caller whose subscription is not its own open one to
  // that shell.
  #refuseEndedCaller(
    shell: ShellRecord,
    caller: Pick<ShellLeaseCaller, "transportId" | "outputSubscriptionId">,
  ): void {
    this.#sessionHolding(shell);
    const subscription = this.#outputSubscriptions.get(caller.outputSubscriptionId);
    if (subscription?.shell !== shell || subscription.stream.transportId !== caller.transportId) {
      throw new PtyOutputSubscriptionNotFoundError(shell.terminalId, caller.outputSubscriptionId);
    }
  }

  #findShell(sessionId: SessionId, terminalId: TerminalId): ShellRecord {
    const shell = this.#sessions.get(sessionId)?.shells.get(terminalId);
    if (shell === undefined) {
      throw new PtyNotFoundError(terminalId);
    }
    return shell;
  }

  #shellForOutputSubscription(
    sessionId: SessionId,
    terminalId: TerminalId,
    caller: Pick<ShellLeaseCaller, "transportId" | "outputSubscriptionId">,
  ): ShellRecord {
    const shell = this.#findShell(sessionId, terminalId);
    this.#refuseEndedCaller(shell, caller);
    return shell;
  }

  #sessionShellsOf(sessionId: SessionId): SessionShells {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = {
        order: [],
        shells: new Map(),
        opening: new Map(),
        listListeners: new Set(),
        awaitingFirstList: new Set(),
        isListStale: false,
        isListRefreshing: false,
      };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  // A session with no shell, no open under way and no one following its list holds nothing.
  #forgetIfIdle(sessionId: SessionId): void {
    const session = this.#sessions.get(sessionId);
    if (
      session !== undefined &&
      session.shells.size === 0 &&
      session.opening.size === 0 &&
      session.listListeners.size === 0
    ) {
      this.#sessions.delete(sessionId);
    }
  }

  // Marks the session's list changed and sends it to every follower.
  #refreshList(sessionId: SessionId): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.isListStale = true;
    this.#sendList(sessionId);
  }

  // Sends the session's whole list once every holder in it has settled: to every follower after a
  // change, and otherwise to the followers awaiting their first. What comes while a list is being
  // read makes one more read, never two at once.
  #sendList(sessionId: SessionId): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.isListRefreshing) {
      return;
    }
    session.isListRefreshing = true;
    const refreshing = (async () => {
      try {
        while (session.isListStale || session.awaitingFirstList.size > 0) {
          const isChanged = session.isListStale;
          session.isListStale = false;
          const update = await this.#readList(sessionId, session);
          const recipients = isChanged
            ? [...session.listListeners]
            : [...session.awaitingFirstList];
          for (const listener of recipients) {
            session.awaitingFirstList.delete(listener);
            listener(update);
          }
        }
      } finally {
        session.isListRefreshing = false;
      }
    })();
    this.#reportFailure(refreshing, `The shell list of session ${sessionId} could not be sent`);
  }

  async #readList(sessionId: SessionId, session: SessionShells): Promise<PtyListUpdate> {
    const shells = session.order.flatMap((terminalId) => session.shells.get(terminalId) ?? []);
    const terminals: PtyListEntry[] = await Promise.all(
      shells.map(async (shell) => ({
        terminalId: shell.terminalId,
        title: shell.scanner.title ?? shell.programName,
        status: shell.status,
        ...(await shell.lease.readHolder()),
      })),
    );
    // A shell closed while its holder was read is left out; its close reads the list again.
    return {
      sessionId,
      terminals: terminals.filter((entry) => session.shells.has(entry.terminalId)),
    };
  }

  #reportFailure(work: Promise<void>, what: string): void {
    void work.catch((error: unknown) => {
      this.#deps.writeServiceLog(`${what}: ${describeError(error)}`);
    });
  }
}
