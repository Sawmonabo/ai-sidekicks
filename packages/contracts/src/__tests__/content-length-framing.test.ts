// The framing both ends of the daemon's socket and the PTY sidecar's reader read through: frames
// are sliced by byte count and refused when their length is ambiguous or unbounded, and whatever
// sizes the reads come in, every frame comes out whole and in order, including one larger than the
// accumulator's first size and the frames that follow it.
import { describe, expect, it } from "vitest";

import {
  encodeFrame,
  FrameAccumulator,
  FramingError,
  parseFrame,
} from "../content-length-framing.js";
import { JSONRPC_VERSION, MAX_MESSAGE_BYTES, type JsonRpcMessage } from "../jsonrpc/message.js";

function notification(text: string): JsonRpcMessage {
  return { jsonrpc: "2.0", method: "x.y", params: { text } };
}

/** The `FramingError` code `parseFrame` throws for `bytes`, or null when it accepts them. */
function framingErrorCode(bytes: string): string | null {
  try {
    parseFrame(Buffer.from(bytes, "ascii"), MAX_MESSAGE_BYTES);
  } catch (error) {
    if (!(error instanceof FramingError)) {
      throw error;
    }
    return error.code;
  }
  return null;
}

describe("Content-Length framing", () => {
  it("slices frames by byte count and waits for one that has not fully arrived", () => {
    // "héllo" is 6 bytes in UTF-8 but 5 characters; counting characters would cut the next frame.
    const first = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: { message: "héllo" } };
    const second = { jsonrpc: JSONRPC_VERSION, id: 2, method: "x.y", params: {} };
    const firstFrame = encodeFrame(first);
    const secondFrame = encodeFrame(second);
    const stream = Buffer.concat([firstFrame, secondFrame]);

    const head = parseFrame(stream, MAX_MESSAGE_BYTES);
    expect(head.consumed).toBe(firstFrame.byteLength);
    expect(JSON.parse(new TextDecoder().decode(head.frame!))).toStrictEqual(first);

    const waiting = { frame: null, consumed: 0 };
    expect(parseFrame(secondFrame.subarray(0, 10), MAX_MESSAGE_BYTES)).toEqual(waiting);
    expect(parseFrame(secondFrame.subarray(0, -5), MAX_MESSAGE_BYTES)).toEqual(waiting);
    const tail = parseFrame(stream.subarray(head.consumed), MAX_MESSAGE_BYTES);
    expect(JSON.parse(new TextDecoder().decode(tail.frame!))).toStrictEqual(second);
  });

  // A length two parsers could read differently desyncs the stream (request smuggling), and an
  // unterminated header would grow the connection's buffer without bound.
  it.each([
    {
      label: "no Content-Length",
      bytes: "Other-Header: 5\r\n\r\n12345",
      code: "missing_content_length",
    },
    {
      label: "two Content-Length headers",
      bytes: "Content-Length: 5\r\nContent-Length: 6\r\n\r\n123456",
      code: "malformed_content_length",
    },
    {
      label: "an empty length",
      bytes: "Content-Length: \r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a length with trailing letters",
      bytes: "Content-Length: 12junk\r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a length in scientific notation",
      bytes: "Content-Length: 12e1\r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a hexadecimal length",
      bytes: "Content-Length: 0x12\r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a header section over 1024 bytes",
      bytes: `Content-Length: 5\r\nX-Pad: ${"a".repeat(2000)}\r\n\r\n12345`,
      code: "header_too_long",
    },
    {
      label: "over 1024 header bytes with no terminator yet",
      bytes: "Z".repeat(2000),
      code: "header_too_long",
    },
  ])("refuses a frame with $label", ({ bytes, code }) => {
    expect(framingErrorCode(bytes)).toBe(code);
  });
});

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
