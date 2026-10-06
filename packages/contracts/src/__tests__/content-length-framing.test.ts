// The frame accumulator both ends of the daemon's socket and the PTY sidecar's reader read through:
// whatever sizes the reads come in, every frame comes out whole and in order, including one larger
// than the accumulator's first size and the frames that follow it.
import { describe, expect, it } from "vitest";

import { encodeFrame, FrameAccumulator } from "../content-length-framing.js";
import { MAX_MESSAGE_BYTES, type JsonRpcMessage } from "../jsonrpc/message.js";

function notification(text: string): JsonRpcMessage {
  return { jsonrpc: "2.0", method: "x.y", params: { text } };
}

describe("FrameAccumulator", () => {
  it.each([1, 7, 4096, 100_000, 1_000_000])(
    "reads every frame whole and in order from reads of %i bytes",
    (readBytes) => {
      const messages = [
        notification("first"),
        notification("x".repeat(300_000)),
        notification("third"),
        notification("y".repeat(70_000)),
        notification("last"),
      ];
      const stream = Buffer.concat(messages.map((message) => encodeFrame(message)));
      const frames = new FrameAccumulator(MAX_MESSAGE_BYTES);
      const decoded: unknown[] = [];
      for (let start = 0; start < stream.byteLength; start += readBytes) {
        frames.append(stream.subarray(start, start + readBytes));
        for (let frame = frames.nextFrame(); frame !== null; frame = frames.nextFrame()) {
          decoded.push(JSON.parse(new TextDecoder().decode(frame)));
        }
      }
      expect(decoded).toStrictEqual(messages);
    },
  );
});
