// One record, one write at a time, and what happens to the press that arrives in
// between.
//
// WHY A QUEUE AND NOT A SECOND CALL
//
// The update carries a RECORD rather than a patch, so a switch sends the whole value
// with one member flipped. Two switches inside one record pressed before the first
// write settles therefore compose two whole records from the SAME starting value,
// and whichever lands second erases the other member's change — a write that
// silently undoes a choice the person watched themselves make.
//
// So writes are serialised PER RECORD. While one is in flight the record is busy and
// every one of its switches is refused presses; a toggle that reaches this writer
// anyway is queued rather than sent, and it is composed against the record the
// daemon holds AFTERWARDS rather than the one on screen when it was pressed.
//
// WHERE THE "AFTERWARDS" VALUE COMES FROM
//
// Not from the write's reply, which carries a timestamp and no record; and not from
// the value this writer just sent, which would be the page keeping its own edited
// copy of a record the daemon owns. It comes from the re-read the served write
// already triggers — the one the page performs anyway, so a queued toggle costs no
// extra call. If that re-read refuses, or no longer holds the record as a set of
// switches, the queued toggles are dropped and each says so on its own switch:
// nothing is written against a value nobody read.
//
// A REFUSED WRITE STOPS THE RECORD
//
// The daemon refused this record; a queued write against a value it never accepted
// would be a guess about which of the two facts survived. So the queue is dropped
// and the refusal renders on every switch it was carrying — the one that was sent
// and the ones that never were.
//
// AND THE RE-READ IS A WHOLE-SET READ, SO IT IS ORDERED GLOBALLY
//
// The queue is per record, so toggling two records runs two of these loops at once.
// Each one re-reads the WHOLE set, which is what the page publishes — so two reads
// taken at different moments and answered in the other order would replace the page
// with the older snapshot and make the newer record's accepted toggle look reverted
// for the rest of the visit.
//
// The reads are DISCARDED BY GENERATION rather than serialised through a queue of
// their own. Serialising would make one record's toggle wait on an unrelated
// record's re-read before its own write could even be sent, which is latency added
// to fix an ordering problem — and it would still need this rule, because the loops
// that queue behind it are exactly the ones already in flight. Reads are taken
// monotonically, so the later-taken read is the later state; a reply from an earlier
// one is answering a question the page has already asked again.
//
// The re-read is still CONSUMED locally by the loop that took it: this record is
// busy for the whole loop, so no second write to it can be in flight, and its own
// value in its own re-read is authoritative for it whatever another record did
// meanwhile. What goes stale is the whole-set PUBLICATION, and that is what the
// generation guards.

import type { ConsoleBridge } from "../../../bridge/index.js";
import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../../../core/index.js";
import { GenerationLatch, type CurrentGenerationClaim } from "../../../store/index.js";
import {
  flipMember,
  type AttentionPreferenceReadOutcome,
  type PreferenceToggleMember,
} from "./attention-preference-model.js";
import {
  rejectionRefusal,
  toggleableValueFor,
  unwritableRecordRefusal,
  type TogglePreferenceRow,
} from "./notification-preference-reading.js";

export type { TogglePreferenceRow } from "./notification-preference-reading.js";

/**
 * The two operations this writer reaches.
 *
 * Narrowed off the port rather than the whole growth surface: it writes one record
 * and reads the set back, and a writer holding a handle to fifty other operations
 * would be a writer nothing stops from calling one.
 */
export type AttentionPreferencePort = Pick<
  ConsoleBridge["growth"],
  "attentionPreferenceRead" | "attentionPreferenceUpdate"
>;

/** What the page renders one record's switches from. */
export interface PreferenceWriteSnapshot {
  /** Records with a write in flight, or a toggle queued behind one. */
  readonly busyRecordKeys: ReadonlySet<string>;
  /** The last refusal per switch. Dropped when that switch is pressed again. */
  readonly refusalByMemberKey: ReadonlyMap<string, ConsoleRefusal>;
  /** Bumped on every transition, so a re-render sees a new identity. */
  readonly revision: number;
}

const NOTHING_IN_FLIGHT: PreferenceWriteSnapshot = {
  busyRecordKeys: new Set(),
  refusalByMemberKey: new Map(),
  revision: 0,
};

/** A toggle waiting for the record's current write to settle. */
interface QueuedFlip {
  readonly memberName: string;
  readonly memberKey: string;
}

/**
 * The key every record's write loop measures itself against.
 *
 * One key for every record, deliberately: what invalidates a write here is the
 * teardown and never another record's write, so a key per record would be a
 * distinction the writer does not make and a register that grew with the page.
 */
const WRITE_ROUND_KEY = "write-round";

/** The key the whole-set re-read is taken under, which every loop shares and races on. */
const SET_READ_KEY = "set-read";

/**
 * One participant's stored preference writes, serialised per record.
 *
 * A class with private fields rather than a hook body, per `apps/desktop/AGENTS.md`:
 * it owns a queue, a write generation, and the rule that decides what a queued
 * toggle is composed against. The React binding lives in `NotificationsPage.tsx`.
 */
export class NotificationPreferenceWriter {
  readonly #port: AttentionPreferencePort;
  /**
   * Whose preferences these are, or `undefined` until the identity read lands.
   *
   * The switches are not drawn before then — the section renders its loading shape —
   * so a toggle cannot reach a writer with no participant through the interface. The
   * guard makes that a property rather than a coincidence, and it fails closed:
   * a record is never written under a participant nobody resolved.
   */
  readonly #participantId: string | undefined;
  readonly #onRecordsRead: (outcome: AttentionPreferenceReadOutcome) => void;
  readonly #changes = new Emitter<void>("notification preference write change");
  #snapshot: PreferenceWriteSnapshot = NOTHING_IN_FLIGHT;
  readonly #busyRecordKeys = new Set<string>();
  readonly #queuedFlipsByRecordKey = new Map<string, readonly QueuedFlip[]>();
  readonly #refusalByMemberKey = new Map<string, ConsoleRefusal>();
  /**
   * The two rounds this writer runs, on two keys of one latch.
   *
   * {@link WRITE_ROUND_KEY} is JOINED rather than taken: all of one round's records
   * share it, because what supersedes a write is the teardown rather than another
   * record's write. Every loop reads that handle and none settles through it, so the
   * round it mints stands until {@link releasePendingWrites} supersedes it.
   *
   * {@link SET_READ_KEY} is TAKEN, because whole-set re-reads DO supersede each
   * other: every record's loop reads the same set, and only the latest-taken read
   * describes the state the page should be showing.
   */
  readonly #acts = new GenerationLatch();

  public constructor(options: {
    readonly port: AttentionPreferencePort;
    readonly participantId: string | undefined;
    /** Where the re-read after a served write lands. The page holds the set. */
    readonly onRecordsRead: (outcome: AttentionPreferenceReadOutcome) => void;
  }) {
    this.#port = options.port;
    this.#participantId = options.participantId;
    this.#onRecordsRead = options.onRecordsRead;
  }

  public snapshot(): PreferenceWriteSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Flip one member of one record.
   *
   * Sent immediately when the record is idle, queued when it is not. Either way the
   * record becomes busy, which is what disables every switch inside it.
   */
  public toggle(row: TogglePreferenceRow, member: PreferenceToggleMember): void {
    if (this.#participantId === undefined) {
      return;
    }
    // Last time's reason is dropped on the attempt rather than on its settlement, so
    // a person pressing again does not read it beside this time's spinner.
    this.#refusalByMemberKey.delete(member.memberKey);
    if (this.#busyRecordKeys.has(row.key)) {
      const queued = this.#queuedFlipsByRecordKey.get(row.key) ?? [];
      this.#queuedFlipsByRecordKey.set(row.key, [
        ...queued,
        { memberName: member.name, memberKey: member.memberKey },
      ]);
      this.#publish();
      return;
    }
    this.#busyRecordKeys.add(row.key);
    this.#publish();
    void this.#writeUntilQueueIsEmpty(
      this.#acts.currentClaim(this, WRITE_ROUND_KEY),
      row.key,
      flipMember(row.value, member.name),
      member.memberKey,
    );
  }

  /**
   * Abandon every write and re-read still in flight.
   *
   * Not terminal: a later toggle starts a fresh round. A React effect's cleanup runs
   * between the two invocations StrictMode makes of one effect, and a terminal
   * teardown would leave a mounted page whose switches do nothing.
   */
  public releasePendingWrites(): void {
    this.#acts.supersedeAll();
    this.#busyRecordKeys.clear();
    this.#queuedFlipsByRecordKey.clear();
    this.#publish();
  }

  /**
   * Write one record, re-read the set, and take whatever queued behind it.
   *
   * A loop rather than a chain of promises so the record's queue is drained in the
   * order it was filled, with exactly one write and one re-read in flight at a time.
   *
   * Every exit unlocks the record. The port answers a refusal rather than throwing,
   * but a bridge that rejects instead would otherwise leave the record locked for the
   * window's life — every switch in it dead, with nothing on screen saying why.
   */
  async #writeUntilQueueIsEmpty(
    round: CurrentGenerationClaim,
    recordKey: string,
    firstValue: Readonly<Record<string, boolean>>,
    firstMemberKey: string,
  ): Promise<void> {
    const participantId = this.#participantId;
    if (participantId === undefined) {
      return;
    }
    let value = firstValue;
    let memberKey = firstMemberKey;
    try {
      for (;;) {
        const written = await this.#port.attentionPreferenceUpdate({
          participantId,
          key: recordKey,
          value,
        });
        if (!round.isCurrent) {
          return;
        }
        if (written.status === "unavailable") {
          this.#abandonRecord(recordKey, memberKey, written);
          return;
        }
        // Re-read rather than patched, so this page never holds a second copy of a
        // record the daemon owns — and so a queued toggle is composed against what
        // the daemon actually stored rather than against what this writer sent.
        const setRead = this.#acts.supersedeAndClaim(this, SET_READ_KEY);
        const reread = await this.#port.attentionPreferenceRead({ participantId });
        if (!round.isCurrent) {
          return;
        }
        // Published only while this is still the newest set read. A read another
        // record's loop took after this one describes a later state, and handing the
        // page this older snapshot afterwards would revert that record's accepted
        // toggle on screen with nothing to say why. The key is given back on the way
        // out so the next loop's take is the only thing holding it.
        setRead.settle(() => {
          this.#onRecordsRead(reread);
        });
        setRead.release();
        const queued = this.#takeNextQueuedFlip(recordKey);
        if (queued === undefined) {
          this.#busyRecordKeys.delete(recordKey);
          this.#publish();
          return;
        }
        const stored = toggleableValueFor(reread, recordKey);
        if (stored === undefined) {
          this.#abandonRecord(recordKey, queued.memberKey, unwritableRecordRefusal(reread));
          return;
        }
        value = flipMember(stored, queued.memberName);
        memberKey = queued.memberKey;
      }
    } catch (rejection: unknown) {
      if (round.isCurrent) {
        this.#abandonRecord(recordKey, memberKey, rejectionRefusal(rejection));
      }
    }
  }

  /**
   * Stop writing this record, and say why on every switch that was waiting.
   *
   * The queued toggles are dropped rather than retried: each one was composed for a
   * record whose write did not happen, and re-sending one would be a guess about
   * which of the two facts survived. Naming them all keeps a dropped press from
   * disappearing without a word.
   */
  #abandonRecord(recordKey: string, memberKey: string, refusal: ConsoleRefusal): void {
    const dropped = this.#queuedFlipsByRecordKey.get(recordKey) ?? [];
    this.#queuedFlipsByRecordKey.delete(recordKey);
    this.#busyRecordKeys.delete(recordKey);
    this.#refusalByMemberKey.set(memberKey, refusal);
    for (const flip of dropped) {
      this.#refusalByMemberKey.set(flip.memberKey, refusal);
    }
    this.#publish();
  }

  #takeNextQueuedFlip(recordKey: string): QueuedFlip | undefined {
    const [next, ...remaining] = this.#queuedFlipsByRecordKey.get(recordKey) ?? [];
    if (next === undefined) {
      return undefined;
    }
    if (remaining.length === 0) {
      this.#queuedFlipsByRecordKey.delete(recordKey);
    } else {
      this.#queuedFlipsByRecordKey.set(recordKey, remaining);
    }
    return next;
  }

  /**
   * Publish the state the switches render from.
   *
   * Copied on publish rather than exposed live, because `useSyncExternalStore`
   * compares snapshot identity: a reader handed this writer's own collections would
   * see them change under it and never learn that they had.
   */
  #publish(): void {
    this.#snapshot = {
      busyRecordKeys: new Set(this.#busyRecordKeys),
      refusalByMemberKey: new Map(this.#refusalByMemberKey),
      revision: this.#snapshot.revision + 1,
    };
    this.#changes.emit();
  }
}
