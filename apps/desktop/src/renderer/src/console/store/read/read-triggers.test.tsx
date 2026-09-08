// Whether one arrived frame owes a reading a re-read, and both wirings asking it once.
//
// `eventTriggersRead` is the whole of that decision, and it is checked here rather than
// only through a family that happens to declare a frame-level rule: the kind gate has
// been the answer since the seam was written, the frame gate is new, and a reading that
// declared one and was asked the other would either re-read on everything or stop
// re-reading at all.
//
// AND IT IS ASKED THROUGH THE REACT WIRING TOO. `useSessionReadTriggers` here and
// `SessionRefreshTriggers` beside it are two wirings of one policy, which that module's
// own head calls honest — two VOCABULARIES are not. A predicate consulted by one and
// not the other goes stale on exactly the surfaces wired the other way, and no unit test
// of the predicate alone would report it, so the hook is driven against a real store.
// The imperative wiring is driven the same way from
// `workflows/pane/run/run-live-rounds.test.ts`, which is where its reading lives.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../entities/entities.js";
import {
  eventTriggersRead,
  useSessionReadTriggers,
  type ReadTriggerTarget,
} from "./read-triggers.js";
import type { RefreshReason } from "./refresh-scheduler.js";
import { eventOfKind } from "../session-event.test-support.js";
import { SessionStore } from "../session/session-store.js";

const SESSION_ID = "session-read-triggers";
const DECLARED_KIND = "run.completed";
/** The subject one reading is about, and another frame of the same kind is not. */
const SUBJECT_ON_SCREEN = "019b7a10-0280-7aa1-8100-70100000000a";
const SUBJECT_ELSEWHERE = "019b7a10-0280-7aa1-8100-70100000000b";

/** One frame of the declared kind, naming whichever subject the case is about. */
function frameNaming(subjectId: string | undefined, sequence: number): ConsoleSessionEvent {
  return eventOfKind(
    SESSION_ID,
    DECLARED_KIND,
    sequence,
    subjectId === undefined ? undefined : { subjectId },
  );
}

/** A reading that records what it was asked for, and what it declares about frames. */
class RecordingReadTarget implements ReadTriggerTarget {
  public readonly reasons: RefreshReason[] = [];
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set([DECLARED_KIND]);

  public constructor(private readonly subjectOnScreen: string | undefined) {}

  public admitsTriggeringEvent(event: ConsoleSessionEvent): boolean {
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

describe("eventTriggersRead — the kind, and then the frame", () => {
  it("refuses a kind the reading never declared, without reading the payload", () => {
    const target = new RecordingReadTarget(SUBJECT_ON_SCREEN);
    expect(
      eventTriggersRead(
        target,
        eventOfKind(SESSION_ID, "run.failed", 1, { subjectId: SUBJECT_ON_SCREEN }),
      ),
    ).toBe(false);
  });

  it("admits a declared kind whose frame names this reading's subject", () => {
    const target = new RecordingReadTarget(SUBJECT_ON_SCREEN);
    expect(eventTriggersRead(target, frameNaming(SUBJECT_ON_SCREEN, 1))).toBe(true);
  });

  it("refuses a declared kind whose frame names another subject", () => {
    const target = new RecordingReadTarget(SUBJECT_ON_SCREEN);
    expect(eventTriggersRead(target, frameNaming(SUBJECT_ELSEWHERE, 1))).toBe(false);
  });

  it("admits every declared kind for a reading that states no frame rule", () => {
    // The absence is the default and not an omission: every reading in the tree behaved
    // this way before the member existed, and none of them was edited to keep doing so.
    const target = new KindOnlyReadTarget();
    expect(eventTriggersRead(target, frameNaming(SUBJECT_ELSEWHERE, 1))).toBe(true);
    expect(eventTriggersRead(target, frameNaming(undefined, 2))).toBe(true);
  });
});

describe("useSessionReadTriggers — the React wiring consults the same predicate", () => {
  /** A store the wiring reads transitions off — initialised, as the trigger set requires. */
  function initialisedStore(): SessionStore {
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    return sessionStore;
  }

  /** Mount the wiring over one store, then let the frames land on it. */
  function wireAndApply(
    target: ReadTriggerTarget,
    frames: readonly ConsoleSessionEvent[],
  ): SessionStore {
    const sessionStore = initialisedStore();
    function Wiring(): null {
      useSessionReadTriggers(target, sessionStore);
      return null;
    }
    const { rerender } = render(<Wiring />);
    sessionStore.applyBatch(frames);
    rerender(<Wiring />);
    return sessionStore;
  }

  it("does not ask for a read when every frame names another subject", () => {
    const target = new RecordingReadTarget(SUBJECT_ON_SCREEN);
    wireAndApply(target, [frameNaming(SUBJECT_ELSEWHERE, 1), frameNaming(SUBJECT_ELSEWHERE, 2)]);
    expect(target.reasons).toStrictEqual([]);
  });

  it("negative control: the same frames advance a reading addressed at THAT subject", () => {
    // Without this, the case above would pass over a wiring that had stopped observing
    // the timeline at all — which is the same green and the opposite defect.
    const target = new RecordingReadTarget(SUBJECT_ELSEWHERE);
    wireAndApply(target, [frameNaming(SUBJECT_ELSEWHERE, 1), frameNaming(SUBJECT_ELSEWHERE, 2)]);
    expect(target.reasons).toStrictEqual(["terminal-event"]);
  });

  it("negative control: a reading that states no frame rule takes them all", () => {
    const target = new KindOnlyReadTarget();
    wireAndApply(target, [frameNaming(SUBJECT_ELSEWHERE, 1)]);
    expect(target.reasons).toStrictEqual(["terminal-event"]);
  });
});
