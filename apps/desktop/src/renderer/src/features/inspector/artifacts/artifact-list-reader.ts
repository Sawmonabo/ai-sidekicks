// The `Artifacts` section's reading of a session's artifacts, and who is told when it changes.
//
// The list read and the two act reads are calls the caller supplies (`ArtifactOperations`); a
// rejected call propagates to whoever awaited it. Scheduling lives in `artifact-read-schedule.ts`
// and the acts in `artifact-row-actions.ts`.

import type { ArtifactId } from "@ai-sidekicks/contracts/provider/driver/driver";

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
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
    // Stamped at construction so even the opening reading carries an instant somebody took.
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
   * Read again because a user asked.
   *
   * Goes through the schedule: a press inside the coalescing window costs no second read, and
   * a press during a read becomes the next read.
   */
  public refresh(): void {
    this.requestRead("user-request");
  }

  /** Re-read one artifact's manifest, and put what came back on its row. */
  public async readManifest(artifactId: ArtifactId): Promise<ArtifactRowActOutcome> {
    return this.#actions.readManifest(artifactId);
  }

  /** Ask for one artifact's bytes. One fetch at a time across the section. */
  public async fetchPayload(artifactId: ArtifactId): Promise<ArtifactPayloadOutcome> {
    return this.#actions.fetchPayload(artifactId);
  }

  /** Terminal: nothing that completes after this reaches a section that unmounted. */
  public override dispose(): void {
    // The acts are disposed too, so a fetch still in flight settles into nothing.
    this.#actions.dispose();
    super.dispose();
    this.#changes.clear();
  }

  protected override currentReading(): ArtifactListReading {
    return this.#reading;
  }

  protected override publishReading(
    reading: Omit<ArtifactListReading, "readAtMilliseconds">,
  ): void {
    this.#publish(reading);
  }

  /** The act seam's adapter; an `implements` clause would make all three members public. */
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
   * Every publish passes through here so the instant belongs to the publish; the parameter
   * omits the stamp so a producer cannot supply one.
   */
  #publish(reading: Omit<ArtifactListReading, "readAtMilliseconds">): void {
    const stamped: ArtifactListReading = { ...reading, readAtMilliseconds: this.#clock.now() };
    this.#reading = stamped;
    this.#changes.emit(stamped);
  }
}
