// The transport to the daemon on this machine: its Unix domain socket, framed with the same
// Content-Length parser and encoder the daemon uses. There is no fallback transport, so a socket
// nobody answers on fails with `transport.unavailable` rather than trying another address.

import * as net from "node:net";

import { encodeFrame, FrameAccumulator } from "@ai-sidekicks/contracts/content-length-framing";
import {
  JsonRpcErrorCode,
  JsonRpcServerMessageSchema,
  MAX_MESSAGE_BYTES,
  TRANSPORT_UNAVAILABLE_CODE,
  type JsonRpcErrorData,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcServerMessage,
} from "@ai-sidekicks/contracts/jsonrpc/message";

import { JsonRpcTransportClosedError, type ClientTransport } from "./json-rpc.js";

/**
 * Thrown when the daemon's socket cannot be reached: no daemon is listening, or the socket file is
 * missing. It carries the canonical envelope: `code` is `-32603` and `data` is
 * `{ type: "transport.unavailable", fields: { reason } }`, `reason` being the system's error code.
 */
export class JsonRpcTransportUnavailableError extends Error {
  /** The JSON-RPC numeric error code, always `InternalError`. */
  public readonly code: number = JsonRpcErrorCode.InternalError;
  /** The structured error; switch on `data.type`. */
  public readonly data: JsonRpcErrorData;

  public constructor(socketPath: string, cause: Error) {
    super(`The background service is not answering at ${socketPath}: ${cause.message}`, { cause });
    this.name = "JsonRpcTransportUnavailableError";
    const reason = "code" in cause && typeof cause.code === "string" ? cause.code : cause.message;
    this.data = { type: TRANSPORT_UNAVAILABLE_CODE, fields: { reason } };
  }
}

/**
 * The close reason when the daemon ended the connection itself, with no socket error: the service
 * stopped or exited. A caller tells a service that went away from a broken link by this class.
 */
export class JsonRpcTransportPeerClosedError extends Error {
  public constructor() {
    super("the service ended it");
    this.name = "JsonRpcTransportPeerClosedError";
  }
}

/**
 * Connects to the daemon's socket. Resolves once connected; throws
 * `JsonRpcTransportUnavailableError` when nothing answers there.
 */
export function connectLocalSocket(socketPath: string): Promise<ClientTransport> {
  return new Promise<ClientTransport>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const rejectUnreachable = (error: Error): void => {
      socket.destroy();
      reject(new JsonRpcTransportUnavailableError(socketPath, error));
    };
    socket.once("error", rejectUnreachable);
    socket.once("connect", () => {
      socket.off("error", rejectUnreachable);
      resolve(new LocalSocketTransport(socket));
    });
  });
}

// Decoding keeps no state between calls, so every connection shares one decoder.
const UTF8_DECODER = new TextDecoder();

// One connection to the daemon. Bytes are not read until the client registers its handler, so no
// frame arrives with nobody to take it; a frame that breaks the framing or the envelope shape ends
// the connection with that error as the close reason.
class LocalSocketTransport implements ClientTransport {
  readonly #socket: net.Socket;
  readonly #closed: Promise<void>;
  readonly #frames = new FrameAccumulator(MAX_MESSAGE_BYTES);
  #messageHandler: ((message: JsonRpcServerMessage) => void) | undefined;
  #closeHandler: ((reason?: Error) => void) | undefined;
  #failure: Error | undefined;
  #isClosing = false;
  #isClosed = false;

  public constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("error", (error) => {
      this.#failure ??= error;
    });
    this.#closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        this.#isClosed = true;
        const reason = this.#isClosing
          ? this.#failure
          : (this.#failure ?? new JsonRpcTransportPeerClosedError());
        this.#closeHandler?.(reason);
        resolve();
      });
    });
  }

  public send(envelope: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (this.#isClosing || this.#isClosed) {
      throw new JsonRpcTransportClosedError(this.#failure);
    }
    const frame = encodeFrame(envelope);
    // The callback fires once the frame has left the stream's buffer, so a caller awaiting each
    // send never queues more than the socket can take.
    return new Promise<void>((resolve, reject) => {
      this.#socket.write(frame, (error) => {
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  public onMessage(handler: (message: JsonRpcServerMessage) => void): void {
    if (this.#messageHandler !== undefined) {
      throw new Error("The connection already has its message handler");
    }
    this.#messageHandler = handler;
    this.#socket.on("data", (chunk: Buffer) => {
      this.#receive(chunk, handler);
    });
  }

  public onClose(handler: (reason?: Error) => void): void {
    if (this.#closeHandler !== undefined) {
      throw new Error("The connection already has its close handler");
    }
    this.#closeHandler = handler;
  }

  public close(): Promise<void> {
    this.#isClosing = true;
    this.#socket.destroy();
    return this.#closed;
  }

  #receive(chunk: Buffer, handler: (message: JsonRpcServerMessage) => void): void {
    this.#frames.append(chunk);
    while (!this.#isClosing && !this.#isClosed) {
      let envelope: JsonRpcServerMessage;
      try {
        const frame = this.#frames.nextFrame();
        if (frame === null) {
          return;
        }
        envelope = JsonRpcServerMessageSchema.parse(
          JSON.parse(UTF8_DECODER.decode(frame)) as unknown,
        );
      } catch (error) {
        // A framing, JSON or envelope failure: each throws an `Error`.
        this.#socket.destroy(error as Error);
        return;
      }
      handler(envelope);
    }
  }
}
