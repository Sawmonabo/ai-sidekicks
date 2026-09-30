// When a pane's refusal becomes the whole session screen's, and when it stays the pane's.
// Only banner-class codes escalate; a retry re-renders under an unchanged refusal (producers
// mint a fresh object each time), so an equal refusal stays dismissed and a changed one comes
// back. Either case alone is satisfiable by a wrong hook.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { useRefusalBannerEscalation } from "./useRefusalBannerEscalation.js";

const GONE_SESSION = refuse("runs", "session.not_found", "That session is not on this node.");
const PANE_REFUSAL = refuse("runs", "run.version_conflict", "The run moved on.");

describe("which refusals reach the frame", () => {
  it("raises a banner for a code the table renders as one", () => {
    const frameStore = new WindowStore();

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
    // Escalating everything would put one pane's read failure across the whole session screen.
    const frameStore = new WindowStore();

    renderHook(() => {
      useRefusalBannerEscalation(frameStore, PANE_REFUSAL);
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("raises nothing for a code the table does not answer for", () => {
    const frameStore = new WindowStore();

    renderHook(() => {
      useRefusalBannerEscalation(
        frameStore,
        refuse("runs", "driver.capability_unsupported", "This driver cannot rewind."),
      );
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("raises nothing while the view has no refusal to hand over", () => {
    const frameStore = new WindowStore();

    renderHook(() => {
      useRefusalBannerEscalation(frameStore, undefined);
    });

    expect(frameStore.getState().banners).toStrictEqual([]);
  });
});

describe("how often it escalates", () => {
  it("does not raise the banner again while the refusal is unchanged", () => {
    // A dismissal stays dismissed under a pane that keeps re-rendering the same failed read.
    const frameStore = new WindowStore();
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
    const frameStore = new WindowStore();
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
    // Producers allocate a fresh refusal per failed refresh, so a hook keyed on object identity
    // would re-raise each time. The condition is unchanged, so nothing new is being told.
    const frameStore = new WindowStore();
    const rendered = renderHook(
      ({ refusal }: { refusal: Refusal }) => {
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
    // The other arm, and the negative control for the case above: a hook that suppressed on the
    // code alone would never tell the person the sentence changed.
    const frameStore = new WindowStore();
    const rendered = renderHook(
      ({ refusal }: { refusal: Refusal }) => {
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
