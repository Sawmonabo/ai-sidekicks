// The ingest client: three calls, a bounded slice of the payload on each one, a
// decoded-byte ledger, and a retry that replays.
//
// `Spec-023 §Console Design (Meridian)` §10.8 puts the chunking, the decoded-byte
// accounting, and the replay-safe retry on the console's own side of the seam and says
// why: all three are CONTRACT behaviour, and a generic upload library would obscure
// every one of them. So this is own-built, and it is a class with private fields rather
// than a hook holding four `useState`s, because a stream is state with a lifecycle and
// a component is a render. The carrier's own record — which attachments there are, in
// which order, and where each one stands — is `attachment-ingest-ledger.ts` next door;
// this module owns the protocol and nothing else.
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
// slice is what bounds memory too: `ATTACHMENT_CHUNK_BYTE_CAP` raw bytes are read and
// encoded at a time, so a hundred-megabyte upload never holds more than one chunk.
//
// CANCEL IS ABANDONMENT, AND THE COPY SAYS SO. There is no cancel call in the trio. A
// participant who stops an upload stops SENDING; the daemon's abandoned-spool reaper
// claims the bytes afterwards. `artifactIngestAbort` is the first-class version and is
// its own slate row (`artifact-allowlist-and-abort`), so this client asks for it
// best-effort and states the honest outcome either way.
//
// RETRY REPLAYS, IT DOES NOT RESTART. Every call of the trio is retry-safe: a replayed
// chunk — same sequence number, same bytes — is acknowledged without being re-appended,
// and a replayed completion replays its original response verbatim while the stream
// entry lives. So a lost response resumes at the current offset. The two codes whose
// disposition differs are named in `attachment-model.ts` and classified there; this
// file acts on the classification and invents no policy of its own.
//
// A PARTICIPANT CAN ACT WHILE A CALL IS IN FLIGHT, so every continuation re-reads the
// ledger after its await and proceeds only if the entry still stands where it stood.
// Abandonment is the case that makes this load-bearing: an upload stopped while Init
// was in flight would otherwise be resumed by the continuation writing its captured
// entry back, and one stopped mid-chunk would stream on to completion. A stale
// continuation writes nothing and leaves the abandoned state exactly as it found it.
// The one thing it does do is abort the stream the daemon opened underneath it, which
// nobody else can: that ingest id reached no ledger entry, so `abandon` never saw it.
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
import { AttachmentIngestLedger } from "./attachment-ingest-ledger.js";
import {
  advanceReceivedBytes,
  ingestRefusalDisposition,
  type AttachmentIngestEntry,
  type AttachmentSource,
} from "./attachment-model.js";

/** One growth-port answer, narrowed to what this client reads off it. */
interface PortAnswer<TValue> {
  readonly status: "served" | "unavailable";
  readonly value?: TValue;
  readonly code?: string;
  readonly detail?: string;
}

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
  readonly #runningLocalIds = new Set<string>();

  #disposed = false;

  public constructor(options: AttachmentIngestClientOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock ?? new RealClock();
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
    this.#abort(entry.ingestId);
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

  public dispose(): void {
    this.#disposed = true;
    this.#runningLocalIds.clear();
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
    const answer: PortAnswer<{ readonly ingestId: string }> =
      await this.#bridge.growth.artifactIngestBegin({
        sessionId: this.#sessionId,
        name: entry.declared.declaredName,
        byteLength: entry.declared.byteLength,
      });
    const settled = this.#ledger.currentIfUnchanged(localId, stamp);
    if (settled === undefined) {
      // Abandoned, removed, or disposed while Init was in flight. The daemon opened a
      // stream whose id never reached the ledger, so this is the only place that can
      // ask for its spool back.
      this.#abort(answer.value?.ingestId);
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

  /** Ask for a spool back, best-effort, for a stream the daemon actually opened. */
  #abort(ingestId: string | undefined): void {
    if (ingestId !== undefined) {
      void this.#bridge.growth.artifactIngestAbort({ ingestId });
    }
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

// NO REACT BINDING SHIPS HERE, AND THAT IS THE OWNERSHIP LINE RATHER THAN AN OMISSION.
// §10.8 puts the attach affordance and the composer chips in chapter 6, which is a
// SIBLING view family (`T-023p-1C-3`), and a hook this family exported with no caller
// would be dead code the structure gate is right to reject — the tree admits a
// per-symbol exemption only for a symbol a landed task names, and inventing an attach
// control here to give it one would be building the composer's body inside the repos
// family. The class above is the seam: the composer constructs one, subscribes to it,
// and disposes it, exactly as `repo-mounts-reader.ts` is bound one directory over.
