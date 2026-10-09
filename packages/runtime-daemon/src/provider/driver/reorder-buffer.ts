// The bounded reorder buffer at a normalize boundary that pairs tool events by `toolCallId`: it
// holds a completion that arrives before its initiation, and flushes in arrival order with a
// diagnostic when it overflows or a pairing times out, so no reordering is ever silent.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import type { DriverDiagnosticsEmitter } from "./diagnostics.js";

/**
 * One buffered normalized event awaiting its pair. `toolCallId` is the provider `tool_use_id`
 * carried verbatim; an `unpaired` event never waits.
 */
export interface ReorderBufferedEvent<TEvent> {
  readonly toolCallId: string | null;
  readonly pairingRole: "initiation" | "completion" | "unpaired";
  readonly event: TEvent;
}

/**
 * The bounded reorder buffer for a boundary that pairs tool events by `toolCallId`: the only
 * reordering is holding a completion that arrives before its initiation. Overflow and pairing
 * timeout flush in arrival order, each with a diagnostic; the clock is caller-supplied (`nowMs`).
 */
export class NormalizedEventReorderBuffer<TEvent> {
  /** Seen-initiation cap when the caller declares none. */
  static readonly DEFAULT_MAX_SEEN_INITIATION_IDS = 1024;

  readonly #provider: ProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxBufferedEvents: number;
  readonly #pairingTimeoutMs: number;
  readonly #maxSeenInitiationIds: number;
  readonly #heldCompletions: {
    readonly buffered: ReorderBufferedEvent<TEvent>;
    readonly heldAtMs: number;
  }[] = [];
  // Capped and drained on pairing: one identity is added per tool call and no completion is
  // guaranteed, so unbounded it would leak. Insertion-ordered, so eviction takes the oldest.
  readonly #seenInitiationToolCallIds = new Set<string>();

  constructor(options: {
    readonly provider: ProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly maxBufferedEvents: number;
    readonly pairingTimeoutMs: number;
    readonly maxSeenInitiationIds?: number;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#maxBufferedEvents = options.maxBufferedEvents;
    this.#pairingTimeoutMs = options.pairingTimeoutMs;
    this.#maxSeenInitiationIds =
      options.maxSeenInitiationIds ?? NormalizedEventReorderBuffer.DEFAULT_MAX_SEEN_INITIATION_IDS;
  }

  /** Admits one event; returns the events it releases, in order. */
  admit(buffered: ReorderBufferedEvent<TEvent>, nowMs: number): readonly TEvent[] {
    const released: TEvent[] = [...this.#releaseExpired(nowMs)];

    if (buffered.pairingRole === "completion" && buffered.toolCallId !== null) {
      if (!this.#seenInitiationToolCallIds.has(buffered.toolCallId)) {
        this.#heldCompletions.push({ buffered, heldAtMs: nowMs });
        if (this.#heldCompletions.length > this.#maxBufferedEvents) {
          released.push(...this.#flushAllOnOverflow());
        }
        return released;
      }
      this.#seenInitiationToolCallIds.delete(buffered.toolCallId);
      released.push(buffered.event);
      return released;
    }

    if (buffered.pairingRole === "initiation" && buffered.toolCallId !== null) {
      this.#admitSeenInitiation(buffered.toolCallId);
      released.push(buffered.event);
      const pairedCompletions = this.#releaseHeldCompletionsFor(buffered.toolCallId);
      if (pairedCompletions.length > 0) {
        this.#seenInitiationToolCallIds.delete(buffered.toolCallId);
      }
      released.push(...pairedCompletions);
      return released;
    }

    released.push(buffered.event);
    return released;
  }

  /** Releases held events whose pairing timeout has expired, emitting a diagnostic for each. */
  flushExpired(nowMs: number): readonly TEvent[] {
    return this.#releaseExpired(nowMs);
  }

  #admitSeenInitiation(toolCallId: string): void {
    this.#seenInitiationToolCallIds.add(toolCallId);
    while (this.#seenInitiationToolCallIds.size > this.#maxSeenInitiationIds) {
      const oldestEntry = this.#seenInitiationToolCallIds.values().next();
      if (oldestEntry.done === true) {
        return;
      }
      this.#seenInitiationToolCallIds.delete(oldestEntry.value);
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "reorder_seen_initiation_evicted",
        rawWireType: null,
        dispositionReason:
          "seen-initiation set exceeded its declared cap; oldest identity evicted, so a " +
          "later completion for it holds instead of pairing",
        details: {
          toolCallId: oldestEntry.value,
          maxSeenInitiationIds: this.#maxSeenInitiationIds,
        },
      });
    }
  }

  #releaseHeldCompletionsFor(toolCallId: string): TEvent[] {
    const released: TEvent[] = [];
    for (let index = this.#heldCompletions.length - 1; index >= 0; index -= 1) {
      const held = this.#heldCompletions[index];
      if (held !== undefined && held.buffered.toolCallId === toolCallId) {
        this.#heldCompletions.splice(index, 1);
        released.unshift(held.buffered.event);
      }
    }
    return released;
  }

  #releaseExpired(nowMs: number): TEvent[] {
    const released: TEvent[] = [];
    for (let index = 0; index < this.#heldCompletions.length; ) {
      const held = this.#heldCompletions[index];
      if (held !== undefined && nowMs - held.heldAtMs >= this.#pairingTimeoutMs) {
        this.#heldCompletions.splice(index, 1);
        released.push(held.buffered.event);
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "tool_pairing_timeout",
          rawWireType: null,
          dispositionReason:
            "unpaired toolCallId held past the reorder buffer's pairing timeout; flushed in " +
            "arrival order",
          details: {
            toolCallId: held.buffered.toolCallId,
            heldForMs: nowMs - held.heldAtMs,
            pairingTimeoutMs: this.#pairingTimeoutMs,
          },
        });
      } else {
        index += 1;
      }
    }
    return released;
  }

  #flushAllOnOverflow(): TEvent[] {
    const flushed = this.#heldCompletions.map((held) => held.buffered.event);
    const flushedCount = this.#heldCompletions.length;
    this.#heldCompletions.length = 0;
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "reorder_buffer_overflow",
      rawWireType: null,
      dispositionReason:
        "reorder buffer exceeded its maximum buffered-event cap; flushed in arrival order",
      details: { flushedEventCount: flushedCount, maxBufferedEvents: this.#maxBufferedEvents },
    });
    return flushed;
  }
}
