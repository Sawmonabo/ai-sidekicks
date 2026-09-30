// The page tab strip appears only once there are two pages to choose between.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { previewPage as page } from "../page-list-reading.test-support.js";
import { PageTabStrip } from "./PageTabStrip.js";

describe("the tab strip's frame", () => {
  it("draws nothing for one page, and a strip for two", () => {
    const one = render(
      <PageTabStrip
        reading={{ kind: "served", frame: { pages: [page({ pageId: "a" })], activeIndex: 0 } }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
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
    );
    expect(document.querySelectorAll(".meridian-preview-tab")).toHaveLength(2);
  });
});
