// The ingest client: three calls, a decoded-byte ledger, and a retry that replays.
//
// `Spec-023 §Console Design (Meridian)` §10.8 puts the chunking, the decoded-byte
// accounting, and the replay-safe retry on the console's own side of the seam and says
// why: all three are CONTRACT behaviour, and a generic upload library would obscure
// every one of them. So this is own-built, and it is a class with private fields rather
// than a hook holding four `useState`s, because a stream is state with a lifecycle and
// a component is a render.
//
// WHAT IT CALLS, AND WHAT ANSWERS TODAY. The trio `AttachmentIngestInit`,
// `AttachmentIngestChunk`, `AttachmentIngestComplete` is typed in the corpus and
// registers NO method string anywhere, so every leg goes through
// `bridge/growth-port.ts` and comes back `wire-unregistered` against the
// `artifact-ingest-and-crud` slate row. That is not a stub: the chunk loop runs, the
// ledger advances on whatever is acknowledged, and the refusal renders where the
// progress would have. When the wire lands, the port's methods stop refusing and this
// file does not change.
//
// CANCEL IS ABANDONMENT, AND THE COPY SAYS SO. There is no cancel call in the trio. A
// participant who stops an upload stops SENDING; the daemon's abandoned-spool reaper
// claims the bytes afterwards. `artifactIngestAbort` is the first-class version and is
// its own slate row (`artifact-allowlist-and-abort`), so this client asks for it
// best-effort and states the honest outcome either way.
//
// RETRY REPLAYS, IT DOES NOT RESTART. Every call of the trio is retry-safe: a replayed
// chunk is acknowledged without being re-appended and a replayed completion replays its
// original response verbatim while the stream entry lives. So a lost response resumes
// at the current offset. The two codes whose disposition differs are named in
// `attachment-model.ts` and classified there; this file acts on the classification and
// invents no policy of its own.
//
// NO TIMER, ANYWHERE. The client performs work when a participant asks it to — attach,
// retry, abandon — and at no other moment. There is no interval, no backoff timer, and
// no automatic re-drive: `wait-and-retry` is a sentence a person reads and a control
// they press, because a console that retried a 429 on its own would hide the capacity
// problem it exists to report.

import type { ConsoleBridge } from "../bridge/index.js";
import {
  ATTACHMENT_CHUNK_BYTE_CAP,
  Emitter,
  RealClock,
  type ConsoleClock,
  type Unsubscribe,
} from "../core/index.js";
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

/**
 * Every attachment a participant has handed this carrier, in the order they chose.
 *
 * ORDER IS PARTICIPANT-DECLARED AND PRESERVED END TO END, which `Spec-014 §Required
 * Behavior` requires of the reference and this client is the first place it can be
 * lost. So the order lives in an explicit array of local ids rather than in a `Map`'s
 * insertion order, and `reorder` moves a member inside it — a drag round-trips because
 * the array is the record, not a rendering of one.
 */
export class AttachmentIngestClient {
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #clock: ConsoleClock;
  readonly #entriesByLocalId = new Map<string, AttachmentIngestEntry>();
  readonly #declaredOrder: string[] = [];
  readonly #runningLocalIds = new Set<string>();
  readonly #changes = new Emitter<readonly AttachmentIngestEntry[]>("attachment ingest");

  #snapshot: readonly AttachmentIngestEntry[] = [];
  #disposed = false;

  public constructor(options: AttachmentIngestClientOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock ?? new RealClock();
  }

  /** The carrier, in declared order. Stable identity between publishes. */
  public get snapshot(): readonly AttachmentIngestEntry[] {
    return this.#snapshot;
  }

  public subscribe(sink: (entries: readonly AttachmentIngestEntry[]) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
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
    if (this.#disposed || this.#entriesByLocalId.has(source.localId)) {
      return;
    }
    this.#declaredOrder.push(source.localId);
    this.#write(source.localId, {
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
    const entry = this.#entriesByLocalId.get(localId);
    if (entry === undefined || this.#runningLocalIds.has(localId)) {
      return;
    }
    const restarting = entry.disposition === "restart";
    this.#write(localId, {
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
    const entry = this.#entriesByLocalId.get(localId);
    if (entry === undefined || entry.state === "complete") {
      return;
    }
    this.#write(localId, { ...entry, state: "abandoned", disposition: undefined });
    if (entry.ingestId !== undefined) {
      void this.#bridge.growth.artifactIngestAbort({ ingestId: entry.ingestId });
    }
  }

  /** Take one attachment out of the carrier entirely, position included. */
  public remove(localId: string): void {
    const position = this.#declaredOrder.indexOf(localId);
    if (position < 0) {
      return;
    }
    this.abandon(localId);
    this.#declaredOrder.splice(position, 1);
    this.#entriesByLocalId.delete(localId);
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
   * there is nothing to name before then. The result is exactly the typed
   * `ArtifactId[]` shape `Spec-014` specifies, held as strings because the console
   * never mints an identity of its own.
   */
  public attachmentArtifactIds(): readonly string[] {
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
    this.#runningLocalIds.clear();
    this.#changes.clear();
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
    const entry = this.#current(localId);
    if (entry === undefined) {
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
    if (answer.status !== "served" || answer.value === undefined) {
      this.#refuse(localId, answer);
      return false;
    }
    this.#write(localId, {
      ...entry,
      state: "ingesting",
      ingestId: answer.value.ingestId,
      openedAtMilliseconds: this.#clock.now(),
      lastProgressAtMilliseconds: this.#clock.now(),
    });
    return true;
  }

  /**
   * `AttachmentIngestChunk`, one bounded chunk at a time from the current offset.
   *
   * The offset is the ledger, so a resumed stream sends the chunk that was in flight
   * when the response was lost and the daemon acknowledges it without re-appending. The
   * chunk length is the decoded remainder bounded by the fixed chunk cap — never an
   * encoded length, and `advanceReceivedBytes` is what makes that checkable rather than
   * merely intended.
   */
  async #streamChunks(localId: string): Promise<boolean> {
    for (;;) {
      const entry = this.#current(localId);
      if (entry === undefined || entry.ingestId === undefined) {
        return false;
      }
      const remaining = entry.declared.byteLength - entry.receivedBytes;
      if (remaining <= 0) {
        return true;
      }
      const chunkByteLength = Math.min(ATTACHMENT_CHUNK_BYTE_CAP, remaining);
      const answer: PortAnswer<void> = await this.#bridge.growth.artifactIngestWriteChunk({
        ingestId: entry.ingestId,
        offset: entry.receivedBytes,
        byteLength: chunkByteLength,
      });
      if (answer.status !== "served") {
        this.#refuse(localId, answer);
        return false;
      }
      const stillCurrent = this.#current(localId);
      if (stillCurrent === undefined) {
        return false;
      }
      this.#write(localId, {
        ...stillCurrent,
        receivedBytes: advanceReceivedBytes(stillCurrent, chunkByteLength),
        lastProgressAtMilliseconds: this.#clock.now(),
      });
    }
  }

  /** `AttachmentIngestComplete`. The derived truth replaces the declaration here and nowhere else. */
  async #completeStream(localId: string): Promise<void> {
    const entry = this.#current(localId);
    if (entry === undefined || entry.ingestId === undefined) {
      return;
    }
    const answer: PortAnswer<{
      readonly artifactId: string;
      readonly normalizedName: string;
      readonly derivedMediaType: string;
      readonly derivedSizeBytes: number;
    }> = await this.#bridge.growth.artifactIngestComplete({ ingestId: entry.ingestId });
    if (answer.status !== "served" || answer.value === undefined) {
      this.#refuse(localId, answer);
      return;
    }
    this.#write(localId, {
      ...entry,
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

  /** The entry as it stands, or `undefined` once a participant removed it mid-stream. */
  #current(localId: string): AttachmentIngestEntry | undefined {
    return this.#disposed ? undefined : this.#entriesByLocalId.get(localId);
  }

  /** Record a refusal verbatim, with the disposition that decides what the control offers. */
  #refuse(localId: string, answer: PortAnswer<unknown>): void {
    const entry = this.#entriesByLocalId.get(localId);
    if (entry === undefined) {
      return;
    }
    const code = answer.code ?? "attachment.ingest_rejected";
    this.#write(localId, {
      ...entry,
      state: "refused",
      refusal: { code, detail: answer.detail ?? "The ingest call was refused." },
      disposition: ingestRefusalDisposition(code),
    });
  }

  #write(localId: string, entry: AttachmentIngestEntry): void {
    this.#entriesByLocalId.set(localId, entry);
    this.#publish();
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

// NO REACT BINDING SHIPS HERE, AND THAT IS THE OWNERSHIP LINE RATHER THAN AN OMISSION.
// §10.8 puts the attach affordance and the composer chips in chapter 6, which is a
// SIBLING view family (`T-023p-1C-3`), and a hook this family exported with no caller
// would be dead code the structure gate is right to reject — the tree admits a
// per-symbol exemption only for a symbol a landed task names, and inventing an attach
// control here to give it one would be building the composer's body inside the repos
// family. The class above is the seam: the composer constructs one, subscribes to it,
// and disposes it, exactly as `repo-mounts-reader.ts` is bound one directory over.
