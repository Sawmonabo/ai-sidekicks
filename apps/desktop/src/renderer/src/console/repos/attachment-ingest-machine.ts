// The ingest protocol: three calls, a bounded slice of the payload on each one, a
// decoded-byte ledger, and a retry that replays.
//
// THE CHUNKING, THE DECODED-BYTE ACCOUNTING, AND THE REPLAY-SAFE RETRY are on the
// console's own side of the seam, and this module is where that is decided and why:
// all three are `Spec-014` CONTRACT behaviour, and a generic upload library would
// obscure every one of them. So this is own-built, and a class with private fields
// rather than a hook holding four `useState`s.
//
// THREE MODULES, THREE SUBJECTS. The carrier's own record — which attachments there
// are, in which order, and where each one stands — is `attachment-ingest-ledger.ts`;
// giving a stopped stream's spool back is `attachment-ingest-abort.ts`, whose rules
// are the opposite of this file's in every respect that matters; and the narrowing
// both legs read a port answer through is `attachment-ingest-answer.ts`. This module
// owns the protocol and nothing else.
//
// WHAT IT CALLS, AND WHAT ANSWERS TODAY. The trio `AttachmentIngestInit`,
// `AttachmentIngestChunk`, `AttachmentIngestComplete` is typed in the corpus and
// registers NO method string anywhere, so every leg goes through
// `bridge/growth-port.ts` and comes back `wire-unregistered` against the
// `artifact-ingest-and-crud` slate row. That is not a stub: the chunk loop runs, every
// request carries exactly the members the registered shape names, the ledger advances
// on whatever is acknowledged, and the refusal renders where the progress would have.
// When the wire lands, the port's methods stop refusing and this file does not change.
//
// THE BYTES ARE SENT, NOT DESCRIBED. Each chunk carries the base64 of one slice read
// out of the participant's own `Blob`. A request that described a size and carried no
// payload would let this client advance its ledger and call Complete over a stream the
// daemon received nothing on — minting an empty artifact rather than the file. The
// slice bounds memory too: `ATTACHMENT_CHUNK_BYTE_CAP` raw bytes at a time, so a
// hundred-megabyte upload never holds more than one chunk.
//
// RETRY REPLAYS, IT DOES NOT RESTART. Every call of the trio is retry-safe: a replayed
// chunk — same sequence number, same bytes — is acknowledged without being re-appended,
// and a replayed completion replays its original response verbatim. So a lost response
// resumes at the current offset. The two codes whose disposition differs are named and
// classified in `attachment-model.ts`; this file acts on that and invents no policy.
//
// A PARTICIPANT CAN ACT WHILE A CALL IS IN FLIGHT, so every continuation re-reads the
// ledger after its await and proceeds only if the entry still stands where it stood.
// Abandonment makes this load-bearing: an upload stopped while Init was in flight
// would otherwise be resumed by the continuation writing its captured entry back, and
// one stopped mid-chunk would stream on to completion. A stale continuation writes
// nothing. The one thing it does do is give back the spool the daemon opened
// underneath it, which nobody else can: that ingest id reached no ledger entry, so
// `abandon` never saw it.
//
// NO TIMER, ANYWHERE. The client performs work when a participant asks it to — attach,
// retry, abandon — and at no other moment. There is no interval, no backoff timer, and
// no automatic re-drive: `wait-and-retry` is a sentence a person reads and a control
// they press, because a console that retried a 429 on its own would hide the capacity
// problem it exists to report.

import type { ConsoleBridge } from "../bridge/index.js";
import {
  ATTACHMENT_CHUNK_BYTE_CAP,
  RealClock,
  encodeBase64,
  type ConsoleClock,
  type Unsubscribe,
} from "../core/index.js";
import { AttachmentSpoolReclaimer } from "./attachment-ingest-abort.js";
import type { PortAnswer } from "./attachment-ingest-answer.js";
import { AttachmentIngestLedger } from "./attachment-ingest-ledger.js";
import {
  advanceReceivedBytes,
  ingestRefusalDisposition,
  type AttachmentIngestEntry,
  type AttachmentSource,
} from "./attachment-model.js";

export interface AttachmentIngestClientOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** Injected so a test drives every stream on frozen time with no real clock. */
  readonly clock?: ConsoleClock;
}

/** Every attachment a participant has handed this carrier, in the order they chose. */
export class AttachmentIngestClient {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
  readonly #ledger = new AttachmentIngestLedger();
  readonly #reclaimer: AttachmentSpoolReclaimer;
  readonly #runningLocalIds = new Set<string>();

  #disposed = false;

  public constructor(options: AttachmentIngestClientOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock ?? new RealClock();
    this.#reclaimer = new AttachmentSpoolReclaimer(options.bridge);
  }

  /** The carrier, in declared order. Stable identity between publishes. */
  public get snapshot(): readonly AttachmentIngestEntry[] {
    return this.#ledger.snapshot;
  }

  public subscribe(sink: (entries: readonly AttachmentIngestEntry[]) => void): Unsubscribe {
    return this.#ledger.subscribe(sink);
  }

  /**
   * Take one attachment and begin its stream.
   *
   * The count cap is NOT enforced here. `Spec-014` refuses the whole carrier at
   * acceptance with `artifact.too_many_attachments` and leaves every artifact minted by
   * an earlier ingest untouched, so a client that blocked the eleventh attach would be
   * deriving eligibility the daemon owns — and would be wrong the moment an operator
   * raises the bound. The count is rendered against its cap and the daemon decides.
   */
  public attach(source: AttachmentSource): void {
    if (this.#disposed || this.#ledger.holds(source.localId)) {
      return;
    }
    this.#ledger.declare(source);
    void this.#drive(source.localId);
  }

  /**
   * Send again after a refusal.
   *
   * The disposition decides the shape: `restart` drops the stream identity and the
   * ledger and begins from the first byte, and every other disposition resumes at the
   * current offset — which is what makes a lost response cost one chunk rather than the
   * whole upload.
   */
  public retry(localId: string): void {
    const entry = this.#ledger.current(localId);
    if (entry === undefined || this.#runningLocalIds.has(localId)) {
      return;
    }
    const restarting = entry.disposition === "restart";
    this.#ledger.write(localId, {
      ...entry,
      state: "declared",
      refusal: undefined,
      disposition: undefined,
      ...(restarting
        ? { ingestId: undefined, receivedBytes: 0, openedAtMilliseconds: undefined }
        : {}),
    });
    void this.#drive(localId);
  }

  /**
   * Stop sending, and ask for the spool back.
   *
   * The state moves immediately because sending stops immediately; the abort call is
   * best-effort and its refusal changes nothing a participant needs to act on, which is
   * why the copy states the reaper rather than promising an instant reclaim.
   */
  public abandon(localId: string): void {
    const entry = this.#ledger.current(localId);
    if (entry === undefined || entry.state === "complete") {
      return;
    }
    this.#ledger.write(localId, { ...entry, state: "abandoned", disposition: undefined });
    this.#reclaimer.request(entry.ingestId);
  }

  /** Take one attachment out of the carrier entirely, position included. */
  public remove(localId: string): void {
    if (!this.#ledger.holds(localId)) {
      return;
    }
    this.abandon(localId);
    this.#ledger.remove(localId);
  }

  /** Move one attachment to a new declared position, clamped inside the carrier. */
  public reorder(localId: string, toPosition: number): void {
    this.#ledger.reorder(localId, toPosition);
  }

  /** The reference a carrier would carry: artifact ids, ordered, and nothing else. */
  public attachmentArtifactIds(): readonly string[] {
    return this.#ledger.artifactIds();
  }

  /**
   * Stop the carrier, and give the daemon back every spool it is still holding.
   *
   * THE ABORTS GO FIRST, AND THE ORDER IS THE WHOLE POINT. Disposing the ledger is
   * what stops the continuations, and it is also what makes the open streams
   * unreachable: an ingest id lives in the ledger and nowhere else, so after the
   * ledger goes nothing in this console can name one. A carrier closed with several
   * uploads open therefore left those spools and their aggregate reservations standing
   * until the daemon's abandoned-spool reaper claimed them, and a later upload in the
   * same session could fail capacity admission long after the surface was gone.
   *
   * `abandoned` entries are skipped rather than reclaimed twice: `abandon` already asked
   * for that spool back at the moment sending stopped, and a second request for one
   * spool is a duplicate rather than a safeguard. `complete` entries hold a finished
   * stream, which there is nothing to reclaim from.
   *
   * FIRED AND NOT AWAITED. Disposal is synchronous — a carrier that waited on a
   * best-effort abort would hold a closed surface open for an answer no surface is
   * left to render. The answer is still read, on the diagnostic band rather than on a
   * card: `attachment-ingest-abort.ts` says what a daemon that declined to release
   * left behind.
   *
   * IDEMPOTENT, on `repo-mounts-reader.ts`'s reason for its own guard: the ledger's
   * published snapshot outlives its disposal, so a second call would walk the same
   * entries and send the daemon a second reclaim request for every spool the first
   * one already asked back. React unmounts an effect twice in development strict
   * mode, which is exactly where a carrier is disposed twice.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#runningLocalIds.clear();
    for (const entry of this.#ledger.snapshot) {
      if (entry.state !== "complete" && entry.state !== "abandoned") {
        this.#reclaimer.request(entry.ingestId);
      }
    }
    this.#ledger.dispose();
  }

  /** Begin or resume one stream: open it if it is not open, chunk it, then complete it. */
  async #drive(localId: string): Promise<void> {
    if (this.#runningLocalIds.has(localId)) {
      return;
    }
    this.#runningLocalIds.add(localId);
    try {
      const opened = await this.#openStream(localId);
      if (!opened) {
        return;
      }
      const streamed = await this.#streamChunks(localId);
      if (!streamed) {
        return;
      }
      await this.#completeStream(localId);
    } finally {
      this.#runningLocalIds.delete(localId);
    }
  }

  /** `AttachmentIngestInit`. Skipped when the stream is already open, which is what makes retry a replay. */
  async #openStream(localId: string): Promise<boolean> {
    const entry = this.#ledger.current(localId);
    const stamp = this.#ledger.stamp(localId);
    if (entry === undefined || stamp === undefined) {
      return false;
    }
    if (entry.ingestId !== undefined) {
      return true;
    }
    // A `File` off a picker or a drop carries an EMPTY `type` when the browser could not
    // place it, which is the same situation as a source that declared nothing and is
    // reported the same way: as an absent member.
    const declared = entry.declared.declaredMediaType;
    const declaredMediaType = declared === undefined || declared === "" ? undefined : declared;
    const answer: PortAnswer<{ readonly ingestId: string }> =
      await this.#bridge.growth.artifactIngestBegin({
        sessionId: this.#sessionId,
        fileName: entry.declared.declaredName,
        // Spread rather than assigned, so a source that declared nothing sends a request
        // with no `mediaType` key at all. The contract makes absence a first-class state
        // and the daemon reads presence, so a key carrying `undefined` — or an empty
        // string — would be this console declaring a type it was never told.
        ...(declaredMediaType === undefined ? {} : { mediaType: declaredMediaType }),
        declaredSizeBytes: entry.declared.byteLength,
      });
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      // Abandoned, removed, or disposed while Init was in flight. The daemon opened a
      // stream whose id never reached the ledger, so this is the only place that can
      // ask for its spool back.
      this.#reclaimer.request(answer.value?.ingestId);
      return false;
    }
    if (answer.status !== "served" || answer.value === undefined) {
      this.#refuse(localId, settled, answer);
      return false;
    }
    this.#ledger.write(localId, {
      ...settled,
      state: "ingesting",
      ingestId: answer.value.ingestId,
      openedAtMilliseconds: this.#clock.now(),
      lastProgressAtMilliseconds: this.#clock.now(),
    });
    return true;
  }

  /**
   * `AttachmentIngestChunk`, one bounded slice at a time from the current offset.
   *
   * The ledger IS the offset, so a resumed stream re-reads and re-sends the slice that
   * was in flight when the response was lost and the daemon acknowledges it without
   * re-appending. Which is also why the sequence number is derived from the ledger
   * rather than counted in a field of its own: every chunk but the last is exactly one
   * cap wide and the loop ends on the last, so the count of acknowledged chunks is the
   * offset divided by the cap — and a replay recomputes the same number from the same
   * offset, which is exactly what the daemon's idempotent acknowledgement matches on.
   */
  async #streamChunks(localId: string): Promise<boolean> {
    for (;;) {
      const entry = this.#ledger.current(localId);
      const stamp = this.#ledger.stamp(localId);
      if (entry === undefined || stamp === undefined || entry.ingestId === undefined) {
        return false;
      }
      const offset = entry.receivedBytes;
      if (entry.declared.payload.size - offset <= 0) {
        return true;
      }
      const slice = entry.declared.payload.slice(offset, offset + ATTACHMENT_CHUNK_BYTE_CAP);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      if (this.#ledger.currentIfUnchanged(localId, stamp) === undefined) {
        return false;
      }
      const answer: PortAnswer<void> = await this.#bridge.growth.artifactIngestWriteChunk({
        ingestId: entry.ingestId,
        sequenceNumber: Math.floor(offset / ATTACHMENT_CHUNK_BYTE_CAP),
        chunk: encodeBase64(bytes),
      });
      const settled = this.#ledger.currentIfUnchanged(localId, stamp);
      if (settled === undefined) {
        // Abandoned or removed mid-chunk. `abandon` already asked for this spool back,
        // because the ingest id was in the ledger for it to find.
        return false;
      }
      if (answer.status !== "served") {
        this.#refuse(localId, settled, answer);
        return false;
      }
      this.#ledger.write(localId, {
        ...settled,
        receivedBytes: advanceReceivedBytes(settled, bytes.byteLength),
        lastProgressAtMilliseconds: this.#clock.now(),
      });
    }
  }

  /** `AttachmentIngestComplete`. The derived truth replaces the declaration here and nowhere else. */
  async #completeStream(localId: string): Promise<void> {
    const entry = this.#ledger.current(localId);
    const stamp = this.#ledger.stamp(localId);
    if (entry === undefined || stamp === undefined || entry.ingestId === undefined) {
      return;
    }
    const answer: PortAnswer<{
      readonly artifactId: string;
      readonly normalizedName: string;
      readonly derivedMediaType: string;
      readonly derivedSizeBytes: number;
    }> = await this.#bridge.growth.artifactIngestComplete({ ingestId: entry.ingestId });
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      return;
    }
    if (answer.status !== "served" || answer.value === undefined) {
      this.#refuse(localId, settled, answer);
      return;
    }
    this.#ledger.write(localId, {
      ...settled,
      state: "complete",
      derived: {
        artifactId: answer.value.artifactId,
        normalizedName: answer.value.normalizedName,
        derivedMediaType: answer.value.derivedMediaType,
        derivedSizeBytes: answer.value.derivedSizeBytes,
      },
      lastProgressAtMilliseconds: this.#clock.now(),
    });
  }

  /**
   * Record a refusal verbatim, with the disposition that decides what the control offers.
   *
   * Takes the entry its caller re-read after the await rather than reading one itself,
   * so a refusal can never be written over a state a participant moved meanwhile.
   */
  #refuse(localId: string, entry: AttachmentIngestEntry, answer: PortAnswer<unknown>): void {
    const code = answer.code ?? "attachment.ingest_rejected";
    this.#ledger.write(localId, {
      ...entry,
      state: "refused",
      refusal: { code, detail: answer.detail ?? "The ingest call was refused." },
      disposition: ingestRefusalDisposition(code),
    });
  }
}
// NO REACT BINDING SHIPS HERE: a stream is not a render. `attachment-carrier.ts` is
// the one place a client is constructed, subscribed to, and disposed, and both the
// artifacts section and the composer's affordance reach it through that binding.
