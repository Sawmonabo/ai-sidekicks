// The transport to the daemon on this machine: its Unix domain socket, framed with the same
// Content-Length parser and encoder the daemon uses. There is no fallback transport, so a socket
// nobody answers on fails with `transport.unavailable` rather than trying another address.

import * as net from "node:net";

import {
  encodeFrame,
  parseFrame,
  type ParseFrameResult,
} from "@ai-sidekicks/contracts/content-length-framing";
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  MAX_MESSAGE_BYTES,
  type JsonRpcErrorData,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import { z } from "zod";

import type { ClientTransport } from "./types.js";

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
    super(`The daemon's socket ${socketPath} cannot be reached: ${cause.message}`, { cause });
    this.name = "JsonRpcTransportUnavailableError";
    const reason = "code" in cause && typeof cause.code === "string" ? cause.code : cause.message;
    this.data = { type: "transport.unavailable", fields: { reason } };
  }
}

/**
 * The close reason when the daemon ended the connection itself, with no socket error: the service
 * stopped or exited. A caller tells a service that went away from a broken link by this class.
 */
export class JsonRpcTransportPeerClosedError extends Error {
  public constructor() {
    super("The daemon closed the connection");
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

type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

// JSON can encode no `undefined`, so a member that reads `undefined` was absent.
const presentValue = z.custom<unknown>((value) => value !== undefined, "required");
const JsonRpcIdSchema: z.ZodType<JsonRpcId> = z.union([z.string(), z.number(), z.null()]);

// What the daemon may send: a success, an error, or a notification, and nothing else. Optional
// members are exact, as the envelope types declare them: present with a value, or absent.
const InboundEnvelopeSchema: z.ZodType<InboundEnvelope> = z.union([
  z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    result: presentValue,
  }),
  z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    error: z.object({
      code: z.number().int(),
      message: z.string(),
      data: z
        .object({ type: z.string(), fields: z.record(z.string(), z.unknown()).exactOptional() })
        .exactOptional(),
    }),
  }),
  z.strictObject({
    jsonrpc: z.literal(JSONRPC_VERSION),
    method: z.string(),
    params: z.unknown().exactOptional(),
  }),
]);

// Decoding keeps no state between calls, so every connection shares one decoder.
const UTF8_DECODER = new TextDecoder();

// The receive buffer's first size, enough for most replies; it doubles when a frame outgrows it.
const RECEIVE_BUFFER_FIRST_BYTES = 64 * 1024;

// One connection to the daemon. Bytes are not read until the client registers its handler, so no
// frame arrives with nobody to take it; a frame that breaks the framing or the envelope shape ends
// the connection with that error as the close reason.
class LocalSocketTransport implements ClientTransport {
  readonly #socket: net.Socket;
  readonly #closed: Promise<void>;
  // The bytes received and not yet framed are `#received[#readOffset, #writeOffset)`.
  #received: Uint8Array = new Uint8Array(RECEIVE_BUFFER_FIRST_BYTES);
  #readOffset = 0;
  #writeOffset = 0;
  #messageHandler: ((message: InboundEnvelope) => void) | undefined;
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
      throw new Error("The connection to the daemon is closed");
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

  public onMessage(handler: (message: InboundEnvelope) => void): void {
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

  #receive(chunk: Buffer, handler: (message: InboundEnvelope) => void): void {
    this.#append(chunk);
    while (!this.#isClosing && !this.#isClosed) {
      let envelope: InboundEnvelope;
      try {
        const result: ParseFrameResult = parseFrame(
          this.#received.subarray(this.#readOffset, this.#writeOffset),
          MAX_MESSAGE_BYTES,
        );
        if (result.frame === null) {
          return;
        }
        this.#consume(result.consumed);
        envelope = InboundEnvelopeSchema.parse(
          JSON.parse(UTF8_DECODER.decode(result.frame)) as unknown,
        );
      } catch (error) {
        // A framing, JSON or envelope failure: each throws an `Error`.
        this.#socket.destroy(error as Error);
        return;
      }
      handler(envelope);
    }
  }

  // Appends in place. Only when the chunk does not fit behind the unframed bytes are they moved:
  // to the front when a frame has been read off it, or else into a buffer twice the size. So
  // every received byte is copied a bounded number of times, however many reads a frame takes.
  #append(chunk: Uint8Array): void {
    if (this.#received.byteLength - this.#writeOffset < chunk.byteLength) {
      const pendingBytes = this.#writeOffset - this.#readOffset;
      const neededBytes = pendingBytes + chunk.byteLength;
      if (neededBytes > this.#received.byteLength) {
        let capacity = this.#received.byteLength * 2;
        while (capacity < neededBytes) {
          capacity *= 2;
        }
        const grown = new Uint8Array(capacity);
        grown.set(this.#received.subarray(this.#readOffset, this.#writeOffset));
        this.#received = grown;
      } else {
        this.#received.copyWithin(0, this.#readOffset, this.#writeOffset);
      }
      this.#readOffset = 0;
      this.#writeOffset = pendingBytes;
    }
    this.#received.set(chunk, this.#writeOffset);
    this.#writeOffset += chunk.byteLength;
  }

  // Drops a read frame. Once nothing is left the buffer starts over at the front, and a buffer a
  // large frame grew goes back to its first size, so that frame's memory is not held after it.
  #consume(frameBytes: number): void {
    this.#readOffset += frameBytes;
    if (this.#readOffset < this.#writeOffset) {
      return;
    }
    this.#readOffset = 0;
    this.#writeOffset = 0;
    if (this.#received.byteLength > RECEIVE_BUFFER_FIRST_BYTES) {
      this.#received = new Uint8Array(RECEIVE_BUFFER_FIRST_BYTES);
    }
  }
}
