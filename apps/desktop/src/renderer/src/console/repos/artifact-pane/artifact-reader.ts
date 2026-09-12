// What the artifact pane holds, what it can act on, and who is told when it changes.
//
// Three reads, all on the growth slate and all refused by name today: `artifactList`
// and `artifactRead` against `artifact-ingest-and-crud`, `artifactAllowlistRead`
// against
// `artifact-allowlist-and-abort`.
//
// THE ONE DECISION IN THIS FILE IS WHAT TO DO WITH A SERVED LIST, AND IT HAS CHANGED.
// The growth port's `artifactList` used to answer a four-member payload summary —
// `artifactId`, `name`, `byteLength`, `contentType` — while the row
// `repos/artifacts/artifact-model.ts` builds renders the MANIFEST ENVELOPE, and none of the
// missing members was derivable from the four that
// were present. So a served list was REFUSED with the console's own code rather than
// mapped, and that refusal named the gap "so the day the shape lands the fix is a
// mapping and not an archaeology". The shape landed: `GrowthArtifactSummary` now
// mirrors the registered artifact manifest member for member. The fix is
// the mapping, and it lives on the model beside the vocabularies it fills
// (`repos/artifacts/artifact-model.ts:artifactManifestRowFromSummary`) rather than here, because
// what a served row IS is a model question and this file owns only who asked.
//
// WHEN THE READ RUNS IS `artifact-read-schedule.ts`'S, AND THIS CLASS EXTENDS IT. That
// base owns the scheduler, the four refresh reasons, the generation register, the
// session identity and the two-legged read itself; what is left here is what a surface
// renders, what it can act on, and who is told when either changes. The split is the
// file's own two jobs pulled apart — deciding when to read, and holding what a surface
// reads — and it is inheritance rather than composition because the reading a surface
// holds has to stay the class that carries the scheduler and the trigger contract; the
// base's header states that rule and the gate that enforces it.
//
// THE ACTS ARE NEXT DOOR, AND THIS CLASS IS THEIR HOST. `readManifest`, `fetchPayload`
// and `deleteArtifact` delegate to `ArtifactPaneActions`, which is handed the five
// operations `ArtifactActionHost` names and nothing else — three calls with three
// different concurrency rules, none of them the schedule's. The methods stay on this
// class because the reader is the one object a surface holds: a binding that had to
// reach a second object to press a control would put the pane's own composition into
// every caller.

import { Emitter, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import { ArtifactPaneActions } from "./artifact-actions.js";
import { type ArtifactActionHost } from "./artifact-action-host.js";
import {
  NOTHING_READ_YET,
  type ArtifactDeleteOutcome,
  type ArtifactPaneReading,
  type ArtifactRowActOutcome,
  type ArtifactVisibilityUpdateOutcome,
} from "./artifact-pane-reading.js";
import type { ArtifactVisibility } from "../artifacts/artifact-model.js";
import {
  ArtifactReadSchedule,
  type ArtifactReadScheduleOptions,
} from "./artifact-read-schedule.js";
import type { ArtifactPayloadOutcome } from "./artifact-payload.js";

export class ArtifactPaneReader extends ArtifactReadSchedule {
  readonly #clock: ConsoleClock;
  readonly #actions: ArtifactPaneActions;
  readonly #changes = new Emitter<ArtifactPaneReading>("artifact pane reading");

  #reading: ArtifactPaneReading = NOTHING_READ_YET;

  public constructor(options: ArtifactReadScheduleOptions) {
    super(options);
    this.#clock = options.clock;
    // Stamped at construction rather than left at the declaration's own placeholder,
    // so every reading a surface can reach carries an instant somebody took.
    this.#reading = { ...NOTHING_READ_YET, readAtMilliseconds: this.#clock.now() };
    this.#actions = new ArtifactPaneActions({ bridge: options.bridge, host: this.#actionHost() });
  }

  /** What the pane renders right now. Stable identity between publishes. */
  public get snapshot(): ArtifactPaneReading {
    return this.#reading;
  }

  public subscribe(sink: (reading: ArtifactPaneReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read again, because a user asked. The only other reason there is.
   *
   * Routed through the schedule rather than performed here, so a second press inside
   * the coalescing window costs no second read pair and a press made while a read is
   * outstanding becomes the NEXT read rather than a parallel one.
   *
   * THE REASON IS `user-request`, WHICH THE SET NOW NAMES. `RefreshReason`
   * (`store/read/refresh-scheduler.ts`) is a closed SIX-member set — subscribe, window-focus,
   * reconnect, terminal-event, gap-repull, user-request — and the last of
   * those is exactly this press. This call used to request `subscribe`, because at
   * the time the set had five members and none of them was true: `subscribe` was the
   * one whose meaning was not FALSE, since the press asks for the same whole-pane
   * read the subscription asked for. That reasoning ends the moment the honest member
   * exists, and it has to end here rather than merely read oddly: a diagnostics trail
   * that recorded a person's press as a subscription would report a surface opening
   * that never opened, which is the fabricated reason that module's own doc forbids.
   */
  public refresh(): void {
    this.requestRead("user-request");
  }

  /**
   * Re-read one artifact's manifest, and put what came back on its row.
   *
   * Delegated whole to `artifact-actions.ts`, which owns what the call sends and what
   * each answer writes. The three act methods stay on this class for the reason its
   * header gives: the reader is the one object a surface holds.
   */
  public async readManifest(artifactId: string): Promise<ArtifactRowActOutcome> {
    return this.#actions.readManifest(artifactId);
  }

  /** Ask for one artifact's bytes. Single-flight; `artifact-actions.ts` says why. */
  public async fetchPayload(artifactId: string): Promise<ArtifactPayloadOutcome> {
    return this.#actions.fetchPayload(artifactId);
  }

  /** Delete one artifact, after the user confirmed the consequence. */
  public async deleteArtifact(artifactId: string): Promise<ArtifactDeleteOutcome> {
    return this.#actions.deleteArtifact(artifactId);
  }

  /** Re-classify one artifact. Single-flight per row; `artifact-actions.ts` says why. */
  public async updateVisibility(
    artifactId: string,
    visibility: ArtifactVisibility,
  ): Promise<ArtifactVisibilityUpdateOutcome> {
    return this.#actions.updateVisibility(artifactId, visibility);
  }

  /** Terminal. No later completion, frame, or focus can reach a pane that unmounted. */
  public override dispose(): void {
    // The acts are disposed too, so a fetch still in flight settles into nothing
    // rather than into a register whose surface has gone.
    this.#actions.dispose();
    super.dispose();
    this.#changes.clear();
  }

  /** The schedule's half of the seam: what it is about to replace. */
  protected override currentReading(): ArtifactPaneReading {
    return this.#reading;
  }

  /** The schedule's other half: where a settled round is put. */
  protected override publishReading(
    reading: Omit<ArtifactPaneReading, "readAtMilliseconds">,
  ): void {
    this.#publish(reading);
  }

  /**
   * This reader's half of the act seam, as the one object the acts are given.
   *
   * AN ADAPTER RATHER THAN A PUBLIC `implements` CLAUSE, on
   * `repos/proposals/proposal-gate-reader.ts`'s reason: every member reads or writes state this
   * class owns — `publish` alone would let any caller put an arbitrary reading on the
   * pane — and implementing the port on the class would have to make all five public
   * to do it. The port stays one declaration, the acts stay unable to reach anything
   * it does not name, and this class's public surface is what it was.
   */
  #actionHost(): ArtifactActionHost {
    return {
      currentReading: () => this.#reading,
      publish: (reading: ArtifactPaneReading) => {
        this.#publish(reading);
      },
      scheduledReadClaim: () => this.currentReadClaim(),
      isDisposed: () => this.isDisposed,
      requestRefreshAfterAct: () => {
        this.requestRead("terminal-event");
      },
    };
  }

  /**
   * Put one reading on the pane, stamped with the instant it was put there.
   *
   * THE STAMP IS TAKEN HERE AND NOWHERE ELSE. Every publish this reader makes — the
   * schedule's own settlement and error arm, and all three acts through the action
   * host — comes through this method, so stamping here is what makes the instant a
   * property of the publish rather than of whichever producer remembered to take one.
   * A producer that spread a previous reading forward gets this publish's instant,
   * which is correct: the reading changed, and that is when.
   *
   * WHICH IS WHY THE PARAMETER OMITS IT. A producer cannot supply the stamp, so the
   * type does not ask it to — and one that spreads a stamped reading forward passes
   * through unchanged, because the member this method writes is written last.
   */
  #publish(reading: Omit<ArtifactPaneReading, "readAtMilliseconds">): void {
    const stamped: ArtifactPaneReading = { ...reading, readAtMilliseconds: this.#clock.now() };
    this.#reading = stamped;
    this.#changes.emit(stamped);
  }
}
