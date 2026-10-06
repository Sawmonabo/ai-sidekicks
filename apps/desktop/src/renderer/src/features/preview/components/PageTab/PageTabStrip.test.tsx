// The page tab strip appears only once there are two pages to choose between, and a middle-click
// on a tab closes that page as its close control does.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { previewPage as page } from "../../page-list-reading.test-support.js";
import { fixturePreviewBridge } from "../../PreviewPane.test-support.js";
import { PageTabStrip } from "./PageTabStrip.js";

const BridgeWindow = bridgeWrapper(fixturePreviewBridge().bridge);

/** The window the strip is mounted in: the bridge and the frame's live announcer. */
function wrapper(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <BridgeWindow>
      <LiveAnnouncerProvider>{props.children}</LiveAnnouncerProvider>
    </BridgeWindow>
  );
}

describe("the tab strip", () => {
  it("draws nothing for one page, and a strip for two", () => {
    const one = render(
      <PageTabStrip
        reading={{ kind: "served", frame: { pages: [page({ pageId: "a" })], activeIndex: 0 } }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
      { wrapper },
    );
    expect(one.container.querySelector(".meridian-preview-tabs")).toBeNull();
    one.unmount();
    render(
      <PageTabStrip
        reading={{
          kind: "served",
          frame: { pages: [page({ pageId: "a" }), page({ pageId: "b" })], activeIndex: 0 },
        }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
      { wrapper },
    );
    expect(document.querySelectorAll(".meridian-preview-tab")).toHaveLength(2);
  });

  it("closes the page a middle-click lands on, and only for the middle button", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <PageTabStrip
        reading={{
          kind: "served",
          frame: { pages: [page({ pageId: "a" }), page({ pageId: "b" })], activeIndex: 0 },
        }}
        onSelect={onSelect}
        onClose={onClose}
        onReorder={vi.fn()}
      />,
      { wrapper },
    );
    const label = [...document.querySelectorAll(".meridian-preview-tab__label")][1];
    if (label === undefined) {
      throw new Error("the strip drew no second tab");
    }
    fireEvent(label, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(onClose).not.toHaveBeenCalled();
    const middleClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    fireEvent(label, middleClick);
    expect(onClose).toHaveBeenCalledExactlyOnceWith("b");
    expect(middleClick.defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
