// Preview's tab strip appears only once there are two pages to choose between.

import { render } from "@testing-library/react";
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

describe("the page tab strip", () => {
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
    expect(one.container.querySelector(".meridian-tab-strip")).toBeNull();
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
    expect(document.querySelectorAll(".meridian-tab")).toHaveLength(2);
  });
});
