// The client helper: the desktop's one connection to the daemon, run in its own utility process.
// Main's requests come over the parentPort and each window's over the port main hands the helper
// for it; each passes its channel's method allowlist and the method's params check before the
// addon. A window's call to a method that carries file paths has its tokens swapped for their paths
// by asking main, which keeps them, and main mints tokens for the paths a reply offers. A window
// port that closes cancels every call and stream it left open. Main connects the link and closes
// it; a request waits for the connect under way, and one made once the link is closed fails. The
// link's state goes to main as the addon reports it; the addon pings and times the link itself, so
// the helper keeps no timer.

import type { DaemonClient, StreamEvent, WireReply } from "@ai-sidekicks/client-sdk";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

import { FILE_PATH_METHODS } from "#main/bridge/file-path/relay.js";
import { pageSafeMessage } from "#main/bridge/page-safe-message.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";

import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";

import type {
  ClientHelperLinkState,
  ClientHelperToMainMessage,
  MainToClientHelperMessage,
} from "./messages.js";
import { paramsRefusal, requestRefusal, type ClientHelperChannelKind } from "./method-allowlist.js";

/** What the helper uses of the daemon client the addon connects. */
export type ClientHelperDaemonClient = Pick<
  DaemonClient,
  "call" | "cancelCall" | "subscribe" | "cancelStream" | "close"
>;

/** What the helper uses of the addon: its connect, answering a client or the wire's error. */
export interface ClientHelperAddon {
  connect(
    presentsToken: boolean,
    onState: (state: string) => void,
  ): Promise<{ client?: ClientHelperDaemonClient; error?: JsonRpcError }>;
}

/** A window's port as the helper serves it: Electron's `MessagePortMain`. */
export interface ClientHelperWindowPort {
  on(event: "message", listener: (messageEvent: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: ClientHelperAnswer): void;
  start(): void;
  close(): void;
}

/** The helper's port to main: Electron's `ParentPort` in the utility process. */
export interface ClientHelperParentPort {
  on(
    event: "message",
    listener: (messageEvent: {
      data: MainToClientHelperMessage;
      ports: readonly ClientHelperWindowPort[];
    }) => void,
  ): unknown;
  postMessage(message: ClientHelperToMainMessage): void;
}

/** Serves main and every window main hands a port for, on one connection through `addon`. */
export function serveClientHelper(
  parentPort: ClientHelperParentPort,
  addon: ClientHelperAddon,
): void {
  const helper = new ClientHelper(parentPort, addon);
  parentPort.on("message", ({ data, ports }) => {
    helper.receiveFromMain(data, ports);
  });
}

/**
 * Where the link stands for a request: the client, the wire's error a failed connect answers every
 * request with, or closed by main, which fails every request until the next connect.
 */
type LinkOutcome =
  | { readonly client: ClientHelperDaemonClient }
  | { readonly error: JsonRpcError }
  | { readonly isClosed: true };

/** The link main closed. */
const CLOSED_LINK: LinkOutcome = Object.freeze({ isClosed: true as const });

/** A file-path answer from main, by the kind the helper waits for. */
type FilePathAnswer = Extract<MainToClientHelperMessage, { readonly kind: `filePaths.${string}` }>;

/** One call an asker holds open: the client it went to and the addon's id, once it has them. */
interface HeldCall {
  addon: { readonly client: ClientHelperDaemonClient; readonly callId: number } | undefined;
  isCanceled: boolean;
}

/**
 * One stream an asker holds open: the client it went to and the addon's id, once the subscribe
 * answered. A cancel goes to that client, since a later link numbers its own streams afresh.
 */
interface HeldStream {
  addon: { readonly client: ClientHelperDaemonClient; readonly streamId: number } | undefined;
  /** Events the addon sent before the subscribe's answer was told, in order. */
  readonly early: StreamEvent[];
  isOpened: boolean;
}

/** One asker: main, or a window by its id, with the calls and streams it holds open. */
class Channel {
  public readonly calls = new Map<number, HeldCall>();
  public readonly streams = new Map<number, HeldStream>();
  public isClosed = false;

  public constructor(
    public readonly windowId: number | undefined,
    public readonly post: (answer: ClientHelperAnswer) => void,
  ) {}

  /** Which allowlist the channel's requests pass. */
  public get kind(): ClientHelperChannelKind {
    return this.windowId === undefined ? "main" : "window";
  }
}

/** The helper's state: the link, main's channel, and the asks main has yet to answer. */
class ClientHelper {
  readonly #parentPort: ClientHelperParentPort;
  readonly #addon: ClientHelperAddon;
  readonly #mainChannel: Channel;
  /** The connect requests wait on while none has settled since main last asked for one. */
  #pendingLink = Promise.withResolvers<LinkOutcome>();
  #linkOutcome: LinkOutcome | undefined;
  #isConnecting = false;
  /** Counts connects and closes, so a state the addon reports for a closed link is not told. */
  #linkGeneration = 0;
  readonly #asks = new Map<number, (answer: FilePathAnswer) => void>();
  #nextAskId = 0;
  #nextAddonCallId = 0;

  public constructor(parentPort: ClientHelperParentPort, addon: ClientHelperAddon) {
    this.#parentPort = parentPort;
    this.#addon = addon;
    this.#mainChannel = new Channel(undefined, (answer) => {
      parentPort.postMessage(answer);
    });
  }

  /** Acts on one message from main; a window's port arrives in `ports`. */
  public receiveFromMain(
    message: MainToClientHelperMessage,
    ports: readonly ClientHelperWindowPort[],
  ): void {
    switch (message.kind) {
      case "link.connect":
        this.#startConnect(!(message.isPackaged && message.platform === "darwin"));
        return;
      case "link.close":
        void this.#closeLink();
        return;
      case "window.port":
        for (const port of ports) {
          this.#serveWindow(message.windowId, port);
        }
        return;
      case "filePaths.swapped":
      case "filePaths.swapRefused":
      case "filePaths.minted": {
        const settle = this.#asks.get(message.askId);
        this.#asks.delete(message.askId);
        settle?.(message);
        return;
      }
      default:
        this.#receive(this.#mainChannel, message);
    }
  }

  /** Connects unless a connect is under way or a client is held. */
  #startConnect(presentsToken: boolean): void {
    if (this.#isConnecting || (this.#linkOutcome !== undefined && "client" in this.#linkOutcome)) {
      return;
    }
    if (this.#linkOutcome !== undefined) {
      this.#linkOutcome = undefined;
      this.#pendingLink = Promise.withResolvers<LinkOutcome>();
    }
    this.#isConnecting = true;
    void this.#connect(presentsToken);
  }

  async #connect(presentsToken: boolean): Promise<void> {
    const generation = ++this.#linkGeneration;
    const connected = await this.#addon.connect(presentsToken, (state) => {
      if (generation !== this.#linkGeneration) {
        return;
      }
      // The addon reports only the four states it names.
      this.#parentPort.postMessage({ kind: "link.state", state: state as ClientHelperLinkState });
    });
    this.#isConnecting = false;
    const outcome: LinkOutcome =
      connected.client === undefined
        ? { error: wireErrorOf(connected.error) }
        : { client: connected.client };
    this.#parentPort.postMessage(
      "client" in outcome
        ? { kind: "link.connected" }
        : { kind: "link.connectFailed", error: outcome.error },
    );
    this.#settleLink(outcome);
  }

  /** Closes the client held: every call and stream on it ends, and later requests fail. */
  async #closeLink(): Promise<void> {
    const outcome = this.#linkOutcome;
    if (outcome === undefined || !("client" in outcome)) {
      return;
    }
    this.#linkGeneration += 1;
    this.#settleLink(CLOSED_LINK);
    await outcome.client.close();
  }

  #settleLink(outcome: LinkOutcome): void {
    this.#linkOutcome = outcome;
    this.#pendingLink.resolve(outcome);
  }

  /** The link a request goes over: the one settled, or the connect under way. */
  #link(): Promise<LinkOutcome> {
    return this.#linkOutcome === undefined
      ? this.#pendingLink.promise
      : Promise.resolve(this.#linkOutcome);
  }

  #serveWindow(windowId: number, port: ClientHelperWindowPort): void {
    const channel = new Channel(windowId, (answer) => {
      port.postMessage(answer);
    });
    port.on("message", ({ data }) => {
      const request = readWindowRequest(data);
      if (request === undefined || isOpenedTwice(channel, request)) {
        this.#parentPort.postMessage({
          kind: "window.portDropped",
          windowId,
          reason: "The window sent a message that is not a daemon request, or reused an open id.",
        });
        port.close();
        this.#closeChannel(channel);
        return;
      }
      this.#receive(channel, request);
    });
    port.on("close", () => {
      this.#closeChannel(channel);
    });
    port.start();
  }

  #receive(channel: Channel, request: ClientHelperRequest): void {
    switch (request.kind) {
      case "call":
        void this.#call(channel, request);
        return;
      case "call.cancel":
        this.#cancelCall(channel, request.callId);
        return;
      case "stream.open":
        void this.#openStream(channel, request);
        return;
      case "stream.close":
        this.#closeStream(channel, request.streamId);
        return;
    }
  }

  async #call(
    channel: Channel,
    request: Extract<ClientHelperRequest, { readonly kind: "call" }>,
  ): Promise<void> {
    const { callId, method } = request;
    const refusal = requestRefusal(
      channel.kind,
      method,
      request.params,
      request.attachments,
      false,
    );
    if (refusal !== undefined) {
      channel.post({ kind: "call.refused", callId, refusal });
      return;
    }
    const held: HeldCall = { addon: undefined, isCanceled: false };
    channel.calls.set(callId, held);
    let params = request.params;
    let replyAsk: number | undefined;
    if (channel.windowId !== undefined && FILE_PATH_METHODS.has(method)) {
      const askId = this.#nextAskId++;
      const swap = await this.#askMain<"filePaths.swapped" | "filePaths.swapRefused">({
        kind: "filePaths.swap",
        askId,
        windowId: channel.windowId,
        method,
        params,
      });
      if (swap.kind === "filePaths.swapRefused") {
        this.#settleCall(channel, callId, {
          kind: "call.refused",
          callId,
          refusal: paramsRefusal(method, swap.issues),
        });
        return;
      }
      params = swap.params;
      replyAsk = swap.readsReply ? askId : undefined;
    }
    const link = await this.#link();
    if (channel.isClosed) {
      return;
    }
    if ("isClosed" in link) {
      this.#settleCall(channel, callId, {
        kind: "call.failed",
        callId,
        message: NOT_ANSWERING_MESSAGE,
      });
      return;
    }
    if ("error" in link) {
      this.#settleCall(channel, callId, { kind: "call.refused", callId, refusal: link.error });
      return;
    }
    const addonCallId = this.#nextAddonCallId;
    this.#nextAddonCallId = (addonCallId + 1) % 2 ** 32;
    let answer: ClientHelperAnswer;
    try {
      const outcome = link.client.call(
        addonCallId,
        method,
        JSON.stringify(params),
        request.attachments.map(bufferOf),
      );
      held.addon = { client: link.client, callId: addonCallId };
      // A cancel that came while the call waited reaches it now, so the addon settles it canceled.
      if (held.isCanceled) {
        link.client.cancelCall(addonCallId);
      }
      const { reply, error } = await outcome;
      answer =
        reply === undefined
          ? { kind: "call.refused", callId, refusal: wireErrorOf(error) }
          : await this.#served(channel, callId, method, params, reply, replyAsk);
    } catch (failure) {
      answer = {
        kind: "call.failed",
        callId,
        message: pageSafeMessage(failure, NOT_ANSWERING_MESSAGE),
      };
    }
    this.#settleCall(channel, callId, answer);
  }

  /** A served reply, with the tokens main minted for the paths it offers when the swap said so. */
  async #served(
    channel: Channel,
    callId: number,
    method: string,
    params: unknown,
    reply: WireReply,
    replyAsk: number | undefined,
  ): Promise<ClientHelperAnswer> {
    const served = {
      kind: "call.served",
      callId,
      json: reply.json,
      attachments: reply.attachments,
    } as const;
    if (replyAsk === undefined || channel.windowId === undefined) {
      return served;
    }
    const minted = await this.#askMain<"filePaths.minted">({
      kind: "filePaths.mint",
      askId: replyAsk,
      windowId: channel.windowId,
      method,
      params,
      value: JSON.parse(reply.json),
    });
    return { ...served, fileRefs: minted.fileRefs };
  }

  #settleCall(channel: Channel, callId: number, answer: ClientHelperAnswer): void {
    if (channel.isClosed || !channel.calls.delete(callId)) {
      return;
    }
    channel.post(answer);
  }

  #cancelCall(channel: Channel, callId: number): void {
    const held = channel.calls.get(callId);
    if (held === undefined) {
      return;
    }
    held.isCanceled = true;
    held.addon?.client.cancelCall(held.addon.callId);
  }

  async #openStream(
    channel: Channel,
    request: Extract<ClientHelperRequest, { readonly kind: "stream.open" }>,
  ): Promise<void> {
    const { streamId, method } = request;
    const refusal = requestRefusal(channel.kind, method, request.params, request.attachments, true);
    if (refusal !== undefined) {
      channel.post({ kind: "stream.ended", streamId, end: { reason: "refused", refusal } });
      return;
    }
    const held: HeldStream = { addon: undefined, early: [], isOpened: false };
    channel.streams.set(streamId, held);
    const link = await this.#link();
    if ("isClosed" in link) {
      this.#endStream(channel, streamId, held, {
        reason: "failed",
        message: NOT_ANSWERING_MESSAGE,
      });
      return;
    }
    if ("error" in link) {
      this.#endStream(channel, streamId, held, { reason: "refused", refusal: link.error });
      return;
    }
    try {
      const opened = await link.client.subscribe(
        method,
        JSON.stringify(request.params),
        request.attachments.map(bufferOf),
        (event) => {
          if (held.isOpened) {
            this.#deliver(channel, streamId, held, event);
          } else {
            held.early.push(event);
          }
        },
      );
      if (opened.streamId === undefined || opened.acknowledgment === undefined) {
        this.#endStream(channel, streamId, held, {
          reason: "refused",
          refusal: wireErrorOf(opened.error),
        });
        return;
      }
      held.addon = { client: link.client, streamId: opened.streamId };
      if (channel.isClosed || channel.streams.get(streamId) !== held) {
        link.client.cancelStream(opened.streamId);
        return;
      }
      channel.post({
        kind: "stream.opened",
        streamId,
        json: opened.acknowledgment.json,
        attachments: opened.acknowledgment.attachments,
      });
      held.isOpened = true;
      for (const event of held.early.splice(0)) {
        this.#deliver(channel, streamId, held, event);
      }
    } catch (failure) {
      this.#endStream(channel, streamId, held, {
        reason: "failed",
        message: pageSafeMessage(failure, NOT_ANSWERING_MESSAGE),
      });
    }
  }

  /** Hands one of the addon's stream events to the asker while it still holds the stream. */
  #deliver(channel: Channel, streamId: number, held: HeldStream, event: StreamEvent): void {
    if (event.isEnd) {
      this.#endStream(
        channel,
        streamId,
        held,
        event.error === undefined
          ? { reason: "completed" }
          : { reason: "refused", refusal: wireErrorOf(event.error) },
      );
      return;
    }
    if (event.value !== undefined && !channel.isClosed && channel.streams.get(streamId) === held) {
      channel.post({
        kind: "stream.value",
        streamId,
        json: event.value.json,
        attachments: event.value.attachments,
      });
    }
  }

  /** Tells the asker once how a stream it still holds ended. */
  #endStream(
    channel: Channel,
    streamId: number,
    held: HeldStream,
    end: DaemonSubscriptionEnd,
  ): void {
    if (channel.isClosed || channel.streams.get(streamId) !== held) {
      return;
    }
    channel.streams.delete(streamId);
    channel.post({ kind: "stream.ended", streamId, end });
  }

  #closeStream(channel: Channel, streamId: number): void {
    const held = channel.streams.get(streamId);
    if (held === undefined) {
      return;
    }
    channel.streams.delete(streamId);
    this.#cancelAddonStream(held);
  }

  /** Cancels a stream at the addon once it has an id; one still opening is canceled as it opens. */
  #cancelAddonStream(held: HeldStream): void {
    held.addon?.client.cancelStream(held.addon.streamId);
  }

  /** A window's port closed: every call and stream it held is canceled, and nothing more is told. */
  #closeChannel(channel: Channel): void {
    if (channel.isClosed) {
      return;
    }
    channel.isClosed = true;
    for (const held of channel.calls.values()) {
      held.isCanceled = true;
      held.addon?.client.cancelCall(held.addon.callId);
    }
    channel.calls.clear();
    for (const held of channel.streams.values()) {
      this.#cancelAddonStream(held);
    }
    channel.streams.clear();
  }

  /**
   * Sends main one file-path ask and resolves with its answer, of the kinds `Kind` names: main
   * answers a swap with `swapped` or `swapRefused` and a mint with `minted`.
   */
  #askMain<Kind extends FilePathAnswer["kind"]>(
    ask: Extract<ClientHelperToMainMessage, { readonly kind: `filePaths.${string}` }>,
  ): Promise<Extract<FilePathAnswer, { readonly kind: Kind }>> {
    const answered = Promise.withResolvers<Extract<FilePathAnswer, { readonly kind: Kind }>>();
    this.#asks.set(ask.askId, answered.resolve as (answer: FilePathAnswer) => void);
    this.#parentPort.postMessage(ask);
    return answered.promise;
  }
}

/** The addon's bytes for one attachment, over the same memory. */
function bufferOf(attachment: Uint8Array): Buffer {
  return Buffer.from(attachment.buffer, attachment.byteOffset, attachment.byteLength);
}

/** The addon's error, which is already in the wire's shape, kept to its code, message and data. */
function wireErrorOf(error: unknown): JsonRpcError {
  const { code, message, data } = error as JsonRpcError;
  return data === undefined ? { code, message } : { code, message, data };
}

/** A window's message read as a request, or `undefined` for anything else. */
function readWindowRequest(data: unknown): ClientHelperRequest | undefined {
  if (data === null || typeof data !== "object") {
    return undefined;
  }
  const message = data as Record<string, unknown>;
  switch (message["kind"]) {
    case "call":
      return isId(message["callId"]) && isRequestBody(message)
        ? (message as ClientHelperRequest)
        : undefined;
    case "stream.open":
      return isId(message["streamId"]) && isRequestBody(message)
        ? (message as ClientHelperRequest)
        : undefined;
    case "call.cancel":
      return isId(message["callId"]) ? (message as ClientHelperRequest) : undefined;
    case "stream.close":
      return isId(message["streamId"]) ? (message as ClientHelperRequest) : undefined;
    default:
      return undefined;
  }
}

/** Whether `request` opens a call or stream under an id its asker already holds open. */
function isOpenedTwice(channel: Channel, request: ClientHelperRequest): boolean {
  switch (request.kind) {
    case "call":
      return channel.calls.has(request.callId);
    case "stream.open":
      return channel.streams.has(request.streamId);
    default:
      return false;
  }
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRequestBody(message: Record<string, unknown>): boolean {
  const attachments = message["attachments"];
  return (
    typeof message["method"] === "string" &&
    Array.isArray(attachments) &&
    attachments.every((attachment) => attachment instanceof Uint8Array)
  );
}
