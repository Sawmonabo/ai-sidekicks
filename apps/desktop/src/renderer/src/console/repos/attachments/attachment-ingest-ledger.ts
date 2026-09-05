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
//
// AND THE LEDGER IS WHERE A FINISHED UPLOAD'S BYTES ARE RELEASED. THE RULE, EXACTLY:
// an entry holds the participant's `Blob` while — and only while — a send is still
// possible from where it stands. `declared`, `ingesting`, and `refused` can still send,
// so they hold it; `complete` has minted its artifact and `abandoned` has stopped for
// good, so neither does. This is the only writer, so it is the only place the rule can
// be applied — and it is applied by CONSTRUCTION rather than by a delete: a settled
// entry is built through `attachmentIngestEntryFrom`, whose settled arm has no payload
// member to put one in. What that is worth: a `Blob` is a handle, but it is a KEEP, so
// a carrier that held ten finished uploads held ten files' worth of the browser's
// memory until the surface unmounted. A write that would move a settled entry back into
// a sending state is refused outright — those bytes are gone, and an entry claiming a
// payload it does not have would fail at the next slice instead of here.

import { Emitter, type Unsubscribe } from "../../core/index.js";
import { GenerationLatch, type CurrentGenerationClaim } from "../../store/index.js";
import type { PortAnswer } from "./attachment-ingest-answer.js";
import { ingestRefusalDisposition, type IngestRefusalDisposition } from "./attachment-policy.js";
import {
  attachmentIngestEntryFrom,
  type AttachmentIngestEntry,
  type AttachmentIngestRecord,
  type AttachmentIngestState,
  type AttachmentSource,
} from "./attachment-shapes.js";

/**
 * What one entry stood at, taken before an await and checked after it.
 *
 * The claim is the round this entry was on when the stamp was taken, and it is what
 * makes the check total: two states can be equal across an await that changed and
 * changed back, and a round a write superseded can never be current again. It is NOT
 * on the entry a card renders, because it is bookkeeping about the record rather than
 * anything a participant is shown.
 *
 * IT IS THE CONSOLE'S ONE GENERATION REGISTER RATHER THAN A COUNTER OF THIS FILE'S
 * OWN. The hand-rolled `Map<string, number>` this replaces was a second implementation
 * of `store/generation-latch.ts` — and one whose size nothing bounded or reported,
 * where the register frees a key on the supersede and answers `heldKeyCount` for what
 * it still holds.
 */
export interface AttachmentLedgerStamp {
  readonly state: AttachmentIngestState;
  readonly claim: CurrentGenerationClaim;
}

export class AttachmentIngestLedger {
  readonly #entriesByLocalId = new Map<string, AttachmentIngestEntry>();
  /** The rounds entries are on, one key per local id. Never a module-level singleton. */
  readonly #rounds = new GenerationLatch();
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
    return { state: entry.state, claim: this.#rounds.currentClaim(this, localId) };
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
    return stamp.claim.isCurrent ? entry : undefined;
  }

  /** Take one attachment into the carrier, at the end of the declared order. */
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
      openedAtMilliseconds: undefined,
      lastProgressAtMilliseconds: undefined,
    });
    this.#publish();
  }

  /**
   * Record one attachment's new standing.
   *
   * The declaration is carried over rather than accepted from the caller: it is what
   * the participant handed over and nothing after the attach may replace it. The
   * PAYLOAD is carried the same way and only as far as the new state can send it, which
   * is the release rule at the top of this file — so a caller composing its record by
   * spreading the whole standing entry cannot carry a finished upload's bytes forward,
   * and a caller trying to move a settled entry back into a sending state writes
   * nothing at all.
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
    // Every stamp taken before this write is now about a record that no longer stands,
    // so the round it named ends here and the key goes back.
    this.#rounds.supersede(this, localId);
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
    this.#rounds.supersede(this, localId);
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

  /** How many entries a continuation is still holding a round on. The register's bound. */
  public get heldRoundCount(): number {
    return this.#rounds.heldKeyCount(this);
  }

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
 * Record a refusal verbatim on one entry, with the disposition that decides what the
 * control offers.
 *
 * A FUNCTION OVER THE LEDGER rather than a method on either driver, because both of
 * them write it: the open-and-complete driver and the chunk loop each end their leg
 * here, and a copy in each would be two chances for one of them to derive a disposition
 * the other does not. `artifact-action-host.ts`'s `recordRowRefusal` is the same shape
 * one family over.
 *
 * Takes the entry its caller re-read after the await rather than reading one itself, so
 * a refusal can never be written over a state a participant moved meanwhile.
 *
 * THE DISPOSITION IS DERIVED FROM THE CODE UNLESS A CALLER STATES IT, and the one
 * caller that states it is the console's own finding about an unusable acknowledgement
 * — a code `Spec-014` does not name, whose retry-in-place default would send the next
 * chunk against an offset the two sides have stopped sharing.
 */
export function writeIngestRefusal(
  ledger: AttachmentIngestLedger,
  localId: string,
  entry: AttachmentIngestEntry,
  answer: PortAnswer<unknown>,
  disposition?: IngestRefusalDisposition,
): void {
  const code = answer.code ?? "attachment.ingest_rejected";
  ledger.write(localId, {
    ...entry,
    state: "refused",
    refusal: { code, detail: answer.detail ?? "The ingest call was refused." },
    disposition: disposition ?? ingestRefusalDisposition(code),
  });
}
