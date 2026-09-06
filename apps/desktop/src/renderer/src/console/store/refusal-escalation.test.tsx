// When a pane's refusal becomes the whole workspace's, and when it stays the pane's.
//
// Three claims, and the second is the one a re-render would break silently: a pane
// whose read refuses on every retry re-renders under an unchanged refusal, and a hook
// that raised on every render would put a banner back the moment a person dismissed
// it. The first claim is the rule itself — only the codes the remedy table calls
// banners escalate — and the third is its negative control.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { FrameStore } from "./frame-store.js";
import { useRefusalBannerEscalation } from "./refusal-escalation.js";

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
});
