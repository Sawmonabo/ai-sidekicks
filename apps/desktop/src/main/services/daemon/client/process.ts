// Main's side of the client helper: the utility process main forks, connects and closes, the calls
// and streams main makes over its parentPort, the service's ending and the process identity reads
// it asks the helper for, the file-path asks it answers for a window, and the window ports it
// hands over. A fork is made when main connects or asks with no helper running, so a helper that
// exits comes back on the supervisor's next start, at its backoff, or before main's next ask, and
// each window asks for a new port once its old one closes. Every call, stream and ask main holds
// fails once the helper exits. Once disposed at quit nothing is forked again, and a connect or an
// ask is refused. Main loads no addon: the helper reports the client's bounds.

import type { DaemonEndingOutcome, DaemonEndingRequest } from "@ai-sidekicks/client-sdk";
import type { DaemonRepairingDetails } from "@ai-sidekicks/contracts/daemon/recovery";
import type { DaemonCannotStart } from "@ai-sidekicks/contracts/daemon/service-status";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { ConnectionInitializeResponse } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import type { FilePathRefOwner } from "#main/bridge/file-path/refs.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";

import type { ClientHelperAnswer } from "#shared/daemon/port-message.js";

import type {
  ClientHelperFacts,
  ClientHelperLinkState,
  ClientHelperServiceAsk,
  ClientHelperToMainMessage,
  MainToClientHelperMessage,
} from "./messages.js";
import type { MainMethodTypes } from "./method-allowlist.js";

/** Why a connect or an ask made after the quit let the helper go is refused. */
const HELPER_ENDED_MESSAGE = "The client helper has ended for the quit.";

/** A daemon stream main opens, by its wire name. */
export type MainStreamMethod = {
  [Method in keyof MainMethodTypes]: MainMethodTypes[Method] extends { readonly emission: unknown }
    ? Method
    : never;
}[keyof MainMethodTypes];

/** One value the stream `Method` delivers, as its generated table states it. */
export type MainStreamValue<Method extends MainStreamMethod> = (MainMethodTypes[Method] & {
  readonly emission: unknown;
})["emission"];

/**
 * What main's own code reaches the daemon through, each reply and value read as its method's
 * generated type. A call rejects with a {@link DaemonRefusal} for the daemon's or the helper's
 * refusal, and with an `Error` for any other failure. A stream's end is told once, unless main
 * closed it first.
 */
export interface MainDaemonClient {
  call<Method extends keyof MainMethodTypes>(
    method: Method,
    params: unknown,
  ): Promise<MainMethodTypes[Method]["result"]>;
  subscribe<Method extends MainStreamMethod>(
    method: Method,
    params: unknown,
    onValue: (value: MainStreamValue<Method>) => void,
    onEnded: (end: DaemonSubscriptionEnd) => void,
  ): () => void;
}

/** A refusal in the wire's error shape, as a call main made rejects with it. */
export class DaemonRefusal extends Error {
  public readonly refusal: JsonRpcError;

  public constructor(refusal: JsonRpcError) {
    super(refusal.message);
    this.name = "DaemonRefusal";
    this.refusal = refusal;
  }
}

/** The helper's answer that a service ask threw in the addon, as the ask rejects with it. */
export class ServiceAskFailed extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServiceAskFailed";
  }
}

/** The part of Electron's `UtilityProcess` main drives the helper through. */
export interface ClientHelperUtilityProcess {
  postMessage(message: MainToClientHelperMessage, transfer?: ClientHelperPortTransfer[]): void;
  on(event: "message", listener: (message: ClientHelperToMainMessage) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

/** A window's end of its port to the helper: Electron's `MessagePortMain`. */
export interface ClientHelperPortTransfer {
  close(): void;
}

/** A file-path ask the helper sends for one window's call. */
export type FilePathAsk = Extract<
  ClientHelperToMainMessage,
  { readonly kind: "filePaths.swap" | "filePaths.mint" }
>;

/** Main's answer to a file-path ask. */
export type FilePathAnswer = Extract<
  MainToClientHelperMessage,
  { readonly kind: "filePaths.swapped" | "filePaths.swapRefused" | "filePaths.minted" }
>;

/**
 * What the supervisor hears from the helper: the link's state, a starting daemon's answers that it
 * is repairing its database file, and the helper's exit.
 */
export interface ClientHelperListener {
  linkStateChanged(state: ClientHelperLinkState): void;
  repairing(details: DaemonRepairingDetails): void;
  exited(): void;
}

/**
 * A connect's outcome: the daemon's answer to the handshake once the link is up, or the error and,
 * when the failure says, why the service cannot start.
 */
export type ClientHelperConnectOutcome =
  | { readonly initializeResponse: ConnectionInitializeResponse }
  | { readonly error: JsonRpcError; readonly cannotStart?: DaemonCannotStart };

/** What the helper's side in main is built over. */
export interface ClientHelperProcessOptions {
  /** Forks the helper. */
  readonly start: () => ClientHelperUtilityProcess;
  /** Whether the helper's handshake presents the token file's token. */
  readonly presentsToken: boolean;
  /** Answers a file-path ask for `window`; throws for one main cannot answer. */
  readonly answerFilePathAsk: (window: FilePathRefOwner, ask: FilePathAsk) => FilePathAnswer;
  /**
   * Records a window port the helper dropped, a file-path ask main could not answer and a flow
   * update of the helper's own the daemon did not take.
   */
  readonly logWarning: (message: string) => void;
}

/** One call main holds open. */
interface PendingCall {
  readonly settle: (answer: ClientHelperAnswer | undefined) => void;
}

/** One stream main holds open. */
interface OpenStream {
  readonly deliver: (json: string) => void;
  readonly end: (end: DaemonSubscriptionEnd) => void;
}

/** Main's side of the client helper. */
export class ClientHelperProcess implements MainDaemonClient {
  readonly #options: ClientHelperProcessOptions;
  #helper: ClientHelperUtilityProcess | undefined;
  #listener: ClientHelperListener | undefined;
  #pendingConnect: PromiseWithResolvers<ClientHelperConnectOutcome> | undefined;
  readonly #calls = new Map<number, PendingCall>();
  readonly #streams = new Map<number, OpenStream>();
  /** The endings main asked for and the helper has yet to answer, by ask id. */
  readonly #endings = new Map<number, PromiseWithResolvers<DaemonEndingOutcome>>();
  /** The process identity reads main asked for and the helper has yet to answer, by ask id. */
  readonly #identityReads = new Map<number, PromiseWithResolvers<ProcessIdentity | undefined>>();
  /** What the first helper reported at start; the client's bounds never change. */
  #facts: ClientHelperFacts | undefined;
  #pendingFacts: PromiseWithResolvers<ClientHelperFacts> | undefined;
  /** Every window that handed main a port, by id, for the file-path asks its calls make. */
  readonly #windows = new Map<number, FilePathRefOwner>();
  /** A window's port held while no helper runs, handed over at the next fork. */
  readonly #heldPorts = new Map<number, ClientHelperPortTransfer>();
  #nextRequestId = 0;
  #nextAskId = 0;
  #isDisposed = false;

  public constructor(options: ClientHelperProcessOptions) {
    this.#options = options;
  }

  /**
   * How long a flush may take before a quit goes ahead without it, in ms. Before the helper first
   * reports, no link has been up and no ending runs, so a quit then has nothing to wait for.
   */
  public get flushWaitMs(): number {
    return this.#facts?.flushWaitMs ?? 0;
  }

  /**
   * The client's bounds and the status file's place, as the helper reported them at start; forks
   * the helper when none has reported yet. Rejects when it exits first, or once disposed.
   */
  public facts(): Promise<ClientHelperFacts> {
    if (this.#facts !== undefined) {
      return Promise.resolve(this.#facts);
    }
    if (this.#runningHelper() === undefined) {
      return Promise.reject(new Error(HELPER_ENDED_MESSAGE));
    }
    this.#pendingFacts ??= Promise.withResolvers<ClientHelperFacts>();
    return this.#pendingFacts.promise;
  }

  /**
   * End the service through the client's one ending: the flush, `request`, the drain bound, then
   * the terminate signal and the kill. Resolves once the service has ended, or with the error.
   */
  public endDaemon(request: DaemonEndingRequest): Promise<DaemonEndingOutcome> {
    return this.#askService(this.#endings, (askId) => ({
      kind: "daemon.end",
      askId,
      request,
      presentsToken: this.#options.presentsToken,
    }));
  }

  /**
   * End the service process `identity` names at once, as one whose link died or that never
   * answered: the terminate signal, and the kill once the drain bound and its grace have passed.
   */
  public endDaemonProcess(identity: ProcessIdentity): Promise<DaemonEndingOutcome> {
    return this.#askService(this.#endings, (askId) => ({
      kind: "daemon.endProcess",
      askId,
      identity,
    }));
  }

  /**
   * The identity of the process `processId` names now, or `undefined` when no process holds it.
   * Rejects with the system's error.
   */
  public readProcessIdentity(processId: number): Promise<ProcessIdentity | undefined> {
    return this.#askService(this.#identityReads, (askId) => ({
      kind: "process.identityRead",
      askId,
      processId,
    }));
  }

  /** Hear the link's state and the helper's exit; one listener, the supervisor. */
  public listen(listener: ClientHelperListener): void {
    this.#listener = listener;
  }

  /**
   * Connect the helper, forking it first when none runs; `waitsForStart` waits for a daemon that is
   * starting, within the client's handshake deadline, rather than trying once. Resolves with the
   * daemon's handshake answer once the link is up, or with the wire's error the connect failed
   * with; rejects when the helper exits first, or once disposed.
   */
  public connect(waitsForStart: boolean): Promise<ClientHelperConnectOutcome> {
    const helper = this.#runningHelper();
    if (helper === undefined) {
      return Promise.reject(new Error(HELPER_ENDED_MESSAGE));
    }
    this.#pendingConnect ??= Promise.withResolvers<ClientHelperConnectOutcome>();
    helper.postMessage({
      kind: "link.connect",
      presentsToken: this.#options.presentsToken,
      waitsForStart,
    });
    return this.#pendingConnect.promise;
  }

  /**
   * Close the link the helper holds: its calls and streams end, a connect under way is dropped
   * unsettled, and the helper keeps running.
   */
  public closeLink(): void {
    this.#pendingConnect = undefined;
    this.#helper?.postMessage({ kind: "link.close" });
  }

  /** End the helper for good, at quit: nothing is forked again. */
  public dispose(): void {
    this.#isDisposed = true;
    for (const port of this.#heldPorts.values()) {
      port.close();
    }
    this.#heldPorts.clear();
    this.#helper?.kill();
  }

  /**
   * Hand `window`'s port to the helper, or hold it until the next fork. A window that asks again
   * replaces the port it held.
   */
  public adoptWindowPort(window: FilePathRefOwner, port: ClientHelperPortTransfer): void {
    if (this.#isDisposed || window.isDestroyed()) {
      port.close();
      return;
    }
    if (!this.#windows.has(window.id)) {
      this.#windows.set(window.id, window);
      window.once("destroyed", () => {
        this.#windows.delete(window.id);
        this.#heldPorts.get(window.id)?.close();
        this.#heldPorts.delete(window.id);
      });
    }
    if (this.#helper === undefined) {
      this.#heldPorts.get(window.id)?.close();
      this.#heldPorts.set(window.id, port);
      return;
    }
    this.#helper.postMessage({ kind: "window.port", windowId: window.id }, [port]);
  }

  public call<Method extends keyof MainMethodTypes>(
    method: Method,
    params: unknown,
  ): Promise<MainMethodTypes[Method]["result"]> {
    const helper = this.#helper;
    if (helper === undefined) {
      return Promise.reject(new Error(NOT_ANSWERING_MESSAGE));
    }
    const callId = this.#nextRequestId++;
    const answered = Promise.withResolvers<ClientHelperAnswer | undefined>();
    this.#calls.set(callId, { settle: answered.resolve });
    helper.postMessage({ kind: "call", callId, method, params, attachments: [] });
    return answered.promise.then((answer) => valueOf(answer) as MainMethodTypes[Method]["result"]);
  }

  public subscribe<Method extends MainStreamMethod>(
    method: Method,
    params: unknown,
    onValue: (value: MainStreamValue<Method>) => void,
    onEnded: (end: DaemonSubscriptionEnd) => void,
  ): () => void {
    const helper = this.#helper;
    if (helper === undefined) {
      onEnded({ reason: "failed", message: NOT_ANSWERING_MESSAGE });
      return () => undefined;
    }
    const streamId = this.#nextRequestId++;
    this.#streams.set(streamId, {
      deliver: (json) => {
        onValue(JSON.parse(json) as MainStreamValue<Method>);
      },
      end: onEnded,
    });
    helper.postMessage({
      kind: "stream.open",
      streamId,
      method,
      params,
      attachments: [],
    });
    return () => {
      if (this.#streams.delete(streamId)) {
        this.#helper?.postMessage({ kind: "stream.close", streamId });
      }
    };
  }

  /**
   * Sends the helper the ask `askOf` builds, forking it first when none runs, and holds it in
   * `pending` until the helper answers or exits; refused once disposed.
   */
  #askService<Answer>(
    pending: Map<number, PromiseWithResolvers<Answer>>,
    askOf: (askId: number) => ClientHelperServiceAsk,
  ): Promise<Answer> {
    const helper = this.#runningHelper();
    if (helper === undefined) {
      return Promise.reject(new Error(HELPER_ENDED_MESSAGE));
    }
    const askId = this.#nextAskId++;
    const answered = Promise.withResolvers<Answer>();
    pending.set(askId, answered);
    helper.postMessage(askOf(askId));
    return answered.promise;
  }

  /** The helper running now, forked when none is; `undefined` once disposed, forking nothing. */
  #runningHelper(): ClientHelperUtilityProcess | undefined {
    if (this.#helper !== undefined || this.#isDisposed) {
      return this.#helper;
    }
    const helper = this.#options.start();
    this.#helper = helper;
    helper.on("message", (message) => {
      this.#receive(helper, message);
    });
    helper.on("exit", () => {
      this.#exited(helper);
    });
    for (const [windowId, port] of this.#heldPorts) {
      helper.postMessage({ kind: "window.port", windowId }, [port]);
    }
    this.#heldPorts.clear();
    return helper;
  }

  #receive(helper: ClientHelperUtilityProcess, message: ClientHelperToMainMessage): void {
    switch (message.kind) {
      case "call.served":
      case "call.refused":
      case "call.failed": {
        const pending = this.#calls.get(message.callId);
        this.#calls.delete(message.callId);
        pending?.settle(message);
        return;
      }
      case "stream.opened":
        return;
      case "stream.value":
        this.#streams.get(message.streamId)?.deliver(message.json);
        return;
      case "stream.ended": {
        const stream = this.#streams.get(message.streamId);
        this.#streams.delete(message.streamId);
        stream?.end(message.end);
        return;
      }
      case "link.connected":
        this.#settleConnect({ initializeResponse: message.initializeResponse });
        return;
      case "link.connectFailed":
        this.#settleConnect(
          message.cannotStart === undefined
            ? { error: message.error }
            : { error: message.error, cannotStart: message.cannotStart },
        );
        return;
      case "helper.started": {
        this.#facts ??= message;
        const pending = this.#pendingFacts;
        this.#pendingFacts = undefined;
        pending?.resolve(this.#facts);
        return;
      }
      case "daemon.ended":
        takeAsk(this.#endings, message.askId)?.resolve(message.outcome);
        return;
      case "process.identity":
        takeAsk(this.#identityReads, message.askId)?.resolve(message.identity);
        return;
      case "process.identityRefused":
        takeAsk(this.#identityReads, message.askId)?.reject(new Error(message.error));
        return;
      case "service.askFailed":
        (
          takeAsk(this.#endings, message.askId) ?? takeAsk(this.#identityReads, message.askId)
        )?.reject(new ServiceAskFailed(message.error));
        return;
      case "link.state":
        this.#listener?.linkStateChanged(message.state);
        return;
      case "link.repairing":
        this.#listener?.repairing(message.details);
        return;
      case "filePaths.swap":
      case "filePaths.mint":
        helper.postMessage(this.#answerFilePathAsk(message));
        return;
      case "window.portDropped":
        this.#options.logWarning(
          `The client helper dropped window ${String(message.windowId)}'s port: ${message.reason}`,
        );
        return;
      case "flowControl.failed":
        this.#options.logWarning(
          `The client helper's flow update for a shell was not taken: ${message.message}`,
        );
        return;
    }
  }

  /**
   * Main's answer to one file-path ask. A window that has gone, or an answer main could not make,
   * refuses a swap and mints nothing, so the helper's call settles rather than waiting.
   */
  #answerFilePathAsk(ask: FilePathAsk): FilePathAnswer {
    const window = this.#windows.get(ask.windowId);
    try {
      if (window === undefined || window.isDestroyed()) {
        throw new Error("The window that made the call has closed.");
      }
      return this.#options.answerFilePathAsk(window, ask);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.#options.logWarning(`A file-path ask for ${ask.method} was not answered: ${message}`);
      return ask.kind === "filePaths.swap"
        ? { kind: "filePaths.swapRefused", askId: ask.askId, issues: [{ path: [], message }] }
        : { kind: "filePaths.minted", askId: ask.askId, fileRefs: {} };
    }
  }

  #settleConnect(outcome: ClientHelperConnectOutcome): void {
    const pending = this.#pendingConnect;
    this.#pendingConnect = undefined;
    pending?.resolve(outcome);
  }

  /** The helper exited: everything main held on it fails once, and the supervisor is told. */
  #exited(helper: ClientHelperUtilityProcess): void {
    if (this.#helper !== helper) {
      return;
    }
    this.#helper = undefined;
    const pendingConnect = this.#pendingConnect;
    this.#pendingConnect = undefined;
    pendingConnect?.reject(new Error("The client helper exited before it connected."));
    const pendingFacts = this.#pendingFacts;
    this.#pendingFacts = undefined;
    pendingFacts?.reject(new Error("The client helper exited before it started."));
    const asks = [...this.#endings.values(), ...this.#identityReads.values()];
    this.#endings.clear();
    this.#identityReads.clear();
    for (const ask of asks) {
      ask.reject(new Error("The client helper exited before it answered."));
    }
    const calls = [...this.#calls.values()];
    this.#calls.clear();
    for (const call of calls) {
      call.settle(undefined);
    }
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const stream of streams) {
      stream.end({ reason: "failed", message: NOT_ANSWERING_MESSAGE });
    }
    if (!this.#isDisposed) {
      this.#listener?.exited();
    }
  }
}

/** Takes the ask `askId` out of `pending`, which holds it until the helper answers. */
function takeAsk<Answer>(
  pending: Map<number, PromiseWithResolvers<Answer>>,
  askId: number,
): PromiseWithResolvers<Answer> | undefined {
  const ask = pending.get(askId);
  pending.delete(askId);
  return ask;
}

/** A call's value from its answer; `undefined` is a helper that exited before it answered. */
function valueOf(answer: ClientHelperAnswer | undefined): unknown {
  if (answer === undefined) {
    throw new Error(NOT_ANSWERING_MESSAGE);
  }
  switch (answer.kind) {
    case "call.refused":
      throw new DaemonRefusal(answer.refusal);
    case "call.served":
      return JSON.parse(answer.json) as unknown;
    default:
      throw new Error(answer.kind === "call.failed" ? answer.message : NOT_ANSWERING_MESSAGE);
  }
}
