// The staged list's record: which attachments there are, in order, and where each one's ingest
// stands. Every operation settles before it returns, and a continuation returning from an await
// must consult the record rather than the entry it captured, since a user can act mid-call.
// Order is attach order, kept in an explicit array of local ids. An entry holds the user's `Blob`
// only while a send is still possible (`declared`, `ingesting`, or `refused` with a retry to
// offer); settled entries are built through `attachmentIngestEntryFrom`, whose settled arm has no
// payload member, so ten finished uploads do not pin ten files of memory. A write moving a settled
// entry back into a sending state is refused.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
} from "#renderer/lib/reads/generation-latch.js";
import { ingestRefusalDisposition, type IngestRefusalDisposition } from "./policy.js";
import {
  attachmentIngestEntryFrom,
  type AttachmentIngestEntry,
  type AttachmentIngestRecord,
  type AttachmentIngestState,
  type AttachmentSource,
} from "./shapes.js";

/**
 * What one entry stood at, taken before an await and checked after it. The claim is the round
 * the entry was on, so the check is total even if the state changed and changed back. It comes
 * from the shared generation register, which frees a key on supersede.
 */
export interface AttachmentIngestStamp {
  readonly state: AttachmentIngestState;
  readonly claim: CurrentGenerationClaim;
}

/** The record of staged attachments, publishing an ordered snapshot on every change. */
export class AttachmentIngestEntries {
  readonly #entriesByLocalId = new Map<string, AttachmentIngestEntry>();
  /** The rounds entries are on, one key per local id. Never a module-level singleton. */
  readonly #rounds = new GenerationLatch();
  readonly #declaredOrder: string[] = [];
  readonly #changes = new Emitter<readonly AttachmentIngestEntry[]>("attachment ingest");

  #snapshot: readonly AttachmentIngestEntry[] = [];
  #disposed = false;

  /** The staged list, in declared order. Stable identity between publishes. */
  public get snapshot(): readonly AttachmentIngestEntry[] {
    return this.#snapshot;
  }

  /** Subscribes to each publish of the snapshot; returns the unsubscribe. */
  public subscribe(sink: (entries: readonly AttachmentIngestEntry[]) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this staged list already holds an attachment under this local id. */
  public holds(localId: string): boolean {
    return this.#entriesByLocalId.has(localId);
  }

  /** The entry as it stands, or `undefined` once it is gone or the record is disposed. */
  public current(localId: string): AttachmentIngestEntry | undefined {
    return this.#disposed ? undefined : this.#entriesByLocalId.get(localId);
  }

  /** What this entry stands at now, for a continuation to check against later. */
  public stamp(localId: string): AttachmentIngestStamp | undefined {
    const entry = this.current(localId);
    if (entry === undefined) {
      return undefined;
    }
    return { state: entry.state, claim: this.#rounds.currentClaim(this, localId) };
  }

  /**
   * The entry, but only if nothing has touched it since the stamp was taken. A continuation that
   * wrote its captured entry back would resume an upload somebody abandoned.
   */
  public currentIfUnchanged(
    localId: string,
    stamp: AttachmentIngestStamp,
  ): AttachmentIngestEntry | undefined {
    const entry = this.current(localId);
    if (entry === undefined || entry.state !== stamp.state) {
      return undefined;
    }
    return stamp.claim.isCurrent ? entry : undefined;
  }

  /** Take one attachment into the staged list, at the end of the declared order. */
  public declare(source: AttachmentSource): void {
    const localId = source.declared.localId;
    this.#declaredOrder.push(localId);
    this.#entriesByLocalId.set(localId, {
      declared: source.declared,
      payload: source.payload,
      state: "declared",
      receivedBytes: 0,
      ingestId: undefined,
      derived: undefined,
      refusal: undefined,
      disposition: undefined,
      lastProgressAtMilliseconds: undefined,
    });
    this.#publish();
  }

  /**
   * Records one attachment's new standing. The declaration is carried over from the existing
   * entry, and the payload only as far as the new state can send it, so spreading a whole
   * settled entry cannot carry its bytes forward and a move back into a sending state writes
   * nothing.
   */
  public write(localId: string, record: AttachmentIngestRecord): void {
    const existing = this.#entriesByLocalId.get(localId);
    if (existing === undefined) {
      return;
    }
    const written = attachmentIngestEntryFrom(existing, record);
    if (written === undefined) {
      return;
    }
    this.#entriesByLocalId.set(localId, written);
    // Stamps taken before this write are about a record that has been replaced.
    this.#rounds.supersede(this, localId);
    this.#publish();
  }

  /** Take one attachment out of the staged list entirely, position included. */
  public remove(localId: string): void {
    const position = this.#declaredOrder.indexOf(localId);
    if (position < 0) {
      return;
    }
    this.#declaredOrder.splice(position, 1);
    this.#entriesByLocalId.delete(localId);
    this.#rounds.supersede(this, localId);
    this.#publish();
  }

  /** Ends the record: continuations lose their rounds and subscribers are dropped. */
  public dispose(): void {
    this.#disposed = true;
    this.#rounds.supersedeAll();
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

/**
 * Records a refusal verbatim on one entry with the disposition that decides what the control
 * offers. Takes the entry the caller re-read after the await, so a refusal never overwrites a
 * state the user moved meanwhile. The disposition is derived from the code unless stated: an
 * unusable acknowledgement states `restart`, since retrying in place would send against an
 * offset the two sides do not share.
 */
export function writeIngestRefusal(
  entries: AttachmentIngestEntries,
  localId: string,
  entry: AttachmentIngestEntry,
  refusal: { readonly code: string; readonly detail: string },
  disposition?: IngestRefusalDisposition,
): void {
  entries.write(localId, {
    ...entry,
    state: "refused",
    refusal,
    disposition: disposition ?? ingestRefusalDisposition(refusal.code),
  });
}
