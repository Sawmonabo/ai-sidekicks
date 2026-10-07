// A step payload by its type: the Table view draws a markdown string as formatted text and a
// binary field as the file it names, the JSON view keeps both exactly as stored, and either view
// draws only the rows in view, however many items the payload holds.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorkflowItemSchema,
  type WorkflowItem,
} from "@ai-sidekicks/contracts/workflow/definition/document";

import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { ElementHeightShim } from "#test/helpers/element/height-shim.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { StepPayload, type StepPayloadView } from "./StepPayload.js";

const SUMMARY =
  "# Findings\n\n- the cache is unbounded[^cap]\n- rename `readFrozenRecord`\n\n" +
  "[^cap]: Measured at 2 GB after a day.";

const NOTES_TEXT = "Ran the suite.\nTwo cases skipped.";

const ITEMS = [
  WorkflowItemSchema.parse({
    json: {
      summary: SUMMARY,
      path: "src/__init__.py",
      status: "**Build passed**",
      notes: NOTES_TEXT,
    },
    binary: {
      data: {
        artifactId: "0190f5c2-7d3e-7a10-9b2c-3d4e5f60718a",
        mimeType: "text/plain",
        fileName: "build-17.log",
        size: 14_336,
      },
    },
    pairedItem: { item: 2 },
  }),
];

const LABEL = "Output of Summarize";

// The DOM shim lays nothing out, so the payload's scroll box and its rows say how tall a browser
// would draw them; a zero-height box would correctly draw no rows at all.
const heights = new ElementHeightShim();

beforeEach(() => {
  heights.install((element) =>
    element.classList.contains("meridian-workflow-payload__window")
      ? SCROLL_BOX_HEIGHT_PX
      : element.hasAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)
        ? ROW_HEIGHT_PX
        : 0,
  );
});

afterEach(() => {
  heights.restore();
});

const SCROLL_BOX_HEIGHT_PX = 480;
const ROW_HEIGHT_PX = 24;

function renderPayload(view: StepPayloadView, items: WorkflowItem[] = ITEMS): HTMLElement {
  render(
    <LiveAnnouncerProvider>
      <StepPayload items={items} storage={{ kind: "inline" }} view={view} label={LABEL} />
    </LiveAnnouncerProvider>,
    { wrapper: liveBridgeWrapper() },
  );
  return screen.getByRole("group", { name: LABEL });
}

describe("a step payload in the Table view", () => {
  it("draws a markdown string as formatted text, with its heading, list and inline code", () => {
    const container = renderPayload("table");

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Findings");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toStrictEqual([
      "the cache is unboundedcap",
      "rename readFrozenRecord",
    ]);
    expect(screen.getByText("readFrozenRecord").tagName).toBe("CODE");
    // A document drawn outside the transcript keeps its own footnote's text, at its foot.
    expect(screen.getByLabelText("Footnote cap").getAttribute("data-defined")).toBe("true");
    expect(screen.getByText("Measured at 2 GB after a day.")).toBeTruthy();
    expect(container.textContent).not.toContain("# Findings");
  });

  it("reads a string with spaces as markdown, and a single token exactly as stored", () => {
    const container = renderPayload("table");

    // One line of markdown is still markdown.
    expect(screen.getByText("Build passed").tagName).toBe("STRONG");
    // A path is one token, so `__init__` is never read as emphasis.
    expect(screen.getByText("src/__init__.py").tagName).toBe("SPAN");
    expect(container.querySelectorAll("strong")).toHaveLength(1);
  });

  it("draws text that holds no markdown as stored, its line breaks kept", () => {
    const container = renderPayload("table");

    const values = [...container.querySelectorAll(".meridian-workflow-payload__value")];
    expect(values.map((value) => value.textContent)).toContain(NOTES_TEXT);
  });

  it("draws a binary field as the file it names, and the input item it came from", () => {
    const container = renderPayload("table");

    expect(container.textContent).toContain(
      `build-17.log · text/plain · ${formatByteQuantity(14_336).text}`,
    );
    expect(container.textContent).not.toContain("0190f5c2-7d3e-7a10-9b2c-3d4e5f60718a");
    expect(container.textContent).toContain("Item 0 · from item 2");
  });
});

describe("a step payload in the JSON view", () => {
  it("keeps the markdown string and the binary reference exactly as stored", () => {
    const container = renderPayload("json");

    expect(container.textContent).toBe(JSON.stringify(ITEMS, null, 2));
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.textContent).toContain("0190f5c2-7d3e-7a10-9b2c-3d4e5f60718a");
  });
});

describe("a payload of many items", () => {
  const manyItems = Array.from({ length: 500 }, (_, index) => ({ json: { index } }));

  it.each(["table", "json"] as const)("draws only the rows in view in the %s view", (view) => {
    const region = renderPayload(view, manyItems);

    const drawnRows = region.querySelectorAll(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`).length;
    expect(drawnRows).toBeGreaterThan(0);
    expect(drawnRows).toBeLessThan(50);
  });
});
