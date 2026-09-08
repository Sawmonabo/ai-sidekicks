// When a pane's refusal becomes the whole workspace's, and when it stays the pane's.
//
// Three claims, and the second is the one a re-render would break silently: a pane
// whose read refuses on every retry re-renders under an unchanged refusal, and a hook
// that raised on every render would put a banner back the moment a person dismissed
// it. The first claim is the rule itself — only the codes the remedy table calls
// banners escalate — and the third is its negative control.
//
// AND THE SECOND CLAIM IS ABOUT THE CONDITION, NOT THE OBJECT. A retry does not hand
// the same refusal VALUE back — every producer in this console mints a fresh one per
// failed read — so the two cases at the end of `how often it escalates` are the pair
// that decides the rule: an equal refusal stays dismissed and a changed one comes
// back. Either one alone is satisfiable by a wrong hook.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { FrameStore } from "./frame-store.js";
import {
  newestBannerClassRefusalAmong,
  preferredBannerClassRefusalAmong,
  useRefusalBannerEscalation,
} from "./refusal-escalation.js";

const GONE_SESSION = refuse("runs", "session.not_found", "That session is not on this node.");
const PANE_REFUSAL = refuse("runs", "run.version_conflict", "The run moved on.");

describe("which refusals reach the frame", () => {
  it("raises a banner for a code the table renders as one", () => {
    const frameStore = new FrameStore();

    renderHook(() => {
      useRefusalBannerEscalation(frameStore, GONE_SESSION);
    });

    expect(frameStore.getState().banners).toStrictEqual([
      {
        id: `${GONE_SESSION.origin}:${GONE_SESSION.code}`,
        dismissible: true,
        code: GONE_SESSION.code,
        detail: GONE_SESSION.detail,
      },
    ]);
  });

  it("leaves a pane's own refusal in the pane", () => {
    // Escalating everything would put one pane's read failure across a workspace
    // where every other pane is fine.
    const frameStore = new FrameStore();

    renderHook(() => {
      useRefusalBannerEscalation(frameStore, PANE_REFUSAL);
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("raises nothing for a code the table does not answer for", () => {
    const frameStore = new FrameStore();

    renderHook(() => {
      useRefusalBannerEscalation(
        frameStore,
        refuse("runs", "driver.capability_unsupported", "This driver cannot rewind."),
      );
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("raises nothing while the surface has no refusal to hand over", () => {
    const frameStore = new FrameStore();

    renderHook(() => {
      useRefusalBannerEscalation(frameStore, undefined);
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });
});

describe("how often it escalates", () => {
  it("does not raise the banner again while the refusal is unchanged", () => {
    // The behaviour that matters: dismiss stays dismissed under a pane that keeps
    // re-rendering with the same failed read.
    const frameStore = new FrameStore();
    const rendered = renderHook(() => {
      useRefusalBannerEscalation(frameStore, GONE_SESSION);
    });
    const [raised] = frameStore.getState().banners;
    if (raised === undefined) {
      throw new Error("the first render raised no banner");
    }
    frameStore.dismissBanner(raised.id);

    rendered.rerender();
    rendered.rerender();

    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("raises again once the refusal itself is a different one", () => {
    const frameStore = new FrameStore();
    const secondRefusal = refuse("repos", "session.not_found", "Gone from this node.");
    const rendered = renderHook(
      ({ refusal }: { refusal: typeof GONE_SESSION }) => {
        useRefusalBannerEscalation(frameStore, refusal);
      },
      { initialProps: { refusal: GONE_SESSION } },
    );
    frameStore.dismissBanner(`${GONE_SESSION.origin}:${GONE_SESSION.code}`);

    rendered.rerender({ refusal: secondRefusal });

    expect(frameStore.getState().banners.map((banner) => banner.id)).toStrictEqual([
      `${secondRefusal.origin}:${secondRefusal.code}`,
    ]);
  });

  it("keeps the banner dismissed when a retry mints an equal refusal", () => {
    // The defect this exists for. The approvals reader allocates a fresh refusal on
    // every failed refresh — including the window-focus retries the read triggers
    // arm — so a hook keyed on object identity re-raised on each one and dismissal
    // lasted until the next retry. The condition has not changed, so nothing new is
    // being told to anybody, and a banner that keeps coming back is one people stop
    // reading.
    const frameStore = new FrameStore();
    const rendered = renderHook(
      ({ refusal }: { refusal: ConsoleRefusal }) => {
        useRefusalBannerEscalation(frameStore, refusal);
      },
      {
        initialProps: {
          refusal: refuse("approvals", "session.not_found", "That session is not on this node."),
        },
      },
    );
    frameStore.dismissBanner("approvals:session.not_found");

    rendered.rerender({
      refusal: refuse("approvals", "session.not_found", "That session is not on this node."),
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("raises again when the retry reports a different condition under the same code", () => {
    // The other arm of the same rule, and the negative control on the one above: a
    // hook that suppressed on the CODE alone would swallow this, and the person
    // would never be told the sentence had changed.
    const frameStore = new FrameStore();
    const rendered = renderHook(
      ({ refusal }: { refusal: ConsoleRefusal }) => {
        useRefusalBannerEscalation(frameStore, refusal);
      },
      {
        initialProps: {
          refusal: refuse("approvals", "session.not_found", "That session is not on this node."),
        },
      },
    );
    frameStore.dismissBanner("approvals:session.not_found");

    rendered.rerender({
      refusal: refuse("approvals", "session.not_found", "That session was archived here."),
    });

    expect(frameStore.getState().banners).toStrictEqual([
      {
        id: "approvals:session.not_found",
        dismissible: true,
        code: "session.not_found",
        detail: "That session was archived here.",
      },
    ]);
  });
});

describe("which refusals an appended set hands over", () => {
  it("answers with the banner-class member of a mixed set", () => {
    expect(newestBannerClassRefusalAmong([undefined, PANE_REFUSAL, GONE_SESSION])).toStrictEqual(
      GONE_SESSION,
    );
  });

  it("answers with the LAST banner-class member, which is the newest one", () => {
    // Callers hand their records in arrival order — the approvals reader's resolve
    // map and the run-control surface's settlement list are both appended to — so a
    // set holding two says the newer thing.
    const newer = refuse("approvals", "session.not_found", "Gone since the last read.");
    expect(newestBannerClassRefusalAmong([GONE_SESSION, newer])).toStrictEqual(newer);
  });

  it("answers with nothing where the set holds no banner-class refusal", () => {
    expect(newestBannerClassRefusalAmong([undefined, PANE_REFUSAL])).toBeUndefined();
  });
});

describe("which refusals a concurrent set hands over", () => {
  // The approvals pane's three reads go out together, so their order is the order it
  // wants them preferred rather than the order the daemon answered in. That is why
  // this selector exists beside the one above rather than as a flag on it, and these
  // cases are what state which rule each name carries.
  it("answers with the FIRST banner-class candidate, which is the preferred one", () => {
    const lessPreferred = refuse("growth-port", "session.not_found", "Gone at the port.");
    expect(
      preferredBannerClassRefusalAmong([undefined, GONE_SESSION, lessPreferred]),
    ).toStrictEqual(GONE_SESSION);
  });

  it("differs from the newest rule on the very same set", () => {
    // The two rules answer differently or one of them is unnecessary. One fact, one
    // handover: the frame keys a banner on origin AND code, so two reads that noticed
    // one loss under two origins would otherwise raise two banners saying one thing.
    const lessPreferred = refuse("growth-port", "session.not_found", "Gone at the port.");
    const concurrent = [GONE_SESSION, lessPreferred];
    expect(preferredBannerClassRefusalAmong(concurrent)).toStrictEqual(GONE_SESSION);
    expect(newestBannerClassRefusalAmong(concurrent)).toStrictEqual(lessPreferred);
  });

  it("negative control: an ordinary refusal stays the surface's own business", () => {
    // Without this the selector would pass while escalating everything, which would
    // put one pane's read failure across the whole workspace.
    expect(preferredBannerClassRefusalAmong([PANE_REFUSAL, undefined])).toBeUndefined();
    expect(preferredBannerClassRefusalAmong([undefined, undefined, undefined])).toBeUndefined();
  });
});
