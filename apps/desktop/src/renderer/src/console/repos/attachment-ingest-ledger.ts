// The carrier's ledger: which attachments there are, in which order, and where each
// one's ingest stands.
//
// It is a separate module from `attachment-ingest.ts` because the two answer
// different questions. The ledger answers "what does this carrier hold right now",
// and every one of its operations settles before it returns. The client answers "what
// has been sent", and every one of its operations spans an await. Keeping them in one
// class made the file two jobs long, and it also hid the seam that matters: a
// continuation coming back from an await has to consult the ledger rather than the
// entry it captured, because a participant can act while a call is in flight.
//
// ORDER IS PARTICIPANT-DECLARED AND PRESERVED END TO END, which `Spec-014 §Required
// Behavior` requires of the reference and this is the first place it can be lost. So
// the order lives in an explicit array of local ids rather than in a `Map`'s insertion
// order, and `reorder` moves a member inside it — a drag round-trips because the array
// is the record, not a rendering of one.

import { Emitter, type Unsubscribe } from "../core/index.js";
import type {
  AttachmentIngestEntry,
  AttachmentIngestState,
  AttachmentSource,
} from "./attachment-model.js";

/** One entry's fields, minus the bookkeeping the ledger stamps for itself. */
export type AttachmentLedgerWrite = Omit<AttachmentIngestEntry, "declared">;

/**
 * What one entry stood at, taken before an await and checked after it.
 *
 * The generation is the ledger's own record of how many times an entry has been
 * rewritten, and it is what makes the check total: two states can be equal across an
 * await that changed and changed back, and a counter that only ever rises cannot be.
 * It is NOT on the entry a card renders, because it is bookkeeping about the record
 * rather than anything a participant is shown.
 */
export interface AttachmentLedgerStamp {
  readonly state: AttachmentIngestState;
  readonly generation: number;
}

export class AttachmentIngestLedger {
  readonly #entriesByLocalId = new Map<string, AttachmentIngestEntry>();
  readonly #generationByLocalId = new Map<string, number>();
  readonly #declaredOrder: string[] = [];
  readonly #changes = new Emitter<readonly AttachmentIngestEntry[]>("attachment ingest");

  #snapshot: readonly AttachmentIngestEntry[] = [];
  #disposed = false;

  /** The carrier, in declared order. Stable identity between publishes. */
  public get snapshot(): readonly AttachmentIngestEntry[] {
    return this.#snapshot;
  }

  public subscribe(sink: (entries: readonly AttachmentIngestEntry[]) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this carrier already holds an attachment under this local id. */
  public holds(localId: string): boolean {
    return this.#entriesByLocalId.has(localId);
  }

  /** The entry as it stands, or `undefined` once it is gone or the ledger is disposed. */
  public current(localId: string): AttachmentIngestEntry | undefined {
    return this.#disposed ? undefined : this.#entriesByLocalId.get(localId);
  }

  /** What this entry stands at now, for a continuation to check against later. */
  public stamp(localId: string): AttachmentLedgerStamp | undefined {
    const entry = this.current(localId);
    if (entry === undefined) {
      return undefined;
    }
    return { state: entry.state, generation: this.#generationByLocalId.get(localId) ?? 0 };
  }

  /**
   * The entry, but only if nothing has touched it since the stamp was taken.
   *
   * Every continuation that comes back from an await asks this rather than acting on
   * the entry it captured. A participant can abandon or remove an attachment while a
   * call is in flight, and a continuation that wrote its captured entry back would
   * restore the state that abandonment replaced — resuming an upload somebody stopped.
   */
  public currentIfUnchanged(
    localId: string,
    stamp: AttachmentLedgerStamp,
  ): AttachmentIngestEntry | undefined {
    const entry = this.current(localId);
    if (entry === undefined || entry.state !== stamp.state) {
      return undefined;
    }
    return (this.#generationByLocalId.get(localId) ?? 0) === stamp.generation ? entry : undefined;
  }

  /** Take one attachment into the carrier, at the end of the declared order. */
  public declare(source: AttachmentSource): void {
    this.#declaredOrder.push(source.localId);
    this.#generationByLocalId.set(source.localId, 0);
    this.#entriesByLocalId.set(source.localId, {
      declared: source,
      state: "declared",
      receivedBytes: 0,
      ingestId: undefined,
      derived: undefined,
      refusal: undefined,
      disposition: undefined,
      openedAtMilliseconds: undefined,
      lastProgressAtMilliseconds: undefined,
    });
    this.#publish();
  }

  /**
   * Record one attachment's new standing.
   *
   * The declaration is carried over rather than accepted from the caller: it is what
   * the participant handed over and nothing after the attach may replace it, which is
   * also what keeps the payload handle and its declared length together.
   */
  public write(localId: string, fields: AttachmentLedgerWrite): void {
    const existing = this.#entriesByLocalId.get(localId);
    if (existing === undefined) {
      return;
    }
    this.#entriesByLocalId.set(localId, { ...fields, declared: existing.declared });
    this.#generationByLocalId.set(localId, (this.#generationByLocalId.get(localId) ?? 0) + 1);
    this.#publish();
  }

  /** Take one attachment out of the carrier entirely, position included. */
  public remove(localId: string): void {
    const position = this.#declaredOrder.indexOf(localId);
    if (position < 0) {
      return;
    }
    this.#declaredOrder.splice(position, 1);
    this.#entriesByLocalId.delete(localId);
    this.#generationByLocalId.delete(localId);
    this.#publish();
  }

  /** Move one attachment to a new declared position, clamped inside the carrier. */
  public reorder(localId: string, toPosition: number): void {
    const fromPosition = this.#declaredOrder.indexOf(localId);
    if (fromPosition < 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(this.#declaredOrder.length - 1, toPosition));
    this.#declaredOrder.splice(fromPosition, 1);
    this.#declaredOrder.splice(clamped, 0, localId);
    this.#publish();
  }

  /**
   * The reference a carrier would carry: artifact ids, ordered, and nothing else.
   *
   * Only completed ingests contribute, because an artifact id is what an ingest MINTS —
   * there is nothing to name before then. The result is exactly the typed `ArtifactId[]`
   * shape `Spec-014` specifies, held as strings because the console never mints an
   * identity of its own.
   */
  public artifactIds(): readonly string[] {
    const artifactIds: string[] = [];
    for (const localId of this.#declaredOrder) {
      const artifactId = this.#entriesByLocalId.get(localId)?.derived?.artifactId;
      if (artifactId !== undefined) {
        artifactIds.push(artifactId);
      }
    }
    return artifactIds;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#changes.clear();
  }

  #publish(): void {
    const entries: AttachmentIngestEntry[] = [];
    for (const localId of this.#declaredOrder) {
      const entry = this.#entriesByLocalId.get(localId);
      if (entry !== undefined) {
        entries.push(entry);
      }
    }
    this.#snapshot = entries;
    this.#changes.emit(this.#snapshot);
  }
}
