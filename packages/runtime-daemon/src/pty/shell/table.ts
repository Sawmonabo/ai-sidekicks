// A session's shells: the session → shell → PTY-handle table and every act on it. Each shell's
// record holds its control lease, its flow control, its scrollback window and its ordered input,
// and the table routes the terminal host's output and exits to it by the host's session id.
//
// A request naming a shell its session does not have is refused `pty.not_found`, and a take or a
// write naming an output subscription that is not the calling connection's own open subscription
// to that shell is refused `pty.output_subscription_not_found` before the lease reads it. A
// connection's end releases its bindings on every shell before its subscriptions end, so a hold
// that ends with it is released as a disconnect. A shell keeps running until it is closed, its
// program exits or its session is deleted. Whenever the daemon ends a shell's subscriptions — at
// its exit, its close or its session's deletion — the hold bindings they carried are released as
// closed panes, a close starting that release before the shell leaves its session; a run's hold
// stays until its command or run ends. An exited shell keeps its record and its scrollback.
//
// Each shell's screen copy answers what its program asks the terminal, its colors and cell size
// from the pane holding it, which a change of holder forgets, or else from the console theme the
// desktop last reported for every shell.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import {
  type PtyCloseRequest,
  type PtyControlChangedPayload,
  type PtyListEntry,
  type PtyListUpdate,
  type PtyOpenRequest,
  type PtyOpenResponse,
  type PtyOutputSubscribeRequest,
  type PtyReorderRequest,
  type PtyReportTerminalAppearanceRequest,
  type PtyResizeRequest,
  type PtyShellStatus,
  type PtyWriteRequest,
  type SessionSetTerminalFlowControlRequest,
  type TerminalColors,
  type TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import type { OutboundQueue } from "../../ipc/handlers/session/subscribe.js";
import type { SpawnEnvPair } from "../../provider/spawn-env.js";
import { sessionNotFound } from "../../session/not-found.js";
import type { SessionWorkingFolder } from "../../session/working-folder/read.js";
import {
  ShellControlLease,
  type ShellConnection,
  type ShellLeaseCaller,
} from "../control-lease.js";
import type { PtyHost } from "../host/contract.js";
import type { FollowPtySession } from "../host/session-events.js";
import {
  discardMarkNonceFile,
  prepareShellStartupFolders,
  type ShellStartupFolders,
} from "./integration/injection.js";
import { ShellOutputStream, type ShellOutputOutlet } from "./output/stream.js";
import { ShellListFollowers } from "./list.js";
import {
  PtyChatUnsupportedError,
  PtyNotFoundError,
  PtyOutputSubscriptionNotFoundError,
} from "./refusals.js";
import {
  createShellRecord,
  INITIAL_SHELL_SIZE,
  type ShellRecord,
  type ShellRecordHooks,
} from "./record.js";
import type { TerminalOperatingSystem } from "../operating-system/contract.js";
import { checkWorkingFolder, prepareShellStart } from "./start.js";

// The terminal type a shell's `TERM` names: the one xterm.js, which draws every pane, implements.
const SHELL_TERMINAL_NAME = "xterm-256color";

/** What the shell table is built from. */
interface ShellTableDeps {
  /** The terminal host every shell runs in. */
  readonly host: PtyHost;
  /** Follows one host session's output and exit until the returned call. */
  readonly followPtySession: FollowPtySession;
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
  /**
   * The daemon's run folder, which only this account may open; a shell's startup files go there.
   */
  readonly runFolderPath: string;
  /** What the terminal takes from the operating system it runs on. */
  readonly operatingSystem: TerminalOperatingSystem;
  /** What each shell's terminal answers a program asking its name and version. */
  readonly terminalVersion: string;
  /** The connections' outbound queues, which an output stream reads before it sends. */
  readonly outboundQueue: OutboundQueue;
  /** Writes one line to the service log, where work no caller waits on reports its failure. */
  readonly writeServiceLog: (line: string) => void;
}

// One session's shells, in tab order, and who follows its list.
interface SessionShells {
  readonly order: TerminalId[];
  readonly shells: Map<TerminalId, ShellRecord>;
  // The opens under way by their idempotency key, so a retry joins the first.
  readonly opening: Map<string, Promise<PtyOpenResponse>>;
  readonly list: ShellListFollowers;
  // The deletions of the session under way, each refusing its opens until it settles.
  closeHolds: number;
}

// What ending a shell leaves to settle: the release of the holds its panes carried, appended, and
// the terminal host letting the shell go.
interface ShellEnding {
  readonly released: Promise<void>;
  readonly hostClosed: Promise<void>;
}

// One open output subscription and the shell it streams.
interface OutputSubscription {
  readonly shell: ShellRecord;
  readonly stream: ShellOutputStream;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/**
 * Every session's shells in this daemon. Each running shell follows its own host session's output
 * and exit through the daemon's one hand-off of the terminal host's events.
 */
export class ShellTable {
  readonly #deps: ShellTableDeps;
  readonly #sessions = new Map<SessionId, SessionShells>();
  readonly #outputSubscriptions = new Map<SubscriptionId, OutputSubscription>();
  // Prepared once, as the daemon starts, so no nonce file an earlier start left outlives it.
  readonly #startupFolders: Promise<ShellStartupFolders>;
  // The console theme's terminal colors the desktop last reported, for a shell no holder reported.
  #consoleColors: TerminalColors | null = null;
  readonly #recordHooks: ShellRecordHooks;

  constructor(deps: ShellTableDeps) {
    this.#deps = deps;
    this.#recordHooks = {
      host: deps.host,
      machineDeviceId: deps.machineDeviceId,
      terminalVersion: deps.terminalVersion,
      appendControlChange: deps.appendControlChange,
      readConsoleColors: () => this.#consoleColors,
      writeInput: (shell, bytes, failure) => {
        this.#writeInput(shell, bytes, failure);
      },
      refreshList: (sessionId) => {
        this.#refreshList(sessionId);
      },
      refuseEndedCaller: (shell, caller) => {
        this.#refuseEndedCaller(shell, caller);
      },
    };
    this.#startupFolders = prepareShellStartupFolders(deps.runFolderPath);
    // Each open fails with it too; the service log says so even before the first open.
    this.#reportFailure(
      this.#startupFolders.then(() => undefined),
      "The shells' startup folders could not be prepared",
    );
  }

  /**
   * Follows a session's shells: `listener` gets the whole list now and after every change, and the
   * followers already there get nothing for its joining. Throws `session.not_found` for a session
   * this daemon does not hold. Returns the unfollow.
   */
  followList(sessionId: SessionId, listener: (update: PtyListUpdate) => void): () => void {
    this.#deps.readWorkingFolder(sessionId);
    const unfollow = this.#sessionShellsOf(sessionId).list.follow(listener);
    return () => {
      unfollow();
      this.#forgetIfIdle(sessionId);
    };
  }

  /**
   * Starts a shell for the session, or answers the shell a retry with the same key already
   * started. Refuses a chat session `pty.chat_unsupported` and a session whose working folder is
   * not in place `session.working_folder_unavailable`; a login shell the system will not start
   * gives way to the platform's default shell, and a shell that fails to start keeps its record as
   * `did_not_start` with the system's words for why.
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
   * Ends a shell and removes it, ending its subscriptions and releasing the holds they carried;
   * refused while a run holds it, and while another device holds it unless `force` is true. Of two
   * closes of one shell, the second is refused `pty.not_found`. Resolves once the release is
   * appended and the host has let the shell go, and rejects with either's failure.
   */
  async close(request: PtyCloseRequest, deviceId: DeviceId): Promise<void> {
    const shell = this.#findShell(request.sessionId, request.terminalId);
    let ending: ShellEnding | undefined;
    await shell.lease.admitClose(deviceId, request.force === true, () => {
      // Another close may have removed the shell while this one waited on its lease.
      ending = this.#endShell(this.#sessionHolding(shell));
    });
    if (ending !== undefined) {
      await Promise.all([ending.released, ending.hostClosed]);
    }
  }

  /**
   * Ends every shell of a session being deleted, whoever holds it and those still opening, so none
   * keeps running in a folder about to go, and refuses the session's opens `session.not_found`
   * until the returned call. Resolves once the host has let every shell go, and rejects with the
   * first failure, the session's opens no longer refused. A hold whose release cannot be appended
   * is reported to the service log, as its shell has ended all the same.
   */
  async closeSessionShells(sessionId: SessionId): Promise<() => void> {
    const session = this.#sessionShellsOf(sessionId);
    session.closeHolds += 1;
    const allowOpens = (): void => {
      session.closeHolds -= 1;
      this.#forgetIfIdle(sessionId);
    };
    try {
      // An open under way sees the hold once its shell has started and leaves the shell here.
      await Promise.allSettled([...session.opening.values()]);
      await Promise.all(
        [...session.shells.values()].map((shell) => {
          const { released, hostClosed } = this.#endShell({ session, shell });
          this.#reportFailure(
            released,
            `Shell ${shell.terminalId}'s hold could not be released as its session was deleted`,
          );
          return hostClosed;
        }),
      );
    } catch (error) {
      allowOpens();
      throw error;
    }
    return allowOpens;
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
    this.#endWatch(shell, stream.transportId);
    this.#reportFailure(
      shell.lease.releaseSubscriptions([subscriptionId]),
      `Shell ${shell.terminalId}'s hold could not be released as a pane closed`,
    );
    const closing = shell.pastes.closeFor(subscriptionId);
    if (closing.byteLength > 0) {
      // After the frames already waiting their turn, so the program is never left inside a paste.
      shell.admissions = shell.admissions.then(() => {
        this.#writeInput(shell, closing, "could not close a paste its pane left unfinished");
      });
    }
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
   * Whether a device typed into the shell since its last prompt mark, so a run takes only a shell
   * sitting idle at its prompt. Throws `pty.not_found` for a shell the session does not have.
   */
  hasInputSincePrompt(sessionId: SessionId, terminalId: TerminalId): boolean {
    return this.#findShell(sessionId, terminalId).hasInputSincePrompt;
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
   * before it; a paste's parts are marked as one paste. Resolves once the host has written every
   * byte of it to the shell's terminal; refuses as the take does for the shell and the
   * subscription, also when either ended while the frame waited, and as the lease does for the
   * writer, and rejects when the shell stopped running before its bytes were written.
   */
  async write(request: PtyWriteRequest, caller: ShellLeaseCaller): Promise<void> {
    const shell = this.#shellForOutputSubscription(request.sessionId, request.terminalId, caller);
    let delivered: Promise<void> = Promise.resolve();
    // A paste reads whether the program asked for pasted text marked from all output already come.
    const admitted = shell.admissions.then(async () => {
      if (request.kind === "paste") {
        await shell.screen.settle();
      }
      await shell.lease.admitWrite({ kind: "device", ...caller }, () => {
        shell.hasInputSincePrompt = true;
        delivered = shell.writeQueue.enqueue(
          request.kind === "keys"
            ? Buffer.from(request.data, "utf8")
            : shell.pastes.encodePart(request, () => shell.screen.isBracketedPasteRequested),
        );
      });
    });
    // The chain only orders the next frame's check after this one; this frame's outcome reaches
    // its caller below. A refused part ends its paste, so the program is not left inside it.
    shell.admissions = admitted.catch(() => {
      if (request.kind === "paste") {
        this.#writeInput(
          shell,
          shell.pastes.closePaste(request.pasteId),
          "could not close a paste a refused part left unfinished",
        );
      }
    });
    await admitted;
    await delivered;
  }

  /**
   * Sizes a shell from a connection its hold is bound to. Resolves once the host has this size or
   * a newer one; a shell that stopped running meanwhile keeps the size as the one it was last
   * drawn at.
   */
  async resize(request: PtyResizeRequest, caller: ShellConnection): Promise<void> {
    const shell = this.#findShell(request.sessionId, request.terminalId);
    let applied: Promise<void> = Promise.resolve();
    await shell.lease.admitFromHoldingConnection(caller, () => {
      shell.size = { columns: request.columns, rows: request.rows };
      shell.screen.resize(request.columns, request.rows);
      applied = shell.resizeQueue.request(shell.size);
    });
    await applied;
  }

  /**
   * Keeps the appearance a shell's program is answered from when it asks its terminal: the console
   * theme's colors for every shell, or the colors and cell size of the pane holding one shell,
   * which only a connection its hold is bound to may report and which outranks the console theme
   * until the shell changes holder. A pane's report refuses as a resize does.
   */
  async reportTerminalAppearance(
    request: PtyReportTerminalAppearanceRequest,
    caller: ShellConnection,
  ): Promise<void> {
    if (request.source === "console_theme") {
      this.#consoleColors = request.colors;
      return;
    }
    const shell = this.#findShell(request.sessionId, request.terminalId);
    await shell.lease.admitFromHoldingConnection(caller, () => {
      shell.paneAppearance = { colors: request.colors, cellSize: request.cellSize };
    });
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

  // Queues bytes no caller waits on behind the shell's admitted input, reporting a failure.
  #writeInput(shell: ShellRecord, bytes: Uint8Array, failure: string): void {
    this.#reportFailure(shell.writeQueue.enqueue(bytes), `Shell ${shell.terminalId} ${failure}`);
  }

  async #startShell(request: PtyOpenRequest, session: SessionShells): Promise<PtyOpenResponse> {
    if (session.closeHolds > 0) {
      throw sessionNotFound(request.sessionId);
    }
    const { shape, workingFolder } = this.#deps.readWorkingFolder(request.sessionId);
    if (shape === "chat") {
      throw new PtyChatUnsupportedError(request.sessionId);
    }
    const folder = await checkWorkingFolder(request.sessionId, workingFolder);
    const start = await prepareShellStart({
      loginShell: this.#deps.readLoginShell(),
      baseEnvironment: this.#deps.baseEnvironment,
      isScreenReaderModeOn: await this.#deps.readScreenReaderMode(),
      startupFolders: await this.#startupFolders,
      operatingSystem: this.#deps.operatingSystem,
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
    const shell = createShellRecord(
      {
        request,
        programName: start.programName,
        status,
        hostSessionId,
        markNonce: start.markNonce,
      },
      this.#recordHooks,
    );
    session.shells.set(shell.terminalId, shell);
    session.order.push(shell.terminalId);
    if (session.closeHolds > 0) {
      // The session's deletion began while the shell started; it waited for this open, so it ends
      // the shell with the rest and learns if the host will not let it go.
      throw sessionNotFound(request.sessionId);
    }
    if (hostSessionId === null) {
      this.#discardMarkNonce(shell);
    } else {
      shell.unfollowPtySession = this.#deps.followPtySession(hostSessionId, {
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

  #takeOutput(shell: ShellRecord, chunk: Uint8Array): void {
    if (shell.markReader === null) {
      this.#appendOutput(shell, chunk);
      return;
    }
    const { output, marks } = shell.markReader.read(chunk);
    const hasPromptMark = marks.some((mark) => mark.kind === "prompt");
    if (hasPromptMark) {
      shell.hasInputSincePrompt = false;
    }
    if (!shell.isReportingMarks && hasPromptMark) {
      shell.isReportingMarks = true;
      // The shell has read its nonce once it marks a prompt with it.
      this.#discardMarkNonce(shell);
    }
    this.#appendOutput(shell, output);
  }

  #appendOutput(shell: ShellRecord, output: Uint8Array): void {
    if (output.byteLength === 0) {
      return;
    }
    shell.scrollback.append(output);
    shell.outputOffset += output.byteLength;
    shell.screen.write(output);
    for (const stream of shell.streams.values()) {
      stream.deliver(output, shell.outputOffset);
    }
  }

  // An exited shell keeps its record; a prefix its mark reader held is output, its subscriptions
  // get the exit and end with the holds they carried, and the host lets the session go.
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
    shell.unfollowPtySession = null;
    shell.status = { state: "exited", exitCode };
    // An exited shell takes no input, so a paste left open has nothing to close and a question its
    // program left has no one to answer it.
    shell.pastes.clear();
    shell.screen.dispose();
    this.#discardMarkNonce(shell);
    const end = { exitCode, cursor: shell.outputOffset };
    this.#reportFailure(
      this.#endSubscriptions(shell, (stream) => {
        stream.exit(end);
      }),
      `Shell ${shell.terminalId}'s hold could not be released as its program exited`,
    );
    this.#reportFailure(
      this.#deps.host.close(hostSessionId),
      `The terminal host could not let exited shell ${shell.terminalId} go`,
    );
    this.#refreshList(shell.sessionId);
  }

  // Ends a shell's subscriptions and starts releasing the holds they carried before the shell
  // leaves its session, then has the host let the shell go.
  #endShell({ session, shell }: { session: SessionShells; shell: ShellRecord }): ShellEnding {
    shell.pastes.clear();
    shell.screen.dispose();
    const released = this.#endSubscriptions(shell, (stream) => {
      stream.end();
    });
    session.shells.delete(shell.terminalId);
    session.order.splice(session.order.indexOf(shell.terminalId), 1);
    this.#discardMarkNonce(shell);
    this.#refreshList(shell.sessionId);
    this.#forgetIfIdle(shell.sessionId);
    const { hostSessionId } = shell;
    let hostClosed: Promise<void> = Promise.resolve();
    if (hostSessionId !== null) {
      shell.unfollowPtySession?.();
      shell.unfollowPtySession = null;
      shell.hostSessionId = null;
      hostClosed = this.#deps.host.close(hostSessionId);
    }
    return { released, hostClosed };
  }

  // Ends every output subscription of a shell from the daemon's side, `endStream` sending each its
  // last frames, ends their watches, and releases the hold bindings they carried as closed panes;
  // with no change of holder in flight, the release starts in this tick.
  #endSubscriptions(
    shell: ShellRecord,
    endStream: (stream: ShellOutputStream) => void,
  ): Promise<void> {
    const ended = [...shell.streams];
    for (const [subscriptionId, stream] of ended) {
      endStream(stream);
      this.#forgetOutputSubscription(subscriptionId, shell);
    }
    for (const transportId of new Set(ended.map(([, stream]) => stream.transportId))) {
      this.#endWatch(shell, transportId);
    }
    return shell.lease.releaseSubscriptions(ended.map(([subscriptionId]) => subscriptionId));
  }

  // Stops counting a connection as the shell's watcher once none of its subscriptions is left.
  #endWatch(shell: ShellRecord, transportId: number): void {
    if ([...shell.streams.values()].some((stream) => stream.transportId === transportId)) {
      return;
    }
    this.#reportFailure(
      shell.flowControl.removeWatcher(transportId),
      `Shell ${shell.terminalId} could not read again after a watcher left`,
    );
  }

  #discardMarkNonce(shell: ShellRecord): void {
    const { markNonce } = shell;
    if (markNonce === null) {
      return;
    }
    shell.markNonce = null;
    this.#reportFailure(
      discardMarkNonceFile(markNonce),
      `Shell ${shell.terminalId}'s nonce file could not be removed`,
    );
  }

  #forgetOutputSubscription(subscriptionId: SubscriptionId, shell: ShellRecord): void {
    this.#outputSubscriptions.delete(subscriptionId);
    shell.streams.delete(subscriptionId);
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
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const session: SessionShells = {
      order: [],
      shells: new Map(),
      opening: new Map(),
      list: new ShellListFollowers(
        () => this.#readList(sessionId, session),
        (sending) => {
          this.#reportFailure(sending, `The shell list of session ${sessionId} could not be sent`);
        },
      ),
      closeHolds: 0,
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  // A session with no shell, no open under way and no one following its list holds nothing.
  #forgetIfIdle(sessionId: SessionId): void {
    const session = this.#sessions.get(sessionId);
    if (
      session !== undefined &&
      session.shells.size === 0 &&
      session.opening.size === 0 &&
      session.list.followerCount === 0 &&
      session.closeHolds === 0
    ) {
      this.#sessions.delete(sessionId);
    }
  }

  // Marks the session's list changed and sends it to every follower.
  #refreshList(sessionId: SessionId): void {
    this.#sessions.get(sessionId)?.list.markChanged();
  }

  async #readList(sessionId: SessionId, session: SessionShells): Promise<PtyListUpdate> {
    const shells = session.order.flatMap((terminalId) => session.shells.get(terminalId) ?? []);
    const terminals: PtyListEntry[] = await Promise.all(
      shells.map(async (shell) => ({
        terminalId: shell.terminalId,
        title: shell.screen.title ?? shell.programName,
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
