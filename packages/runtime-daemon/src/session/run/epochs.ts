// Which execution each provider delivery belongs to: one cursor per runtime binding, counting the
// turns seen in the binding's delivery order, the provider operations opened on it, and the fence
// an undo's confirmed cut sets. Nothing here is a guess made at read time: a delivery is
// attributed from what the binding delivered before it.

import type { SourceEpoch, SourcePosition } from "@ai-sidekicks/contracts/event/envelope";
import type { EpochPosition } from "@ai-sidekicks/contracts/transcript/turn-attribution";

import type { DriverDiagnosticsEmitter } from "../../provider/driver/diagnostics.js";
import type { RuntimeBinding } from "../../provider/runtime-binding-store.js";

/** The runtime binding a cursor counts deliveries for. */
export type EpochBinding = Pick<RuntimeBinding, "id" | "runId" | "driverName">;

/**
 * The provider-side operation a delivery belongs to (a tool call, a message item, an artifact), by
 * the key the provider correlates its deliveries with. The first delivery of every operation is
 * passed as its opening; a later one that finds no opening held is read as one evicted.
 */
export interface DeliveryOperation {
  readonly correlationKey: string;
  readonly isOpening: boolean;
}

/**
 * Which execution a delivery belongs to: the current one, the one before an undo's cut, or unknown
 * for an operation whose opening was evicted, which may be from before the cut at `source`.
 */
export type DeliveryAttribution =
  | { readonly execution: "current" }
  | { readonly execution: "before_cut"; readonly source: EpochPosition }
  | { readonly execution: "unknown"; readonly source: EpochPosition };

/**
 * An undo's cut, confirmed by the provider. In place, the binding stays and its deliveries after
 * the fence open the new epoch at `point`; by a fork and restart, the old binding freezes whole and
 * `newBinding` opens the new epoch at `point`.
 */
export type ConfirmedCut =
  | { readonly mode: "in_place"; readonly bindingId: string; readonly point: SourcePosition }
  | {
      readonly mode: "fork_restart";
      readonly bindingId: string;
      readonly point: SourcePosition;
      readonly newBinding: EpochBinding;
    };

// Operations remembered per binding when the caller sets no cap. Measured on Node 24, each costs
// about 60 bytes before its key when several open in one turn and 96 when each opens its own, plus
// the key (48 bytes for a 31-character item id), so a binding at the cap holds 420 KB to 580 KB.
const DEFAULT_MAX_ASSOCIATIONS_PER_BINDING = 4096;

interface BindingCursor {
  readonly binding: EpochBinding;
  // The open generation's pair; its position moves at each turn boundary.
  current: EpochPosition;
  // Set when a fork and restart froze the binding: every later delivery belongs to this pair.
  frozenAt: EpochPosition | undefined;
  // The retained pair of each generation an in-place cut closed, oldest first. Those below the
  // newest evicted association's epoch are pruned, the latest kept, since no lookup asks for them.
  readonly closedGenerations: EpochPosition[];
  // Each operation's pair when it opened, oldest first, capped.
  readonly associations: Map<string, EpochPosition>;
  newestEvictedEpoch: SourceEpoch | undefined;
}

const CURRENT: DeliveryAttribution = Object.freeze({ execution: "current" });

/**
 * The cursors of the open runtime bindings. Calls for one binding are made in its delivery order,
 * the fence among them, since each attribution is decided from the calls before it.
 */
export class ExecutionEpochs {
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #maxAssociationsPerBinding: number;
  // One entry per binding opened and not yet closed.
  readonly #cursorByBinding = new Map<string, BindingCursor>();

  constructor(options: {
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly maxAssociationsPerBinding?: number;
  }) {
    this.#diagnostics = options.diagnostics;
    this.#maxAssociationsPerBinding =
      options.maxAssociationsPerBinding ?? DEFAULT_MAX_ASSOCIATIONS_PER_BINDING;
  }

  /** Opens a binding's cursor at `start`, the epoch and turn its conversation stands at. */
  openBinding(binding: EpochBinding, start: EpochPosition): void {
    if (this.#cursorByBinding.has(binding.id)) {
      throw new Error(`Runtime binding ${binding.id} already has an epoch cursor`);
    }
    this.#cursorByBinding.set(binding.id, {
      binding,
      current: start,
      frozenAt: undefined,
      closedGenerations: [],
      associations: new Map(),
      newestEvictedEpoch: undefined,
    });
  }

  /** Drops a binding's cursor once the binding has ended and delivers nothing more. */
  closeBinding(bindingId: string): void {
    this.#cursorByBinding.delete(bindingId);
  }

  /** The binding a cursor counts for. Throws for a binding with no open cursor. */
  bindingFor(bindingId: string): EpochBinding {
    return this.#cursorFor(bindingId).binding;
  }

  /**
   * Counts a turn boundary the binding delivered: the current generation moves to its next turn.
   * On a frozen binding nothing moves, and the boundary belongs to the execution before the cut.
   */
  openTurn(bindingId: string): DeliveryAttribution {
    const cursor = this.#cursorFor(bindingId);
    if (cursor.frozenAt !== undefined) {
      return { execution: "before_cut", source: cursor.frozenAt };
    }
    cursor.current = { epoch: cursor.current.epoch, position: cursor.current.position + 1 };
    return CURRENT;
  }

  /**
   * Attributes one delivery. With an operation, the pair it opened at decides, and an opening is
   * recorded at the current pair, afresh when its key last opened before a cut; without one, a
   * frozen binding's delivery takes its retained pair and an in-place binding's is current, by the
   * fence's order.
   */
  attribute(bindingId: string, operation?: DeliveryOperation): DeliveryAttribution {
    const cursor = this.#cursorFor(bindingId);
    const opened =
      operation === undefined ? undefined : cursor.associations.get(operation.correlationKey);
    if (cursor.frozenAt !== undefined) {
      return { execution: "before_cut", source: opened ?? cursor.frozenAt };
    }
    if (operation === undefined || opened?.epoch === cursor.current.epoch) {
      return CURRENT;
    }
    if (operation.isOpening) {
      // A provider may reuse an operation's key after an in-place cut; the reuse is a new
      // operation, moved to the newest slot so eviction drops it last.
      cursor.associations.delete(operation.correlationKey);
      this.#recordOpening(cursor, operation.correlationKey);
      return CURRENT;
    }
    return opened === undefined
      ? attributeEvictedOperation(cursor)
      : { execution: "before_cut", source: opened };
  }

  /** Sets the fence of a confirmed cut. Throws for a binding with no open cursor or one frozen. */
  fenceCut(cut: ConfirmedCut): void {
    const cursor = this.#cursorFor(cut.bindingId);
    if (cursor.frozenAt !== undefined) {
      throw new Error(`Runtime binding ${cut.bindingId} froze at an earlier cut`);
    }
    const next: EpochPosition = { epoch: cursor.current.epoch + 1, position: cut.point };
    if (cut.mode === "in_place") {
      cursor.closedGenerations.push(cursor.current);
      cursor.current = next;
      return;
    }
    this.openBinding(cut.newBinding, next);
    cursor.frozenAt = cursor.current;
  }

  #cursorFor(bindingId: string): BindingCursor {
    const cursor = this.#cursorByBinding.get(bindingId);
    if (cursor === undefined) {
      throw new Error(`Runtime binding ${bindingId} has no epoch cursor open`);
    }
    return cursor;
  }

  #recordOpening(cursor: BindingCursor, correlationKey: string): void {
    cursor.associations.set(correlationKey, cursor.current);
    if (cursor.associations.size <= this.#maxAssociationsPerBinding) {
      return;
    }
    const [evictedKey, evicted] = cursor.associations.entries().next().value as [
      string,
      EpochPosition,
    ];
    cursor.associations.delete(evictedKey);
    cursor.newestEvictedEpoch = evicted.epoch;
    const firstKept = cursor.closedGenerations.findIndex(
      (generation) => generation.epoch >= evicted.epoch,
    );
    const latestIndex = cursor.closedGenerations.length - 1;
    cursor.closedGenerations.splice(0, firstKept === -1 ? latestIndex : firstKept);
    this.#diagnostics.emit({
      provider: cursor.binding.driverName,
      kind: "epoch_association_evicted",
      rawWireType: null,
      dispositionReason:
        "the binding's operation associations reached their cap, so the oldest was dropped; once " +
        "a cut has closed a generation, a late row of that operation is stamped as from before " +
        "the cut, and its lifecycle event or permission ask is read as current",
      details: {
        bindingId: cursor.binding.id,
        evictedEpoch: evicted.epoch,
        evictedPosition: evicted.position,
        maxAssociationsPerBinding: this.#maxAssociationsPerBinding,
      },
    });
  }
}

// A continuation of an operation the binding does not hold. With nothing evicted it never opened
// here and is current, by the fence's order. Otherwise it opened no later than the newest evicted
// operation, so once a generation has closed it may be from one: its execution is unknown, with the
// pair of the generation it may be from.
function attributeEvictedOperation(cursor: BindingCursor): DeliveryAttribution {
  const latestClosed = cursor.closedGenerations.at(-1);
  if (cursor.newestEvictedEpoch === undefined || latestClosed === undefined) {
    return CURRENT;
  }
  const evictedGeneration = cursor.closedGenerations.find(
    (generation) => generation.epoch === cursor.newestEvictedEpoch,
  );
  return { execution: "unknown", source: evictedGeneration ?? latestClosed };
}
