// The client helper: the desktop's one use of the daemon client's addon, run in its own utility
// process. Main's requests come over the parentPort and each window's over the port main hands the
// helper for it; each passes its channel's method allowlist and the method's params check before
// the addon. A window's call to a method that carries file paths has its tokens swapped for their
// paths by asking main, which keeps them, and main mints tokens for the paths a reply offers, and
// for those a window's stream frame offers, the frame held back until they come so frames keep
// their order. A window port that closes cancels every call and stream it left open. Main connects
// the link and closes it; a request waits for the connect under way, and one made once the link is
// closed fails. A connect main closed before it settled is dropped, its link closed unused. The
// link's state, and a starting daemon's answers that it is repairing, go to main as the addon
// reports them; the addon pings, times and retries the link itself, so the helper keeps no timer.
// A shell's flow state and its waiting writes are counted over every window on the connection
// (`connection-shells.ts`), as the daemon counts them per connection. Main alone asks the helper
// to end the service and to read a process's identity, and hears the client's bounds and the
// status file's place once, at start.

import type {
  DaemonClient,
  DaemonEndingOutcome,
  DaemonEndingRequest,
  StreamEvent,
  WireReply,
} from "@ai-sidekicks/client-sdk";
import type { DaemonRepairingDetails } from "@ai-sidekicks/contracts/daemon/recovery";
import type { DaemonCannotStart } from "@ai-sidekicks/contracts/daemon/service-status";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { ConnectionInitializeResponse } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import type {
  TerminalFlowControlUpdateRequest,
  TerminalFlowControlUpdateResponse,
  TerminalWriteRequest,
} from "@ai-sidekicks/contracts/terminal";

import { FILE_PATH_METHODS, mayOfferPathsToOpen } from "#main/bridge/file-path/relay.js";
import { pageSafeMessage } from "#main/bridge/page-safe-message.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { describeFailure } from "#shared/failure-message.js";

import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";
import type { FilePathRef } from "#shared/preload-api.js";

import { ConnectionShells, type FlowTelling } from "./connection-shells.js";
import type {
  ClientHelperLinkState,
  ClientHelperServiceAnswer,
  ClientHelperServiceAsk,
  ClientHelperToMainMessage,
  MainToClientHelperMessage,
} from "./messages.js";
import { paramsRefusal, requestRefusal, type ClientHelperChannelKind } from "./method-allowlist.js";
import { isOpenedTwice, readWindowRequest } from "./window-request.js";

const FLOW_CONTROL_METHOD = "terminal.flowControl.update";

/** The reply a window gets for a flow update that changes nothing the daemon holds. */
const FLOW_CONTROL_TAKEN_JSON = JSON.stringify({
  accepted: true,
} satisfies TerminalFlowControlUpdateResponse);

/** What the helper uses of the daemon client the addon connects. */
export type ClientHelperDaemonClient = Pick<
  DaemonClient,
  "call" | "cancelCall" | "subscribe" | "cancelStream" | "close"
>;

/**
 * A connect's answer from the addon: the client and the daemon's handshake answer, or the error
 * and, when the failure says, why the service cannot start.
 */
export interface ClientHelperConnectAnswer {
  readonly client?: ClientHelperDaemonClient;
  readonly initializeResponse?: ConnectionInitializeResponse;
  readonly error?: JsonRpcError;
  readonly cannotStart?: DaemonCannotStart;
}

/**
 * What the helper uses of the addon: its one connect, its wait for a daemon that is starting, which
 * hands each answer that the daemon is repairing to `onRepairing`, the client's ending, the read of
 * a process's identity, the status file's place, and the client's two bounds.
 */
export interface ClientHelperAddon {
  connect(
    presentsToken: boolean,
    onState: (state: string) => void,
  ): Promise<ClientHelperConnectAnswer>;
  waitForDaemon(
    presentsToken: boolean,
    onState: (state: string) => void,
    onRepairing: (details: DaemonRepairingDetails) => void,
  ): Promise<ClientHelperConnectAnswer>;
  endDaemon(request: DaemonEndingRequest, presentsToken: boolean): Promise<DaemonEndingOutcome>;
  /** Takes the identity as the JSON the addon reads. */
  endDaemonProcess(processIdentityJson: string): Promise<DaemonEndingOutcome>;
  /** The identity as JSON, or `null` when no process holds the id; throws the system's error. */
  readProcessIdentity(processId: number): string | null;
  /** Throws when this system has no run folder. */
  daemonStatusFilePath(): string;
  readonly HANDSHAKE_DEADLINE_MS: number;
  readonly DAEMON_FLUSH_WAIT_MS: number;
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
  parentPort.postMessage({
    kind: "helper.started",
    handshakeDeadlineMs: addon.HANDSHAKE_DEADLINE_MS,
    flushWaitMs: addon.DAEMON_FLUSH_WAIT_MS,
    statusFile: statusFileOf(addon),
  });
}

/** Where the service's status file is, or why this system has none. */
function statusFileOf(addon: ClientHelperAddon): { path: string } | { error: string } {
  try {
    return { path: addon.daemonStatusFilePath() };
  } catch (failure) {
    return { error: describeFailure(failure) };
  }
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
  readonly method: string;
  /** The params the stream was opened with, for main's mint on a frame offering a path. */
  readonly params: unknown;
  addon: { readonly client: ClientHelperDaemonClient; readonly streamId: number } | undefined;
  /** Events the addon sent before the subscribe's answer was told, in order. */
  readonly early: StreamEvent[];
  isOpened: boolean;
  /** The delivery waiting on main's mint, which every later event waits behind. */
  waiting: Promise<void> | undefined;
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
  readonly #shells = new ConnectionShells<Channel>((update, telling) => {
    void this.#tellFlowControl(update, telling);
  });

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
        this.#startConnect(message.presentsToken, message.waitsForStart);
        return;
      case "link.close":
        void this.#closeLink();
        return;
      case "window.port":
        for (const port of ports) {
          this.#serveWindow(message.windowId, port);
        }
        return;
      case "daemon.end":
      case "daemon.endProcess":
      case "process.identityRead":
        void this.#answerServiceAsk(message);
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

  /**
   * Answers one of main's service asks through the addon, which runs the ending's whole sequence;
   * an ask that threw is answered as failed, so main's ask settles.
   */
  async #answerServiceAsk(ask: ClientHelperServiceAsk): Promise<void> {
    let answer: ClientHelperServiceAnswer;
    try {
      switch (ask.kind) {
        case "daemon.end":
          answer = {
            kind: "daemon.ended",
            askId: ask.askId,
            outcome: await this.#addon.endDaemon(ask.request, ask.presentsToken),
          };
          break;
        case "daemon.endProcess":
          answer = {
            kind: "daemon.ended",
            askId: ask.askId,
            outcome: await this.#addon.endDaemonProcess(JSON.stringify(ask.identity)),
          };
          break;
        case "process.identityRead":
          answer = this.#processIdentityAnswer(ask.askId, ask.processId);
          break;
      }
    } catch (failure) {
      answer = { kind: "service.askFailed", askId: ask.askId, error: describeFailure(failure) };
    }
    this.#parentPort.postMessage(answer);
  }

  #processIdentityAnswer(askId: number, processId: number): ClientHelperServiceAnswer {
    let identity: string | null;
    try {
      identity = this.#addon.readProcessIdentity(processId);
    } catch (failure) {
      return { kind: "process.identityRefused", askId, error: describeFailure(failure) };
    }
    return {
      kind: "process.identity",
      askId,
      // The addon writes the contract's own identity.
      identity: identity === null ? undefined : (JSON.parse(identity) as ProcessIdentity),
    };
  }

  /**
   * Connects unless a connect is under way or a client is held; `waitsForStart` waits for a daemon
   * that is starting rather than trying once.
   */
  #startConnect(presentsToken: boolean, waitsForStart: boolean): void {
    if (this.#isConnecting || (this.#linkOutcome !== undefined && "client" in this.#linkOutcome)) {
      return;
    }
    if (this.#linkOutcome !== undefined) {
      this.#linkOutcome = undefined;
      this.#pendingLink = Promise.withResolvers<LinkOutcome>();
    }
    this.#isConnecting = true;
    this.#shells.forgetConnection();
    void this.#connect(presentsToken, waitsForStart);
  }

  async #connect(presentsToken: boolean, waitsForStart: boolean): Promise<void> {
    const generation = ++this.#linkGeneration;
    const isCurrent = (): boolean => generation === this.#linkGeneration;
    const onState = (state: string): void => {
      if (isCurrent()) {
        // The addon reports only the five states it names.
        this.#noteLinkState(state as ClientHelperLinkState);
        this.#parentPort.postMessage({ kind: "link.state", state: state as ClientHelperLinkState });
      }
    };
    const connected = await (waitsForStart
      ? this.#addon.waitForDaemon(presentsToken, onState, (details) => {
          if (isCurrent()) {
            this.#parentPort.postMessage({ kind: "link.repairing", details });
          }
        })
      : this.#addon.connect(presentsToken, onState));
    if (!isCurrent()) {
      // Main closed the link while this connect ran: its client goes unused.
      await connected.client?.close();
      return;
    }
    this.#isConnecting = false;
    if (connected.client === undefined) {
      const error = wireErrorOf(connected.error);
      this.#parentPort.postMessage({
        kind: "link.connectFailed",
        error,
        ...(connected.cannotStart === undefined ? {} : { cannotStart: connected.cannotStart }),
      });
      this.#settleLink({ error });
      return;
    }
    this.#parentPort.postMessage({
      kind: "link.connected",
      // The addon answers the daemon's handshake answer with every client.
      initializeResponse: connected.initializeResponse as ConnectionInitializeResponse,
    });
    this.#settleLink({ client: connected.client });
    this.#shells.tellUntold();
  }

  /**
   * A link the addon lost and opens again is a new connection, which holds no pause until told;
   * quiet and open again is the same one, with nothing untold.
   */
  #noteLinkState(state: ClientHelperLinkState): void {
    switch (state) {
      case "reconnecting":
      case "silent":
      case "down":
        this.#shells.forgetConnection();
        return;
      case "open":
        if (this.#linkOutcome !== undefined && "client" in this.#linkOutcome) {
          this.#shells.tellUntold();
        }
        return;
      case "quiet":
        return;
    }
  }

  /**
   * Sends the connection's own flow update, after the connect under way and the calls waiting on
   * it; a failure puts back what the daemon was told and is told to main, which logs it.
   */
  async #tellFlowControl(
    update: TerminalFlowControlUpdateRequest,
    telling: FlowTelling,
  ): Promise<void> {
    const link = await this.#link();
    // With no link up the daemon holds nothing for this connection; the next one is told.
    if (!("client" in link)) {
      return;
    }
    let message: string;
    try {
      const { error } = await link.client.call(
        this.#takeAddonCallId(),
        FLOW_CONTROL_METHOD,
        JSON.stringify(update),
        [],
      );
      if (error === undefined) {
        return;
      }
      message = wireErrorOf(error).message;
    } catch (failure) {
      message = describeFailure(failure);
    }
    telling.putBack();
    this.#parentPort.postMessage({ kind: "flowControl.failed", message });
  }

  /**
   * Closes the link: a client held ends with every call and stream on it, a connect under way is
   * dropped, and later requests fail until the next connect.
   */
  async #closeLink(): Promise<void> {
    const outcome = this.#linkOutcome;
    if (this.#isConnecting) {
      this.#isConnecting = false;
      this.#linkGeneration += 1;
      this.#settleLink(CLOSED_LINK);
      return;
    }
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
    if (method === FLOW_CONTROL_METHOD) {
      // The params passed the method's check.
      const update = params as TerminalFlowControlUpdateRequest;
      const telling = this.#shells.declareFlow(channel, update);
      if (telling === undefined) {
        this.#settleCall(channel, callId, {
          kind: "call.served",
          callId,
          json: FLOW_CONTROL_TAKEN_JSON,
          attachments: [],
        });
        return;
      }
      const flowParams = { ...update, paused: telling.paused };
      const answer = await this.#callOverLink(channel, request, held, flowParams, undefined);
      // An update the daemon did not take leaves it holding what it was told before.
      if (answer?.kind !== "call.served") {
        telling.putBack();
      }
      return;
    }
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
    // The params passed the method's check.
    const releaseWrite =
      method === "terminal.write"
        ? await this.#shells.takeWriteRoom(params as TerminalWriteRequest)
        : undefined;
    try {
      await this.#callOverLink(channel, request, held, params, replyAsk);
    } finally {
      releaseWrite?.();
    }
  }

  /** Sends one checked call once the link settles; answers what it told the asker, if anything. */
  async #callOverLink(
    channel: Channel,
    request: Extract<ClientHelperRequest, { readonly kind: "call" }>,
    held: HeldCall,
    params: unknown,
    replyAsk: number | undefined,
  ): Promise<ClientHelperAnswer | undefined> {
    const { callId, method } = request;
    const link = await this.#link();
    if (channel.isClosed) {
      return undefined;
    }
    if ("isClosed" in link) {
      const failed = { kind: "call.failed", callId, message: NOT_ANSWERING_MESSAGE } as const;
      this.#settleCall(channel, callId, failed);
      return failed;
    }
    if ("error" in link) {
      const refused = { kind: "call.refused", callId, refusal: link.error } as const;
      this.#settleCall(channel, callId, refused);
      return refused;
    }
    const addonCallId = this.#takeAddonCallId();
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
    return answer;
  }

  #takeAddonCallId(): number {
    const addonCallId = this.#nextAddonCallId;
    this.#nextAddonCallId = (addonCallId + 1) % 2 ** 32;
    return addonCallId;
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
    const held: HeldStream = {
      method,
      params: request.params,
      addon: undefined,
      early: [],
      isOpened: false,
      waiting: undefined,
    };
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

  /**
   * Hands one of the addon's stream events to the asker while it still holds the stream: at once,
   * or behind main's mint for a window's frame that may offer a path to open, and behind any
   * delivery still waiting on one, so the asker gets them in the order the daemon sent them.
   */
  #deliver(channel: Channel, streamId: number, held: HeldStream, event: StreamEvent): void {
    const windowId = channel.windowId;
    const minted =
      windowId !== undefined &&
      event.value !== undefined &&
      mayOfferPathsToOpen(held.method, event.value.json)
        ? this.#mintFramePaths(windowId, held, event.value.json)
        : undefined;
    if (minted === undefined && held.waiting === undefined) {
      this.#tell(channel, streamId, held, event, undefined);
      return;
    }
    const waiting = (async () => {
      await held.waiting;
      this.#tell(channel, streamId, held, event, await minted);
    })();
    held.waiting = waiting;
    void waiting.then(() => {
      if (held.waiting === waiting) {
        held.waiting = undefined;
      }
    });
  }

  /** Main's tokens for the paths one of a window's stream frames offers, keyed by the path. */
  async #mintFramePaths(
    windowId: number,
    held: HeldStream,
    json: string,
  ): Promise<Readonly<Record<string, FilePathRef>>> {
    const minted = await this.#askMain<"filePaths.minted">({
      kind: "filePaths.mint",
      askId: this.#nextAskId++,
      windowId,
      method: held.method,
      params: held.params,
      value: JSON.parse(json),
    });
    return minted.fileRefs;
  }

  /** Tells the asker one stream event, with the tokens main minted for a frame's paths. */
  #tell(
    channel: Channel,
    streamId: number,
    held: HeldStream,
    event: StreamEvent,
    fileRefs: Readonly<Record<string, FilePathRef>> | undefined,
  ): void {
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
        ...(fileRefs === undefined || Object.keys(fileRefs).length === 0 ? {} : { fileRefs }),
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

  /**
   * A window's port closed: every call and stream it held is canceled, a shell it alone was behind
   * on resumes, and nothing more is told.
   */
  #closeChannel(channel: Channel): void {
    if (channel.isClosed) {
      return;
    }
    channel.isClosed = true;
    this.#shells.forgetAsker(channel);
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
