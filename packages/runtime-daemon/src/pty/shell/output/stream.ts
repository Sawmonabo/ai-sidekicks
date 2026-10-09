// One `pty.outputSubscribe` subscription's stream: the scrollback window first, at the size the
// shell was last drawn at, then the output after it, never a byte twice. A window too large for
// one message is split across as many frames as it needs, each measured against the message cap
// and cut only between characters, all sent before any output. A watcher whose connection cannot
// take more, or that declared itself behind on this shell, stops receiving output; once it has
// caught up, if any output passed it by, its next frame carries the drop mark and a fresh
// scrollback, so it redraws from the window instead of the daemon holding output for it; one
// still behind when the shell exits gets the drop mark and a fresh scrollback with the exit. Each
// stream holds back the bytes that begin a character until the output that completes it, so a
// character split across reads arrives whole, and every cursor counts only the bytes sent.

import { jsonUtf8ByteLength } from "@ai-sidekicks/contracts/jsonrpc/byte-length";
import { JSONRPC_VERSION, MAX_MESSAGE_BYTES } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SUBSCRIPTION_NOTIFY_METHOD,
  type SubscriptionId,
} from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type {
  PtyListEntry,
  PtyOutputChange,
  PtyOutputFrame,
  TerminalId,
} from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { OutboundQueue } from "../../../ipc/handlers/session/subscribe.js";
import type { ShellSize } from "../queue/resize.js";
import { incompleteTailLength, isContinuationByte } from "../utf8-boundary.js";

/** Where one subscription's frames go: its connection, and the producer behind its ack barrier. */
export interface ShellOutputOutlet {
  readonly subscriptionId: SubscriptionId;
  readonly transportId: number;
  /** Sends one frame on the subscription. */
  send(frame: PtyOutputFrame): void;
  /** Ends the subscription from the daemon's side. */
  complete(): void;
}

// What a stream reads from its shell.
interface ShellOutputSource {
  readonly sessionId: SessionId;
  readonly terminalId: TerminalId;
  // Who holds the shell once every change in flight has settled.
  readHolder(): Promise<Pick<PtyListEntry, "holder" | "leaseVersion">>;
  // The scrollback window, the shell's output offset at its end, and the shell's last size.
  readScrollback(): { bytes: Uint8Array; cursor: number; size: ShellSize };
  // Whether the stream's connection declared itself behind on this shell.
  isConnectionBehind(): boolean;
}

// How a shell that no longer runs ended: its exit code, or `null` when it never started.
type ShellEnd = { exitCode: number; cursor: number } | null;

type StreamState = "opening" | "live" | "behind" | "reseeding" | "closed";

const NO_BYTES = new Uint8Array(0);
const DECODER = new TextDecoder();

// The start of the character at or before `index`, past `floor`; a run of bytes that continue no
// character is cut where it stands.
function characterStartAtOrBefore(bytes: Uint8Array, index: number, floor: number): number {
  let at = index;
  while (at > floor && at < bytes.byteLength && isContinuationByte(bytes[at] ?? 0)) {
    at -= 1;
  }
  return at > floor ? at : index;
}

/** One subscription's view of one shell's output. */
export class ShellOutputStream {
  readonly #outlet: ShellOutputOutlet;
  readonly #source: ShellOutputSource;
  readonly #outboundQueue: OutboundQueue;
  #state: StreamState = "opening";
  // The bytes that begin a character the next output completes, held back from the last frame.
  #heldBytes: Uint8Array = NO_BYTES;
  #detachDrained: (() => void) | undefined;
  // The exit that came while the scrollback was being read, sent after it.
  #pendingExit: { exitCode: number; cursor: number } | undefined;

  constructor(outlet: ShellOutputOutlet, source: ShellOutputSource, outboundQueue: OutboundQueue) {
    this.#outlet = outlet;
    this.#source = source;
    this.#outboundQueue = outboundQueue;
  }

  /** The subscription's connection. */
  get transportId(): number {
    return this.#outlet.transportId;
  }

  /**
   * Sends the opening frames, the scrollback window read once any change of holder in flight has
   * settled; the output that comes meanwhile is in it.
   */
  open(): Promise<void> {
    return this.#seed(false);
  }

  /**
   * Sends a shell that no longer runs, its scrollback and how it ended, and ends the subscription.
   */
  async replay(end: ShellEnd): Promise<void> {
    const { holder, leaseVersion } = await this.#source.readHolder();
    // `detach` may have run while the holder was read, so read the state again.
    if (this.#isClosed()) {
      return;
    }
    this.#sendScrollback(
      holder,
      leaseVersion,
      false,
      end === null ? [] : [this.#exitedChange(end)],
    );
    this.end();
  }

  /** Sends the shell's next output, or lets it pass while the watcher is behind. */
  deliver(output: Uint8Array, cursor: number): void {
    // While the scrollback is being read, the output is in the window it will send.
    if (this.#state !== "live") {
      return;
    }
    if (this.#isHeldBack()) {
      this.#fallBehind();
      return;
    }
    const { data, heldByteCount } = this.#decode(output);
    if (data.length > 0) {
      this.#outlet.send({
        changes: [{ ...this.#shell(), kind: "output", data, cursor: cursor - heldByteCount }],
      });
    }
  }

  /** Reseeds a watcher that fell behind once its connection can take output again. */
  catchUp(): void {
    if (this.#state !== "behind") {
      return;
    }
    if (this.#isHeldBack()) {
      this.#fallBehind();
      return;
    }
    void this.#seed(true);
  }

  /**
   * Sends the shell's exit and ends the subscription: a live watcher gets what was held back and
   * the exit, one behind gets the drop mark, a fresh scrollback and the exit, and one whose
   * scrollback is still being read gets the exit after it.
   */
  exit(end: { exitCode: number; cursor: number }): void {
    if (this.#state === "closed") {
      return;
    }
    if (this.#state !== "live") {
      this.#pendingExit = end;
      if (this.#state === "behind") {
        void this.#seed(true);
      }
      return;
    }
    const changes: PtyOutputChange[] = [];
    const rest = DECODER.decode(this.#heldBytes);
    this.#heldBytes = NO_BYTES;
    if (rest.length > 0) {
      changes.push({ ...this.#shell(), kind: "output", data: rest, cursor: end.cursor });
    }
    changes.push(this.#exitedChange(end));
    this.#outlet.send({ changes });
    this.end();
  }

  /** Ends the subscription from the daemon's side. */
  end(): void {
    this.detach();
    this.#outlet.complete();
  }

  /** Stops the stream sending anything, as its subscription has ended. */
  detach(): void {
    this.#state = "closed";
    this.#detachDrained?.();
    this.#detachDrained = undefined;
  }

  #isClosed(): boolean {
    return this.#state === "closed";
  }

  async #seed(isDropped: boolean): Promise<void> {
    this.#state = isDropped ? "reseeding" : "opening";
    const { holder, leaseVersion } = await this.#source.readHolder();
    // `detach` may have run while the holder was read, so read the state again.
    if (this.#isClosed()) {
      return;
    }
    this.#heldBytes = NO_BYTES;
    const pendingExit = this.#pendingExit;
    if (pendingExit !== undefined) {
      // The shell is gone, so the stream ends with its scrollback and its exit even while its
      // connection is behind: nothing would reseed it later.
      this.#sendScrollback(holder, leaseVersion, isDropped, [this.#exitedChange(pendingExit)]);
      this.end();
      return;
    }
    if (this.#isHeldBack()) {
      this.#fallBehind();
      return;
    }
    this.#sendScrollback(holder, leaseVersion, isDropped, []);
    this.#state = "live";
  }

  #isHeldBack(): boolean {
    return (
      this.#outboundQueue.isFull(this.#outlet.transportId) || this.#source.isConnectionBehind()
    );
  }

  // A watcher behind on a full queue catches up once it drains; one behind by its own declaration
  // catches up when it declares itself caught up.
  #fallBehind(): void {
    this.#state = "behind";
    if (this.#detachDrained === undefined && this.#outboundQueue.isFull(this.#outlet.transportId)) {
      this.#detachDrained = this.#outboundQueue.onceDrained(this.#outlet.transportId, () => {
        this.#detachDrained = undefined;
        this.catchUp();
      });
    }
  }

  // Sends the scrollback window in as many frames as the message cap needs, all in this tick, the
  // first opening with the holder at its lease version and carrying the drop mark when it is a
  // reseed; `trailing` rides the last frame, or its own when that would pass the cap.
  #sendScrollback(
    holder: PtyListEntry["holder"],
    leaseVersion: number,
    isDropped: boolean,
    trailing: readonly PtyOutputChange[],
  ): void {
    const scrollback = this.#source.readScrollback();
    const { bytes } = scrollback;
    const pieceFrame = (start: number, end: number, data: string): PtyOutputFrame =>
      this.#scrollbackFrame(scrollback, { holder, leaseVersion, isDropped }, start, end, data);
    const frames: PtyOutputFrame[] = [];
    let start = 0;
    do {
      // The rest of the window, cut shorter by measure until its frame fits. The last piece holds
      // back a character the window ends inside, for the output that completes it.
      let end = bytes.byteLength;
      let frame = this.#lastScrollbackFrame(bytes, start, pieceFrame);
      let measured = this.#messageByteLength(frame);
      while (measured > MAX_MESSAGE_BYTES) {
        const fitting = Math.floor(((end - start) * MAX_MESSAGE_BYTES) / measured) - 1;
        end = characterStartAtOrBefore(bytes, start + Math.max(1, fitting), start);
        frame = pieceFrame(start, end, DECODER.decode(bytes.subarray(start, end)));
        measured = this.#messageByteLength(frame);
      }
      if (end !== bytes.byteLength) {
        this.#heldBytes = NO_BYTES;
      }
      frames.push(frame);
      start = end;
    } while (start < bytes.byteLength);
    const last = frames.at(-1);
    if (last !== undefined && trailing.length > 0) {
      const joined: PtyOutputFrame = { ...last, changes: [...last.changes, ...trailing] };
      if (this.#messageByteLength(joined) <= MAX_MESSAGE_BYTES) {
        frames[frames.length - 1] = joined;
      } else {
        frames.push({ changes: [...trailing] });
      }
    }
    for (const frame of frames) {
      this.#outlet.send(frame);
    }
  }

  // The frame of the window's bytes from `start` to its end, holding back a character it ends
  // inside; its cursor counts only the bytes sent.
  #lastScrollbackFrame(
    bytes: Uint8Array,
    start: number,
    pieceFrame: (start: number, end: number, data: string) => PtyOutputFrame,
  ): PtyOutputFrame {
    this.#heldBytes = NO_BYTES;
    const { data, heldByteCount } = this.#decode(bytes.subarray(start));
    return pieceFrame(start, bytes.byteLength - heldByteCount, data);
  }

  // Decodes the bytes held back and `output` after them, holding back the bytes that begin a
  // character the next output completes.
  #decode(output: Uint8Array): { data: string; heldByteCount: number } {
    const bytes =
      this.#heldBytes.byteLength === 0 ? output : Buffer.concat([this.#heldBytes, output]);
    const heldByteCount = incompleteTailLength(bytes);
    const sentByteCount = bytes.byteLength - heldByteCount;
    this.#heldBytes = Uint8Array.from(bytes.subarray(sentByteCount));
    return { data: DECODER.decode(bytes.subarray(0, sentByteCount)), heldByteCount };
  }

  // One piece of the scrollback, `start` to `end` of its bytes, as the frame it rides: the first
  // piece opens the window, and every later one continues it.
  #scrollbackFrame(
    scrollback: { bytes: Uint8Array; cursor: number; size: ShellSize },
    opening: { holder: PtyListEntry["holder"]; leaseVersion: number; isDropped: boolean },
    start: number,
    end: number,
    data: string,
  ): PtyOutputFrame {
    const cursor = scrollback.cursor - (scrollback.bytes.byteLength - end);
    if (start > 0) {
      return {
        changes: [{ ...this.#shell(), kind: "scrollback_continuation", data, cursor }],
      };
    }
    const change: PtyOutputChange = {
      ...this.#shell(),
      kind: "scrollback",
      data,
      columns: scrollback.size.columns,
      rows: scrollback.size.rows,
      holder: opening.holder,
      leaseVersion: opening.leaseVersion,
      cursor,
    };
    return opening.isDropped ? { changes: [change], dropped: true } : { changes: [change] };
  }

  // The bytes of the notification that carries `frame`, the quantity the message cap bounds.
  #messageByteLength(frame: PtyOutputFrame): number {
    return jsonUtf8ByteLength({
      jsonrpc: JSONRPC_VERSION,
      method: SUBSCRIPTION_NOTIFY_METHOD,
      params: { subscriptionId: this.#outlet.subscriptionId, value: frame },
    });
  }

  #exitedChange(end: { exitCode: number; cursor: number }): PtyOutputChange {
    return { ...this.#shell(), kind: "exited", exitCode: end.exitCode, cursor: end.cursor };
  }

  #shell(): { sessionId: SessionId; terminalId: TerminalId } {
    return { sessionId: this.#source.sessionId, terminalId: this.#source.terminalId };
  }
}
