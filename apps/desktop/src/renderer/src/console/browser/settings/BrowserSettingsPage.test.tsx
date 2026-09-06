// Chapter 13.16, held to its own scope and its own four states.
//
// The page is the whole of the browser in settings, so the cases here are about the
// boundary as much as the content: two switches and a partition table, an empty
// state that still carries the reset control and says why it is inert, a fold at ten,
// and a partition whose pane is open that is never offered a clear.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { BrowserSettingsPage, type BrowserSettingsPageProps } from "./BrowserSettingsPage.js";
import { servingAct } from "./PartitionClearControl.test-support.js";
import type { BrowserSitePartition } from "./site-partitions.js";

const READ_SWITCHES: BrowserSettingsPageProps["switchReadings"] = {
  "file-boundary": { kind: "served", enabled: false },
  "page-tools": { kind: "served", enabled: true },
};

function partition(index: number, overrides?: Partial<BrowserSitePartition>): BrowserSitePartition {
  return {
    sessionId: `session-${String(index).padStart(2, "0")}`,
    sessionTitle: `Session ${String(index)}`,
    size: { kind: "served", byteLength: 1048576 },
    hasOpenPane: false,
    ...overrides,
  };
}

function renderPage(props: Partial<BrowserSettingsPageProps>): HTMLElement {
  const { container } = render(
    <BrowserSettingsPage
      switchReadings={READ_SWITCHES}
      partitions={{ kind: "served", partitions: [] }}
      {...props}
    />,
  );
  const page = container.querySelector("section");
  if (!(page instanceof HTMLElement)) {
    throw new Error("BrowserSettingsPage rendered no page");
  }
  return page;
}

describe("browser settings page — scope", () => {
  it("carries the two switches and the site-data table, and nothing else", () => {
    const page = renderPage({});
    expect(page.querySelectorAll('[role="switch"]')).toHaveLength(2);
    const sectionTitles = [...page.querySelectorAll("h3")].map((node) => node.textContent);
    expect(sectionTitles).toStrictEqual(["Policy", "Site data"]);
  });

  it("names itself for a reader walking the settings surface", () => {
    const page = renderPage({});
    const titleId = page.getAttribute("aria-labelledby");
    expect(page.querySelector(`#${String(titleId)}`)?.textContent).toBe("Browser");
  });
});

describe("browser settings page — the empty partition table", () => {
  it("says no site data is stored and still shows the reset control", () => {
    const page = renderPage({ partitions: { kind: "served", partitions: [] } });
    expect(page.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(page.textContent).toContain("No site data stored yet");
    const control = [...page.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear site data",
    );
    expect(control?.disabled).toBe(true);
  });

  it("negative control: empty is not rendered as a failure or as an unasked question", () => {
    // The read succeeded and found none. Rendering `error` would blame the node and
    // `not-checked` would deny that anyone asked.
    // Scoped to the site-data section: the policy rows carry their own
    // `not-checked` badge when no writer is registered, and a page-wide query
    // would fail on a row that is doing exactly its job.
    const section = renderPage({ partitions: { kind: "served", partitions: [] } }).querySelector(
      '[aria-label="Stored site data"]',
    );
    expect(section?.querySelector(".meridian-nothing--error")).toBeNull();
    expect(section?.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});

describe("browser settings page — the other listing states", () => {
  it("renders the daemon's refusal when the listing was not read", () => {
    const page = renderPage({
      partitions: {
        kind: "refused",
        scope: "whole-answer",
        refusal: refuse(
          "growth-port",
          "wire-unregistered",
          "The browser namespace is not registered yet.",
        ),
      },
    });
    expect(page.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(page.textContent).toContain("wire-unregistered");
    expect(page.textContent).toContain("not registered yet");
  });

  it("renders a skeleton while the sizes are being read", () => {
    const page = renderPage({ partitions: { kind: "reading" } });
    expect(page.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
  });

  it("renders the list without a figure when one size could not be measured", () => {
    const page = renderPage({
      partitions: {
        kind: "served",
        partitions: [
          partition(1, {
            size: {
              kind: "refused",
              scope: "whole-answer",
              refusal: refuse(
                "browser",
                "browser.partition_unreadable",
                "The profile directory could not be read.",
              ),
            },
          }),
        ],
      },
    });
    expect(page.textContent).toContain("Session 1");
    expect(page.textContent).toContain("browser.partition_unreadable");
    expect(page.textContent).toContain("could not be read");
  });

  it("negative control: an unmeasured size is not rendered as zero", () => {
    // The failure this catches is the one that looks tidiest: a missing figure
    // filled in with 0 B, which claims a partition holds nothing.
    const page = renderPage({
      partitions: {
        kind: "served",
        partitions: [
          partition(1, {
            size: {
              kind: "refused",
              scope: "whole-answer",
              refusal: refuse("browser", "browser.partition_unreadable", "Unreadable."),
            },
          }),
        ],
      },
    });
    expect(page.textContent).not.toContain("0 B");
  });
});

describe("browser settings page — the fold", () => {
  it("shows ten rows and folds the rest", () => {
    const partitions = Array.from({ length: 13 }, (_unused, index) => partition(index + 1));
    const page = renderPage({ partitions: { kind: "served", partitions } });
    const fold = page.querySelector("details.meridian-browser-disclosure");
    expect(fold).not.toBeNull();
    expect(fold?.querySelector("summary")?.textContent).toBe("3 more");
    const foldedRows = fold?.querySelectorAll(".meridian-browser-partitions__row") ?? [];
    expect(foldedRows).toHaveLength(3);
    expect(page.querySelectorAll(".meridian-browser-partitions__row")).toHaveLength(13);
  });

  it("does not fold a table that fits", () => {
    const partitions = Array.from({ length: 10 }, (_unused, index) => partition(index + 1));
    const page = renderPage({ partitions: { kind: "served", partitions } });
    expect(page.querySelector("details.meridian-browser-disclosure")).toBeNull();
    expect(page.querySelectorAll(".meridian-browser-partitions__row")).toHaveLength(10);
  });

  it("negative control: the fold hides rows rather than dropping them", () => {
    // A slice that discarded the tail would pass "shows ten rows" and lose three
    // partitions an operator came here to clear.
    const partitions = Array.from({ length: 13 }, (_unused, index) => partition(index + 1));
    const page = renderPage({ partitions: { kind: "served", partitions } });
    expect(page.textContent).toContain("Session 13");
  });
});

describe("browser settings page — arming a clear", () => {
  it("names what it clears before it will clear it", () => {
    const page = renderPage({
      partitions: { kind: "served", partitions: [partition(1)] },
      onClearSiteData: servingAct([], "clear"),
    });
    const arm = page.querySelector("details.meridian-browser-arm");
    expect(arm?.querySelector("summary")?.textContent).toBe("Clear site data");
    expect(arm?.hasAttribute("open")).toBe(false);
    expect(arm?.textContent).toContain("every cookie, cache entry, and storage record");
    expect(arm?.textContent).toContain("filesystem removal rather than a cryptographic erase");
  });

  it("negative control: the scope sentence is not on the collapsed line", () => {
    // Without this, the case above would pass over a row that printed its whole
    // consequence beside the control and armed nothing.
    const page = renderPage({
      partitions: { kind: "served", partitions: [partition(1)] },
      onClearSiteData: servingAct([], "clear"),
    });
    page.querySelector("details.meridian-browser-arm")?.remove();
    expect(page.textContent).not.toContain("every cookie, cache entry, and storage record");
  });

  it("confirms against the session the row names", async () => {
    const callLog: string[] = [];
    const page = renderPage({
      partitions: { kind: "served", partitions: [partition(7)] },
      onClearSiteData: servingAct(callLog, "clear"),
    });
    const confirm = [...page.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Clear this session"),
    );
    confirm?.click();
    await waitFor(() => {
      expect(callLog).toStrictEqual(["clear:session-07"]);
    });
  });

  it("offers no confirm where no writer is registered, and says why", () => {
    const page = renderPage({ partitions: { kind: "served", partitions: [partition(1)] } });
    expect(page.querySelectorAll("button")).toHaveLength(0);
    expect(page.textContent).toContain("No writer registered");
  });

  it("still offers the clear while a pane holds the partition open, beside the chip", () => {
    // 13.16 puts a clear on EVERY partition and makes it close the pane first, so an
    // open pane is the case the control exists for. A page that showed only the chip
    // here would state a condition and offer no way out of it.
    const page = renderPage({
      partitions: { kind: "served", partitions: [partition(1, { hasOpenPane: true })] },
      onClosePane: servingAct([], "close"),
      onClearSiteData: servingAct([], "clear"),
    });
    expect(page.textContent).toContain("A pane still has this partition open");
    expect(page.querySelector("details.meridian-browser-arm")).not.toBeNull();
    expect(page.textContent).toContain("closes that pane first");
  });

  it("negative control: the open-pane wording is the row's own, not every row's", () => {
    // Without this the case above would pass over a page that printed the close-first
    // sentence on partitions that have no pane open at all.
    const page = renderPage({
      partitions: { kind: "served", partitions: [partition(1)] },
      onClosePane: servingAct([], "close"),
      onClearSiteData: servingAct([], "clear"),
    });
    expect(page.textContent).not.toContain("A pane still has this partition open");
    expect(page.textContent).not.toContain("closes that pane first");
  });

  it("renders a clear that failed on its own row", () => {
    const page = renderPage({
      partitions: {
        kind: "served",
        partitions: [
          partition(1, {
            lastClearRefusal: refuse(
              "browser",
              "browser.partition_locked",
              "The profile directory is still held open.",
            ),
          }),
        ],
      },
      onClearSiteData: servingAct([], "clear"),
    });
    expect(page.textContent).toContain("browser.partition_locked");
    expect(page.querySelector(".meridian-refusal--banner")).toBeNull();
  });
});
