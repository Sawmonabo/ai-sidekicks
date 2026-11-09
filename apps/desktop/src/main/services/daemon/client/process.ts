// Main's side of the client helper: the utility process main forks, connects and closes, the calls
// and streams main makes over its parentPort, the file-path asks it answers for a window, and the
// window ports it hands over. A fork is made when main connects with no helper running, so a
// helper that exits comes back on the supervisor's next start, at its backoff, and each window
// asks for a new port once its old one closes. Every call and stream main holds fails once the
// helper exits.

import { DAEMON_FLUSH_WAIT_MS } from "@ai-sidekicks/client-sdk";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";

import type { FilePathRefOwner } from "#main/bridge/file-path/refs.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";

import type { ClientHelperAnswer } from "#shared/daemon/port-message.js";

import type {
  ClientHelperLinkState,
  ClientHelperToMainMessage,
  MainToClientHelperMessage,
} from "./messages.js";

/** A daemon method main calls: its name and the check its reply must pass. */
export interface MainCallMethod<Response> {
  readonly method: string;
  readonly responseCheck: SchemaCheck<Response>;
}

/** A daemon stream main opens: its name and the check each value must pass. */
export interface MainStreamMethod<Value> {
  readonly method: string;
  readonly emissionCheck: SchemaCheck<Value>;
}

/**
 * What main's own code reaches the daemon through. A call rejects with a {@link DaemonRefusal} for
 * the daemon's or the helper's refusal, and with an `Error` for any other failure, a reply that
 * fails its check among them. A stream's end is told once, unless main closed it first.
 */
export interface MainDaemonClient {
  call<Response>(method: MainCallMethod<Response>, params: unknown): Promise<Response>;
  subscribe<Value>(
    method: MainStreamMethod<Value>,
    params: unknown,
    onValue: (value: Value) => void,
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

/** What the supervisor hears from the helper: the link's state, and the helper's exit. */
export interface ClientHelperListener {
  linkStateChanged(state: ClientHelperLinkState): void;
  exited(): void;
}

/** What the helper's side in main is built over. */
export interface ClientHelperProcessOptions {
  /** Forks the helper. */
  readonly start: () => ClientHelperUtilityProcess;
  /** The connect message, which says whether the helper presents the token. */
  readonly connect: Extract<MainToClientHelperMessage, { readonly kind: "link.connect" }>;
  /** Answers a file-path ask for `window`; throws for one main cannot answer. */
  readonly answerFilePathAsk: (window: FilePathRefOwner, ask: FilePathAsk) => FilePathAnswer;
  /** Records a window port the helper dropped and a file-path ask main could not answer. */
  readonly logWarning: (message: string) => void;
}

/** One call main holds open. */
interface PendingCall {
  readonly settle: (answer: ClientHelperAnswer | undefined) => void;
}

/** One stream main holds open. */
interface OpenStream {
  readonly deliver: (json: string, attachments: readonly Uint8Array[]) => void;
  readonly end: (end: DaemonSubscriptionEnd) => void;
}

/** Main's side of the client helper. */
export class ClientHelperProcess implements MainDaemonClient {
  readonly #options: ClientHelperProcessOptions;
  #helper: ClientHelperUtilityProcess | undefined;
  #listener: ClientHelperListener | undefined;
  #pendingConnect: PromiseWithResolvers<JsonRpcError | undefined> | undefined;
  readonly #calls = new Map<number, PendingCall>();
  readonly #streams = new Map<number, OpenStream>();
  /** Every window that handed main a port, by id, for the file-path asks its calls make. */
  readonly #windows = new Map<number, FilePathRefOwner>();
  /** A window's port held while no helper runs, handed over at the next fork. */
  readonly #heldPorts = new Map<number, ClientHelperPortTransfer>();
  #nextRequestId = 0;
  #isDisposed = false;

  public constructor(options: ClientHelperProcessOptions) {
    this.#options = options;
  }

  /** How long a flush may take before a quit, a stop or a restart goes ahead without it, in ms. */
  public get flushWaitMs(): number {
    return DAEMON_FLUSH_WAIT_MS;
  }

  /** Hear the link's state and the helper's exit; one listener, the supervisor. */
  public listen(listener: ClientHelperListener): void {
    this.#listener = listener;
  }

  /**
   * Connect the helper, forking it first when none runs. Resolves with `undefined` once the link is
   * up, or with the wire's error the connect failed with; rejects when the helper exits first.
   */
  public connect(): Promise<JsonRpcError | undefined> {
    const helper = this.#runningHelper();
    this.#pendingConnect ??= Promise.withResolvers<JsonRpcError | undefined>();
    helper.postMessage(this.#options.connect);
    return this.#pendingConnect.promise;
  }

  /** Close the link the helper holds: its calls and streams end, and the helper keeps running. */
  public closeLink(): void {
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

  public call<Response>(method: MainCallMethod<Response>, params: unknown): Promise<Response> {
    const helper = this.#helper;
    if (helper === undefined) {
      return Promise.reject(new Error(NOT_ANSWERING_MESSAGE));
    }
    const callId = this.#nextRequestId++;
    const answered = Promise.withResolvers<ClientHelperAnswer | undefined>();
    this.#calls.set(callId, { settle: answered.resolve });
    helper.postMessage({ kind: "call", callId, method: method.method, params, attachments: [] });
    return answered.promise.then((answer) => valueOf(method, answer));
  }

  public subscribe<Value>(
    method: MainStreamMethod<Value>,
    params: unknown,
    onValue: (value: Value) => void,
    onEnded: (end: DaemonSubscriptionEnd) => void,
  ): () => void {
    const helper = this.#helper;
    if (helper === undefined) {
      onEnded({ reason: "failed", message: NOT_ANSWERING_MESSAGE });
      return () => undefined;
    }
    const streamId = this.#nextRequestId++;
    this.#streams.set(streamId, {
      deliver: (json, attachments) => {
        const value: unknown = JSON.parse(json);
        if (method.emissionCheck.call({ attachments }, value)) {
          // The check passed, but a call through `.call` keeps no type guard.
          onValue(value as Value);
          return;
        }
        this.#streams.delete(streamId);
        helper.postMessage({ kind: "stream.close", streamId });
        onEnded({
          reason: "failed",
          message: `A ${method.method} value does not match its contract.`,
        });
      },
      end: onEnded,
    });
    helper.postMessage({
      kind: "stream.open",
      streamId,
      method: method.method,
      params,
      attachments: [],
    });
    return () => {
      if (this.#streams.delete(streamId)) {
        this.#helper?.postMessage({ kind: "stream.close", streamId });
      }
    };
  }

  /** The helper running now, forked when none is. */
  #runningHelper(): ClientHelperUtilityProcess {
    if (this.#helper !== undefined) {
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
        this.#streams.get(message.streamId)?.deliver(message.json, message.attachments);
        return;
      case "stream.ended": {
        const stream = this.#streams.get(message.streamId);
        this.#streams.delete(message.streamId);
        stream?.end(message.end);
        return;
      }
      case "link.connected":
        this.#settleConnect(undefined);
        return;
      case "link.connectFailed":
        this.#settleConnect(message.error);
        return;
      case "link.state":
        this.#listener?.linkStateChanged(message.state);
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

  #settleConnect(error: JsonRpcError | undefined): void {
    const pending = this.#pendingConnect;
    this.#pendingConnect = undefined;
    pending?.resolve(error);
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

/**
 * A call's value from its answer, checked against the method's reply contract. `undefined` is a
 * helper that exited before it answered.
 */
function valueOf<Response>(
  method: MainCallMethod<Response>,
  answer: ClientHelperAnswer | undefined,
): Response {
  if (answer === undefined) {
    throw new Error(NOT_ANSWERING_MESSAGE);
  }
  switch (answer.kind) {
    case "call.refused":
      throw new DaemonRefusal(answer.refusal);
    case "call.served": {
      const value: unknown = JSON.parse(answer.json);
      if (!method.responseCheck.call({ attachments: answer.attachments }, value)) {
        throw new Error(`The ${method.method} reply does not match its contract.`);
      }
      // The check passed, but a call through `.call` keeps no type guard.
      return value as Response;
    }
    default:
      throw new Error(answer.kind === "call.failed" ? answer.message : NOT_ANSWERING_MESSAGE);
  }
}
