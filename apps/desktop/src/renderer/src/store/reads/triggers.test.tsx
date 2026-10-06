// A reading asks for a fresh read when an admitted frame owes it one: through the React wiring
// against a real store, for a reading that states a frame rule and one that does not. A reading
// that never hears its frames stays on screen with an answer the session has moved past.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProjectedSessionEvent } from "../session/entities/vocabulary.js";
import { type ReadTriggerTarget } from "./triggers.js";
import { useSessionReadTriggers } from "./hooks/useSessionReadTriggers.js";
import type { RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { SessionStore } from "../session/store.js";

const SESSION_ID = "session-read-triggers";
const DECLARED_KIND = "run.completed";
/** The subject every frame here names. */
const SUBJECT_ELSEWHERE = "019b7a10-0280-7aa1-8100-70100000000b";

/** One frame of the declared kind, naming whichever subject the case is about. */
function frameNaming(subjectId: string, sequence: number): ProjectedSessionEvent {
  return eventOfKind(SESSION_ID, DECLARED_KIND, sequence, { subjectId });
}

/** A reading that records what it was asked for, and what it declares about frames. */
class RecordingReadTarget implements ReadTriggerTarget {
  public readonly reasons: RefreshReason[] = [];
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set([DECLARED_KIND]);

  public constructor(private readonly subjectOnScreen: string | undefined) {}

  public admitsTriggeringEvent(event: ProjectedSessionEvent): boolean {
    const named = event.payload?.["subjectId"];
    return typeof named !== "string" || named === this.subjectOnScreen;
  }

  public requestRead(reason: RefreshReason): void {
    this.reasons.push(reason);
  }
}

/** A reading that declares kinds and nothing about frames, as every earlier one did. */
class KindOnlyReadTarget implements ReadTriggerTarget {
  public readonly reasons: RefreshReason[] = [];
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set([DECLARED_KIND]);

  public requestRead(reason: RefreshReason): void {
    this.reasons.push(reason);
  }
}

describe("useSessionReadTriggers — the React wiring consults the same predicate", () => {
  /** A store the wiring reads transitions off — initialized, as the trigger set requires. */
  function initializedStore(): SessionStore {
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialize({ cursor: 0, entities: [] });
    return sessionStore;
  }

  /** Mount the wiring over one store, then let the frames land on it. */
  function wireAndApply(
    target: ReadTriggerTarget,
    frames: readonly ProjectedSessionEvent[],
  ): SessionStore {
    const sessionStore = initializedStore();
    function Wiring(): null {
      useSessionReadTriggers(target, sessionStore);
      return null;
    }
    const { rerender } = render(<Wiring />);
    sessionStore.applyBatch(frames);
    rerender(<Wiring />);
    return sessionStore;
  }

  it("asks for a read when a frame names the subject the reading is about", () => {
    const target = new RecordingReadTarget(SUBJECT_ELSEWHERE);
    wireAndApply(target, [frameNaming(SUBJECT_ELSEWHERE, 1), frameNaming(SUBJECT_ELSEWHERE, 2)]);
    expect(target.reasons).toStrictEqual(["terminal-event"]);
  });

  it("asks for a read on every frame of a declared kind when the reading has no frame rule", () => {
    const target = new KindOnlyReadTarget();
    wireAndApply(target, [frameNaming(SUBJECT_ELSEWHERE, 1)]);
    expect(target.reasons).toStrictEqual(["terminal-event"]);
  });
});
