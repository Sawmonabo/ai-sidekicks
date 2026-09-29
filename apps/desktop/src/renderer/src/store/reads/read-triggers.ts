// The four moments a console reading re-reads, wired once for every reading.
//
// A READING IS NOT A SUBSCRIPTION. Every read this console performs answers a
// question at one instant, and four things make that answer stale: a view
// arriving that has never had one, the window coming back after time passed
// elsewhere, a stream that went away and came back, and an event in this session's
// own timeline saying the answer changed.
//
// THE VOCABULARY IS `RefreshReason`'S AND THE COALESCING IS `RefreshScheduler`'S.
// This module wires and schedules nothing itself: a reading hands it the one method
// that puts a reason into its own scheduler, and the scheduler decides what that
// costs. What this module adds is that the wiring has ONE home, so a reading added
// later cannot quietly ship with two of the four.
//
// WHERE THE REPAIR EDGE IS DETECTED. Here, and only here: the flip lives in this
// module's own memory, beside the timeline cursor it is minted and discarded with,
// because they are one memory of one session's history.
import type { ProjectedSessionEvent } from "../session/entities/entities.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";

/**
 * What a trigger set needs of the reading it refreshes.
 *
 * Two members and no more: a reading is free to be a class held in a registry, a
 * cache keyed by bridge, or a hook's own object, and this module deliberately knows
 * which of those none of them is.
 */
export interface ReadTriggerTarget {
  /**
   * The session-event kinds whose arrival owes this reading a fresh read.
   *
   * DECLARED BY THE READING and not passed by the view that mounts it, because
   * which events change an answer is a property of the QUESTION: two views asking
   * the same one must not disagree about when it goes stale. An empty set is a real
   * answer rather than an omission — a reading whose own live tail is the authority
   * for what it holds learns nothing from the timeline, and says so.
   */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /**
   * Whether THIS frame, of an already-declared kind, owes this reading a read.
   *
   * OPTIONAL, AND ITS ABSENCE IS THE DEFAULT RATHER THAN AN OMISSION: a reading whose
   * question is answered by the kind alone declares nothing here and every frame of a
   * declared kind reaches it, which is what every reading in the tree did before this
   * member existed.
   *
   * IT EXISTS BECAUSE A KIND IS NOT ALWAYS THE WHOLE QUESTION. A session runs many
   * workflows, and every one of the workflow engine's twenty-four kinds is emitted for
   * whichever run the engine advanced — so a run pane declaring the kinds re-read on
   * every OTHER run's phases too, once per pane, for as long as anything in the session
   * was moving. The subject the reading is addressed at is the missing half, and it is
   * a property of the READING rather than of the wiring, which is why it is declared
   * here beside the kinds and not passed in at either call site.
   *
   * A PREDICATE AND NOT A NARROWER KIND SET, because the two answer different
   * questions: which kinds can change this answer at all is static, and which FRAMES
   * changed it is per frame. Fusing them would mean a reading whose subject moved had
   * to re-declare a set, and the set is what two readings asking the same question must
   * agree on.
   */
  admitsTriggeringEvent?(event: ProjectedSessionEvent): boolean;
  /** Ask for a read. Coalescing, debouncing, and the call itself are the reading's. */
  requestRead(reason: RefreshReason): void;
}

/**
 * Whether one admitted frame owes `target` a read: the declared kind, then the frame.
 *
 * ONE PREDICATE FOR BOTH WIRINGS. `useSessionReadTriggers` below and
 * `SessionRefreshTriggers` beside it wire the same policy for two kinds of reading —
 * one mounted by React, one minted in a resource seam — and the comment at the head of
 * that module states the rule they are held to: two wirings are honest and two
 * VOCABULARIES are not. A reading whose frame-level admission was consulted by one of
 * them and not the other would go stale on exactly the views wired the other way,
 * which is a defect no test of either module alone would report.
 *
 * The kind is checked FIRST and the predicate only after, so a reading pays the cost of
 * reading a payload only for frames it had already declared an interest in.
 */
export function eventTriggersRead(
  target: ReadTriggerTarget,
  event: ProjectedSessionEvent,
): boolean {
  if (!target.triggeringEventKinds.has(event.kind)) {
    return false;
  }
  return target.admitsTriggeringEvent?.(event) ?? true;
}

/**
 * The empty declaration, named once so four readings share one frozen set.
 *
 * A reading whose stream already carries every change it folds names this, and the
 * name is the claim: nothing in the timeline tells it something its own tail did not.
 */
export const NO_TRIGGERING_EVENT_KINDS: ReadonlySet<string> = Object.freeze(new Set<string>());
