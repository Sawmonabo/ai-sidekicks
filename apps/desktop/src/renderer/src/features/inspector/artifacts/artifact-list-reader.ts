// What the inspector's `Artifacts` section holds, what it can act on, and who is told when
// it changes.
//
// The list read and the two artifact reads its acts make are calls the caller supplies
// (`ArtifactOperations`); nothing here reaches the wire itself. A rejected call is not
// caught here: it propagates to whoever awaited it.
//
// When the read runs is `artifact-read-schedule.ts`'s, and this class extends it: the
// scheduler, the refresh reasons, the generation register and the list read live there,
// and what is left here is what the section renders and who is told when it changes.
//
// The acts are `artifact-row-actions.ts`'s. `readManifest` and `fetchPayload` delegate to
// `ArtifactRowActions`, which is handed only the operations `ArtifactListReadingPublisher`
// names. The methods stay on this class because the reader is the one object the section
// holds.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import { ArtifactRowActions } from "./artifact-row-actions.js";
import { type ArtifactListReadingPublisher } from "./artifact-list-reading-publisher.js";
import {
  NOTHING_READ_YET,
  type ArtifactListReading,
  type ArtifactRowActOutcome,
} from "./artifact-list-reading.js";
import type { ReadArtifact } from "./services/artifact-reads.js";
import {
  ArtifactReadSchedule,
  type ArtifactReadScheduleOptions,
} from "./artifact-read-schedule.js";
import type { ArtifactPayloadOutcome } from "@renderer/store/artifacts/artifact-payload.js";

/** What the reader needs: the schedule's options plus the act call. */
export interface ArtifactListReaderOptions extends ArtifactReadScheduleOptions {
  /** The call the acts make to read one artifact's manifest or its bytes. */
  readonly readArtifact: ReadArtifact;
}

/** One section's reading of a session's artifacts, and the acts it can put to the port. */
export class ArtifactListReader extends ArtifactReadSchedule {
  readonly #clock: Clock;
  readonly #actions: ArtifactRowActions;
  readonly #changes = new Emitter<ArtifactListReading>("artifact list reading");

  #reading: ArtifactListReading = NOTHING_READ_YET;

  public constructor(options: ArtifactListReaderOptions) {
    super(options);
    this.#clock = options.clock;
    // Stamped at construction, so every reading the section can reach carries an instant
    // somebody took.
    this.#reading = { ...NOTHING_READ_YET, readAtMilliseconds: this.#clock.now() };
    this.#actions = new ArtifactRowActions({
      readArtifact: options.readArtifact,
      publisher: this.#readingPublisher(),
    });
  }

  /** What the section renders right now. Stable identity between publishes. */
  public get snapshot(): ArtifactListReading {
    return this.#reading;
  }

  /** Call `sink` on every publish. */
  public subscribe(sink: (reading: ArtifactListReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read again, because a user asked.
   *
   * Routed through the schedule rather than performed here, so a second press inside the
   * coalescing window costs no second read and a press made while a read is outstanding
   * becomes the next read rather than a parallel one.
   */
  public refresh(): void {
    this.requestRead("user-request");
  }

  /** Re-read one artifact's manifest, and put what came back on its row. */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    return this.#actions.readManifest(artifactId);
  }

  /** Ask for one artifact's bytes. One fetch at a time across the section. */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    return this.#actions.fetchPayload(artifactId);
  }

  /** Terminal. No later completion, frame, or focus can reach a section that unmounted. */
  public override dispose(): void {
    // The acts are disposed too, so a fetch still in flight settles into nothing.
    this.#actions.dispose();
    super.dispose();
    this.#changes.clear();
  }

  /** The schedule's half of the seam: what it is about to replace. */
  protected override currentReading(): ArtifactListReading {
    return this.#reading;
  }

  /** The schedule's other half: where a settled round is put. */
  protected override publishReading(
    reading: Omit<ArtifactListReading, "readAtMilliseconds">,
  ): void {
    this.#publish(reading);
  }

  /**
   * This reader's half of the act seam, as the one object the acts are given.
   *
   * An adapter rather than an `implements` clause, because every member reads or writes
   * state this class owns and implementing the port would make all three public.
   */
  #readingPublisher(): ArtifactListReadingPublisher {
    return {
      currentReading: () => this.#reading,
      publish: (reading: ArtifactListReading) => {
        this.#publish(reading);
      },
      scheduledReadClaim: () => this.currentReadClaim(),
    };
  }

  /**
   * Put one reading on the section, stamped with the instant it was put there.
   *
   * Every publish comes through here, so the instant is a property of the publish and not
   * of whichever producer remembered to take one. The parameter omits the stamp because a
   * producer cannot supply it; one that spreads a stamped reading forward is overwritten.
   */
  #publish(reading: Omit<ArtifactListReading, "readAtMilliseconds">): void {
    const stamped: ArtifactListReading = { ...reading, readAtMilliseconds: this.#clock.now() };
    this.#reading = stamped;
    this.#changes.emit(stamped);
  }
}
