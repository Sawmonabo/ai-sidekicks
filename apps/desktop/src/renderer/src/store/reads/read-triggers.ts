// The four moments a console reading re-reads, wired once for every reading: a view arriving
// that has never had an answer, the window regaining focus, a stream that went away and came
// back, and an event in this session's timeline saying the answer changed.
//
// The vocabulary is `RefreshReason`'s and the coalescing is `RefreshScheduler`'s. This module
// schedules nothing: a reading hands it the one method that puts a reason into its own
// scheduler, so a reading added later cannot ship with two of the four. The repair edge is
// detected here, in the same memory as the timeline cursor it is minted and discarded with.
import type { ProjectedSessionEvent } from "../session/entities/entities.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";

/**
 * What a trigger set needs of the reading it refreshes. A reading may be a class held in a
 * registry, a cache keyed by bridge, or a hook's own object; this module knows which none of
 * them is.
 */
export interface ReadTriggerTarget {
  /**
   * The session-event kinds whose arrival owes this reading a fresh read.
   *
   * Declared by the reading, not the view that mounts it, because which events change an
   * answer is a property of the question: two views asking the same one must not disagree
   * about when it goes stale. An empty set is a real answer, for a reading whose own live tail
   * is the authority for what it holds.
   */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /**
   * Whether this frame, of an already-declared kind, owes this reading a read. Optional: a
   * reading whose question is answered by the kind alone declares nothing and every frame of a
   * declared kind reaches it.
   *
   * A kind is not always the whole question. A session runs many workflows and the engine emits
   * each kind for whichever run it advanced, so a run pane declaring the kinds would re-read on
   * every other run's phases. A predicate rather than a narrower kind set, because which kinds
   * can change an answer is static and which frames changed it is per frame.
   */
  admitsTriggeringEvent?(event: ProjectedSessionEvent): boolean;
  /** Asks for a read. Coalescing, debouncing and the call itself are the reading's. */
  requestRead(reason: RefreshReason): void;
}

/**
 * Whether one admitted frame owes `target` a read: the declared kind, then the frame.
 *
 * One predicate for both wirings, `useSessionReadTriggers` and `SessionRefreshTriggers`, so a
 * reading's frame-level admission cannot be consulted by one and not the other. The kind is
 * checked first, so a payload is read only for frames of a declared kind.
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
 * The empty declaration, shared as one frozen set. A reading whose stream already carries
 * every change it folds names this: nothing in the timeline tells it more than its own tail.
 */
export const NO_TRIGGERING_EVENT_KINDS: ReadonlySet<string> = Object.freeze(new Set<string>());
