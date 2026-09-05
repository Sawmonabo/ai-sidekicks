// How the artifact pane's reader is HELD: the clock it runs on, and the subject-scoped
// seam that decides when a new one is minted and the old one disposed.
//
// ONE SUBJECT AND NOT TWO. A reader that outlives its subject and a reader that reads
// the wall clock are the same defect seen from two sides — both are a pane answering
// about a session it is no longer showing — so the cases sit together rather than beside
// the acts they happen to drive.
//
// What the pane renders is in `ArtifactPane.test.tsx`; what its acts do, in
// `ArtifactPane.acts.test.tsx`.

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import {
  type GrowthPortAnswer,
  LISTED_ONE_ROW,
  SESSION_ID,
  artifactBridgeAnswering,
  readThrough,
  settleAct,
} from "./artifact-pane.test-support.js";
import {
  ARTIFACT_ENTITY,
  OTHER_ARTIFACT_ENTITY,
  contextFor,
  paneTree,
  renderPane,
  renderPaneStrictly,
} from "./artifact-pane-mount.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact pane — the reader runs on the window's clock, never one of its own", () => {
  it("reads when the scenario clock reaches the window, not when the host's does", async () => {
    // The defect: `ArtifactPaneReader` defaulted to a `RealClock`, so a pane composed
    // under the fixture coalesced its reads against wall time while the scenario
    // advanced on frozen time. On that code the host-timer advance below lists the row
    // and this case fails on its first assertion.
    const clock = new ManualClock();
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, clock }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough();
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });

  it("negative control: a bridge with no scenario clock still reads on the host's", async () => {
    // `consoleClockFor` mints a `RealClock` where no engine is running, which is what
    // every other case here relies on — so the case above is about which clock the
    // reader was handed rather than about the pane having stopped reading.
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });
});

describe("artifact pane — the reader is held by the subject-scoped seam", () => {
  it("comes back from the disposal-then-replay React's double-mount performs", async () => {
    // The defect this arm closes. A reader constructed in `useMemo` and disposed by
    // the effect's cleanup meets `StrictMode` like this: setup starts it, cleanup
    // DISPOSES it, and the replayed setup calls `start()` on the corpse, which returns
    // at once because a disposed reader reads nothing ever again. The pane then sits
    // on its not-read absence for the life of the mount, with no refusal and no
    // sentence — there is nothing on screen that could say so. On that code this case
    // fails on the row assertion below.
    const clock = new ManualClock();
    const { container } = renderPaneStrictly(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, clock }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough(clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
  });

  it("keeps one reader across a re-render at the same artifact", async () => {
    // What the memo could not promise. React documents a memo as a cache it MAY
    // discard, and a discard at unchanged dependencies constructed a second reader
    // mid-render — the pane blanking to its unread absence and re-running a whole read
    // pair for no participant action. The seam holds the reader in state React owns,
    // so a re-render at the same subject reaches the same one: the row stands and the
    // port is not asked again.
    const clock = new ManualClock();
    const artifactList = vi
      .fn<() => Promise<GrowthPortAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const bridge = artifactBridgeAnswering({ artifactList, clock });
    const announcerClock = new ManualClock();
    const { container, rerender } = render(
      paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock),
    );

    await readThrough(clock);
    await settleAct();
    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);

    // A FRESH context object at the same address, which is what the deck composes on
    // every one of its renders: the address is a value and the subject is the id in it.
    rerender(paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-row")).not.toBeNull();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });

  it("mints a reader of its own when the pane moves to another artifact", async () => {
    // The subject IS the key, so a moved subject is a new reader — and the pane opens
    // on the new artifact's not-read absence rather than on the previous one's rows.
    const clock = new ManualClock();
    const artifactList = vi
      .fn<() => Promise<GrowthPortAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const bridge = artifactBridgeAnswering({ artifactList, clock });
    const announcerClock = new ManualClock();
    const { container, rerender } = render(
      paneTree(contextFor(ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock),
    );

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(paneTree(contextFor(OTHER_ARTIFACT_ENTITY, { bridge, sessionStore }), announcerClock));
    await settleAct();
    // The new reader has read nothing yet, and says so rather than showing the rows
    // the previous subject's reader had already listed.
    expect(container.querySelector(".meridian-artifact-row")).toBeNull();

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("mints a reader of its own when the session projection is replaced", async () => {
    // The store is not part of the seam's key — an artifact id already names one
    // session — so a projection rebuilt across a reconnect is caught by asking the
    // reader instead. Without that arm the pane would go on observing a retired store
    // and never hear another artifact frame from the live one.
    const clock = new ManualClock();
    const artifactList = vi
      .fn<() => Promise<GrowthPortAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const bridge = artifactBridgeAnswering({ artifactList, clock });
    const announcerClock = new ManualClock();
    const { rerender } = render(
      paneTree(
        contextFor(ARTIFACT_ENTITY, {
          bridge,
          sessionStore: new SessionStore({ sessionId: SESSION_ID }),
        }),
        announcerClock,
      ),
    );

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    rerender(
      paneTree(
        contextFor(ARTIFACT_ENTITY, {
          bridge,
          sessionStore: new SessionStore({ sessionId: SESSION_ID }),
        }),
        announcerClock,
      ),
    );
    await settleAct();
    await readThrough(clock);
    await settleAct();

    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("negative control: an unmounted pane's reader is disposed and reads no more", async () => {
    // Both halves of the over-reach a re-mint arm invites. A binding that answered the
    // double-mount by never disposing would leave a torn-down pane still scheduling —
    // and one that re-minted on every effect run would read forever. Neither survives
    // an unmount: the seam's own cleanup disposes what the last commit held, and a
    // clock advanced afterwards reaches nothing.
    const clock = new ManualClock();
    const artifactList = vi
      .fn<() => Promise<GrowthPortAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const { unmount } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ artifactList, clock }),
        sessionId: SESSION_ID,
      }),
    );

    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);

    unmount();
    await readThrough(clock);
    await settleAct();
    expect(artifactList).toHaveBeenCalledTimes(1);
  });
});
