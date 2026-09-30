// Whether one arrived frame owes a reading a re-read, and both wirings asking it once.
// `eventTriggersRead` is checked directly and not only through a feature whose reading
// declares a frame rule, since a reading that declared one and was asked the other gate would
// either re-read on everything or stop re-reading. It is also driven through the React wiring
// against a real store, because a predicate consulted by `useSessionReadTriggers` and not by
// `SessionRefreshTriggers` would go stale on exactly the views wired the other way; the
// imperative wiring is driven in `features/workflows/run-page/run-live-refresh.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProjectedSessionEvent } from "../session/entities/entities.js";
import { eventTriggersRead, type ReadTriggerTarget } from "./read-triggers.js";
import { useSessionReadTriggers } from "./hooks/useSessionReadTriggers.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { SessionStore } from "../session/session-store.js";

const SESSION_ID = "session-read-triggers";
const DECLARED_KIND = "run.completed";
/** The subject one reading is about, and another frame of the same kind is not. */
const SUBJECT_ON_SCREEN = "019b7a10-0280-7aa1-8100-70100000000a";
const SUBJECT_ELSEWHERE = "019b7a10-0280-7aa1-8100-70100000000b";

/** One frame of the declared kind, naming whichever subject the case is about. */
function frameNaming(subjectId: string | undefined, sequence: number): ProjectedSessionEvent {
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
    // The absence is the default: a reading that states no frame rule admits every frame of a
    // declared kind.
    const target = new KindOnlyReadTarget();
    expect(eventTriggersRead(target, frameNaming(SUBJECT_ELSEWHERE, 1))).toBe(true);
    expect(eventTriggersRead(target, frameNaming(undefined, 2))).toBe(true);
  });
});

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

  it("does not ask for a read when every frame names another subject", () => {
    const target = new RecordingReadTarget(SUBJECT_ON_SCREEN);
    wireAndApply(target, [frameNaming(SUBJECT_ELSEWHERE, 1), frameNaming(SUBJECT_ELSEWHERE, 2)]);
    expect(target.reasons).toStrictEqual([]);
  });

  it("negative control: the same frames advance a reading addressed at THAT subject", () => {
    // Guards against a wiring that had stopped observing the timeline at all.
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
