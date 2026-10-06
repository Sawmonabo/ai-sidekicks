// A raw client for the daemon's local socket, below the client SDK: it sends any envelope as one
// frame, including ones the daemon must refuse, and collects every framed reply.

import * as net from "node:net";

import type { JsonRpcMessage } from "@ai-sidekicks/contracts/jsonrpc/message";
import { MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts/jsonrpc/message";
import { encodeFrame, FrameAccumulator } from "@ai-sidekicks/contracts/content-length-framing";

/** A connected raw socket client. */
export interface Client {
  readonly socket: net.Socket;
  /** Sends `value` as one frame, including envelopes the gateway must refuse. */
  readonly send: (value: unknown) => void;
  /** Resolves with every reply so far once `count` have arrived; rejects if the socket closes. */
  readonly replies: (count: number) => Promise<unknown[]>;
  readonly close: () => Promise<void>;
}

/** Connects to `socketPath`; rejects when nothing listens there. */
export async function connect(socketPath: string): Promise<Client> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  // Each chunk is framed as it arrives, so every reply is decoded once.
  const frames = new FrameAccumulator(MAX_MESSAGE_BYTES);
  const envelopes: unknown[] = [];
  let framingFailure: unknown = null;
  let isClosed = false;
  let waiter: {
    readonly count: number;
    readonly resolve: (envelopes: unknown[]) => void;
    readonly reject: (reason: unknown) => void;
  } | null = null;
  const settle = (): void => {
    const current = waiter;
    if (current === null) {
      return;
    }
    if (framingFailure !== null) {
      waiter = null;
      current.reject(framingFailure);
    } else if (envelopes.length >= current.count) {
      waiter = null;
      current.resolve([...envelopes]);
    } else if (isClosed) {
      waiter = null;
      current.reject(
        new Error(`socket closed after ${envelopes.length} of ${current.count} replies`),
      );
    }
  };
  socket.on("data", (chunk: Buffer) => {
    frames.append(chunk);
    try {
      for (let frame = frames.nextFrame(); frame !== null; frame = frames.nextFrame()) {
        envelopes.push(JSON.parse(new TextDecoder().decode(frame)));
      }
    } catch (error) {
      framingFailure = error;
    }
    settle();
  });
  socket.on("close", () => {
    isClosed = true;
    settle();
  });
  return {
    socket,
    // `encodeFrame` only serializes, so the cast lets a test send envelopes the gateway refuses.
    send: (value) => {
      socket.write(encodeFrame(value as JsonRpcMessage));
    },
    replies: (count) =>
      new Promise((resolve, reject) => {
        waiter = { count, resolve, reject };
        settle();
      }),
    close: () => {
      if (socket.destroyed) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        socket.once("close", () => {
          resolve();
        });
        socket.end();
      });
    },
  };
}
