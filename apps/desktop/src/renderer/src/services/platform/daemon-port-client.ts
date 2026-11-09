// The page's daemon wire over its port to the client helper. A call or a stream waits while no port
// is held, and the first one asks the preload for a port. When the port closes, as it does when the
// helper exits, every call still waiting fails once and every open stream ends as failed, and a new
// port is asked for at once: main hands it to the helper it starts again. The stream owners reopen
// what they held from the cursors they kept; only main's `daemon.status` topic, which rides IPC,
// says whether the service can be reached. Bytes cross beside the JSON: each `Uint8Array` in the
// params is sent as a `{"$bytes": n}` member and its bytes, and a reply's or a value's bytes come
// back beside it for its check to read.

import {
  type SubscriptionId,
  validateSubscribeAcknowledgmentResponse,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { DAEMON_PORT_MESSAGE } from "#shared/bridge-channels.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { ClientHelperAnswer, ClientHelperRequest } from "#shared/daemon/port-message.js";
import { DAEMON_STATUS_TOPIC, NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import type {
  DaemonPreload,
  DaemonWire,
  FilePathRef,
  ServedDaemonCall,
  Unsubscribe,
} from "#shared/preload-api.js";

/** The page's end of a channel to the client helper: a DOM `MessagePort`, with Electron's close. */
export interface DaemonPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  postMessage(message: ClientHelperRequest): void;
  start(): void;
}

/** The window the preload posts each new port to. */
export interface DaemonPortWindow {
  addEventListener(
    type: "message",
    listener: (event: {
      readonly source: unknown;
      readonly data: unknown;
      readonly ports: readonly DaemonPort[];
    }) => void,
  ): void;
}

/** The calls and streams one window holds over its port to the client helper. */
export class DaemonPortClient {
  readonly #preload: Pick<DaemonPreload, "openPort">;
  #port: DaemonPort | undefined;
  #isPortAsked = false;
  /** Requests made while no port was held, sent in order once one arrives. */
  readonly #waiting: ClientHelperRequest[] = [];
  readonly #calls = new Map<number, PendingCall>();
  readonly #streams = new Map<number, OpenStream>();
  #nextId = 0;

  public constructor(preload: Pick<DaemonPreload, "openPort">, page: DaemonPortWindow) {
    this.#preload = preload;
    page.addEventListener("message", (event) => {
      const port = event.ports[0];
      if (event.source === page && event.data === DAEMON_PORT_MESSAGE && port !== undefined) {
        this.#adopt(port);
      }
    });
  }

  /**
   * Call `method`. Resolves with the reply, its bytes and the tokens main minted for its paths;
   * rejects with the refusal in the wire's shape, or with an `Error` when the helper failed it or
   * the port closed first.
   */
  public call(method: string, params: unknown): Promise<ServedDaemonCall<unknown>> {
    const callId = this.#nextId++;
    const answered = new Promise<ServedDaemonCall<unknown>>((resolve, reject) => {
      this.#calls.set(callId, { resolve, reject });
    });
    const attachments: Uint8Array[] = [];
    this.#send({
      kind: "call",
      callId,
      method,
      params: withBytesTaken(params, attachments),
      attachments,
    });
    return answered;
  }

  /**
   * Open a stream of `event`, delivering each value, its bytes and the tokens main minted for the
   * paths it offers until it is closed or ends; its end is told once, unless the page closed it
   * first. `onOpened` is told the subscription's id when the acknowledgment is the id alone.
   */
  public subscribe(
    event: string,
    params: unknown,
    deliver: StreamDelivery,
    onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined,
    onOpened?: ((subscriptionId: SubscriptionId) => void) | undefined,
  ): Unsubscribe {
    const streamId = this.#nextId++;
    this.#streams.set(streamId, { deliver, onEnded, onOpened });
    const attachments: Uint8Array[] = [];
    this.#send({
      kind: "stream.open",
      streamId,
      method: event,
      params: withBytesTaken(params, attachments),
      attachments,
    });
    return () => {
      if (this.#streams.delete(streamId)) {
        this.#send({ kind: "stream.close", streamId });
      }
    };
  }

  #send(request: ClientHelperRequest): void {
    if (this.#port !== undefined) {
      this.#port.postMessage(request);
      return;
    }
    this.#waiting.push(request);
    this.#askForPort();
  }

  #askForPort(): void {
    if (!this.#isPortAsked) {
      this.#isPortAsked = true;
      this.#preload.openPort();
    }
  }

  #adopt(port: DaemonPort): void {
    this.#port = port;
    this.#isPortAsked = false;
    port.onmessage = (event) => {
      this.#receive(event.data as ClientHelperAnswer);
    };
    port.onclose = () => {
      this.#closed(port);
    };
    port.start();
    for (const request of this.#waiting.splice(0)) {
      port.postMessage(request);
    }
  }

  #receive(answer: ClientHelperAnswer): void {
    switch (answer.kind) {
      case "call.served": {
        const pending = this.#takeCall(answer.callId);
        const value = JSON.parse(answer.json) as unknown;
        pending?.resolve({
          value,
          ...(answer.attachments.length === 0 ? {} : { attachments: answer.attachments }),
          ...(answer.fileRefs === undefined ? {} : { fileRefs: answer.fileRefs }),
        });
        return;
      }
      case "call.refused":
        // The wire error itself, as the page reads a refusal by its code and data.
        this.#takeCall(answer.callId)?.reject(answer.refusal);
        return;
      case "call.failed":
        this.#takeCall(answer.callId)?.reject(new Error(answer.message));
        return;
      case "stream.opened": {
        // A subscribe answered with more than its id, as a list's carries the list, opens with it.
        const acknowledgment = JSON.parse(answer.json) as unknown;
        const stream = this.#streams.get(answer.streamId);
        if (validateSubscribeAcknowledgmentResponse(acknowledgment)) {
          stream?.onOpened?.(acknowledgment.subscriptionId);
        } else if (carriesMoreThanId(acknowledgment)) {
          stream?.deliver(acknowledgment, answer.attachments);
        }
        return;
      }
      case "stream.value":
        this.#streams
          .get(answer.streamId)
          ?.deliver(JSON.parse(answer.json) as unknown, answer.attachments, answer.fileRefs);
        return;
      case "stream.ended": {
        const stream = this.#streams.get(answer.streamId);
        this.#streams.delete(answer.streamId);
        stream?.onEnded?.(answer.end);
        return;
      }
    }
  }

  #takeCall(callId: number): PendingCall | undefined {
    const pending = this.#calls.get(callId);
    this.#calls.delete(callId);
    return pending;
  }

  /** The port closed: what waited on it fails once, and a new port is asked for. */
  #closed(port: DaemonPort): void {
    if (this.#port !== port) {
      return;
    }
    this.#port = undefined;
    const calls = [...this.#calls.values()];
    this.#calls.clear();
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const call of calls) {
      call.reject(new Error(NOT_ANSWERING_MESSAGE));
    }
    for (const stream of streams) {
      stream.onEnded?.({ reason: "failed", message: NOT_ANSWERING_MESSAGE });
    }
    this.#askForPort();
  }
}

/** The page's daemon wire, built over the preload's members and the window its ports arrive at. */
export function createDaemonPortWire(preload: DaemonPreload, page: DaemonPortWindow): DaemonWire {
  const client = new DaemonPortClient(preload, page);
  return {
    // The reply's type is the method's, which the caller's check confirms.
    call: ((method: string, params: unknown) =>
      client.call(method, params)) as unknown as DaemonWire["call"],
    subscribe: (event, params, handler, onEnded, onOpened) =>
      event === DAEMON_STATUS_TOPIC
        ? preload.subscribeStatus(handler as (state: unknown) => void)
        : client.subscribe(event, params, handler as StreamDelivery, onEnded, onOpened),
    requestStart: () => preload.requestStart(),
  };
}

/** What a stream's handler is handed for each value. */
type StreamDelivery = (
  value: unknown,
  attachments: readonly Uint8Array[],
  fileRefs?: Readonly<Record<string, FilePathRef>>,
) => void;

/** A call waiting for its answer. */
interface PendingCall {
  readonly resolve: (served: ServedDaemonCall<unknown>) => void;
  readonly reject: (failure: unknown) => void;
}

/** A stream the page holds open. */
interface OpenStream {
  readonly deliver: StreamDelivery;
  readonly onEnded: ((end: DaemonSubscriptionEnd) => void) | undefined;
  readonly onOpened: ((subscriptionId: SubscriptionId) => void) | undefined;
}

/** Whether a subscribe's acknowledgment carries more than the subscription's id. */
function carriesMoreThanId(acknowledgment: unknown): boolean {
  return (
    typeof acknowledgment === "object" &&
    acknowledgment !== null &&
    Object.keys(acknowledgment).some((key) => key !== "subscriptionId")
  );
}

/** `value` with each `Uint8Array` in it taken into `attachments` and left as its placeholder. */
function withBytesTaken(value: unknown, attachments: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    attachments.push(value);
    return { $bytes: attachments.length - 1 };
  }
  if (Array.isArray(value)) {
    return value.map((element: unknown) => withBytesTaken(element, attachments));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, withBytesTaken(member, attachments)]),
    );
  }
  return value;
}
