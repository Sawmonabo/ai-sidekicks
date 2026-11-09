// The client helper: the desktop's one connection to the daemon, run in its own utility process.
// Main's requests come over the parentPort and each window's over the port main hands the helper
// for it; both pass the one method allowlist and the method's params check before the addon. A
// window's call has its file tokens swapped for their paths by asking main, which keeps them, and
// main mints tokens for the paths a reply offers. A window port that closes cancels every call and
// stream it left open. The link's state goes to main as the addon reports it; the addon pings and
// times the link itself, so the helper keeps no timer.

import type { DaemonClient, StreamEvent, WireReply } from "@ai-sidekicks/client-sdk";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";

import { pageSafeMessage } from "#main/bridge/page-safe-message.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";

import type {
  ClientHelperAnswer,
  ClientHelperLinkState,
  ClientHelperRequest,
  ClientHelperToMainMessage,
  MainToClientHelperMessage,
} from "./messages.js";
import { paramsRefusal, requestRefusal } from "./method-allowlist.js";

/** What the helper uses of the daemon client the addon connects. */
export type ClientHelperDaemonClient = Pick<
  DaemonClient,
  "call" | "cancelCall" | "subscribe" | "cancelStream"
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

/** How the one connect ended: the client, or the wire's error every request is answered with. */
type LinkOutcome = { readonly client: ClientHelperDaemonClient } | { readonly error: JsonRpcError };

/** A file-path answer from main, by the kind the helper waits for. */
type FilePathAnswer = Extract<MainToClientHelperMessage, { readonly kind: `filePaths.${string}` }>;

/** One call an asker holds open: the addon's id for it once it has one. */
interface HeldCall {
  addonCallId: number | undefined;
  isCanceled: boolean;
}

/** One stream an asker holds open: the addon's id for it once the subscribe answered. */
interface HeldStream {
  addonStreamId: number | undefined;
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
}

/** The helper's state: the link, main's channel, and the asks main has yet to answer. */
class ClientHelper {
  readonly #parentPort: ClientHelperParentPort;
  readonly #addon: ClientHelperAddon;
  readonly #mainChannel: Channel;
  readonly #link = Promise.withResolvers<LinkOutcome>();
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
        void this.#connect(!(message.isPackaged && message.platform === "darwin"));
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

  async #connect(presentsToken: boolean): Promise<void> {
    const connected = await this.#addon.connect(presentsToken, (state) => {
      // The addon reports only the four states it names.
      this.#parentPort.postMessage({ kind: "link.state", state: state as ClientHelperLinkState });
    });
    const outcome: LinkOutcome =
      connected.client === undefined
        ? { error: wireErrorOf(connected.error) }
        : { client: connected.client };
    this.#parentPort.postMessage(
      "client" in outcome
        ? { kind: "link.connected" }
        : { kind: "link.connectFailed", error: outcome.error },
    );
    this.#link.resolve(outcome);
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
    const refusal = requestRefusal(method, request.params, request.attachments, false);
    if (refusal !== undefined) {
      channel.post({ kind: "call.refused", callId, refusal });
      return;
    }
    const held: HeldCall = { addonCallId: undefined, isCanceled: false };
    channel.calls.set(callId, held);
    let params = request.params;
    let replyAsk: number | undefined;
    if (channel.windowId !== undefined) {
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
    const link = await this.#link.promise;
    if (channel.isClosed) {
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
      held.addonCallId = addonCallId;
      // A cancel that came while the call waited reaches it now, so the addon settles it canceled.
      if (held.isCanceled) {
        link.client.cancelCall(addonCallId);
      }
      const { reply, error } = await outcome;
      answer =
        reply === undefined
          ? { kind: "call.refused", callId, refusal: wireErrorOf(error) }
          : await this.#served(channel, callId, method, reply, replyAsk);
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
    void this.#link.promise.then((link) => {
      if ("client" in link && held.addonCallId !== undefined) {
        link.client.cancelCall(held.addonCallId);
      }
    });
  }

  async #openStream(
    channel: Channel,
    request: Extract<ClientHelperRequest, { readonly kind: "stream.open" }>,
  ): Promise<void> {
    const { streamId, method } = request;
    const refusal = requestRefusal(method, request.params, request.attachments, true);
    if (refusal !== undefined) {
      channel.post({ kind: "stream.ended", streamId, end: { reason: "refused", refusal } });
      return;
    }
    const held: HeldStream = { addonStreamId: undefined, early: [], isOpened: false };
    channel.streams.set(streamId, held);
    const link = await this.#link.promise;
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
      held.addonStreamId = opened.streamId;
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
    const addonStreamId = held.addonStreamId;
    if (addonStreamId === undefined) {
      return;
    }
    void this.#link.promise.then((link) => {
      if ("client" in link) {
        link.client.cancelStream(addonStreamId);
      }
    });
  }

  /** A window's port closed: every call and stream it held is canceled, and nothing more is told. */
  #closeChannel(channel: Channel): void {
    if (channel.isClosed) {
      return;
    }
    channel.isClosed = true;
    for (const held of channel.calls.values()) {
      held.isCanceled = true;
      const addonCallId = held.addonCallId;
      if (addonCallId !== undefined) {
        void this.#link.promise.then((link) => {
          if ("client" in link) {
            link.client.cancelCall(addonCallId);
          }
        });
      }
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
