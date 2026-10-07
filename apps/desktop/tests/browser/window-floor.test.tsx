// The window's floor and the frame's three tracks, measured in Chromium, since happy-dom has no
// layout. The floor the frame reports is recomputed from its parts when the text size changes, its
// root-relative parts growing and the pane term holding in px, and a window held at that floor
// gives the rail, the open sessions track and a column as wide as the conversation's floor and one
// pane, measured as laid out, with nothing scrolling sideways; one rem narrower, the column no
// longer holds them. A closed track takes no width, where an open one does. At the floor the agent
// library keeps its two columns and an entity record keeps each label beside its value on one
// line, a long value truncated with its whole text as its title, with nothing overflowing or
// overlapping; a box planted too wide, one planted over a row, a short value that is not cut, and
// a record narrower than its label column are the negative controls.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  AgentLibraryOverStub,
  RegistryStub,
  definition,
} from "#renderer/features/agents/library/AgentLibrary.test-support.js";
import { EntityRecord } from "#renderer/features/inspector/entity-detail/components/EntityRecord.js";
import { wireFacet } from "#renderer/features/inspector/entity-detail/facets.js";
import { PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX } from "#renderer/features/sessions/pane-layout/measures.js";
import { AppFrame } from "#renderer/layout/AppShell/AppFrame.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import type { WindowSize } from "#shared/window/size.js";
import { SESSIONS_ROUTE, frameProps, liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { renderSettled } from "../helpers/app/harness.js";
import { describeHorizontalOverflow } from "../helpers/horizontal-overflow.js";

const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

/** The tier's own window, restored after each case so the next file starts at it. */
const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** A wire value with no break opportunity in it, longer than any record is wide. */
const UNBREAKABLE_WIRE_VALUE = "f".repeat(96);

/** Mounts the frame with tokens installed and `screen` in it, recording every floor it reports. */
async function renderFrame(
  sessionsTrack?: React.ReactNode,
  screen: React.ReactNode = <p>the screen</p>,
): Promise<readonly WindowSize[]> {
  installMeridianTokens(document);
  const floors: WindowSize[] = [];
  const BridgeHost = liveBridgeWrapper();
  await renderSettled(
    <BridgeHost>
      <AppFrame
        {...frameProps(SESSIONS_ROUTE)}
        onWindowFloorChange={(floor) => {
          floors.push(floor);
        }}
        {...(sessionsTrack === undefined ? {} : { sessionsTrack })}
      >
        {screen}
      </AppFrame>
    </BridgeHost>,
  );
  await expect.poll(() => floors.length).toBe(1);
  return floors;
}

/** Mounts the frame with its sessions track open and `screen` in it, held at the window's floor. */
async function renderAtWindowFloor(screen: React.ReactNode): Promise<void> {
  const [floor] = await renderFrame(<p>sessions</p>, screen);
  if (floor === undefined) {
    throw new Error("the frame reported no floor");
  }
  // Main rounds the floor up to whole pixels before it holds the window there.
  await resizeViewport(Math.ceil(floor.width), Math.ceil(floor.height));
}

/** Sizes the page's viewport and confirms it took, so no case measures the tier's default. */
async function resizeViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  expect({ width: window.innerWidth, height: window.innerHeight }).toStrictEqual({ width, height });
}

/**
 * One line per pair of sibling boxes under `root` that overlap, laid out in flow. A box taken
 * out of flow (a visually hidden label, a pop-up) is placed over others on purpose.
 */
function describeOverlappingSiblings(root: Element): string[] {
  const overlapping: string[] = [];
  for (const parent of [root, ...root.querySelectorAll("*")]) {
    const boxes = Array.from(parent.children)
      .filter(isLaidOutInFlow)
      .map((child) => ({ child, box: child.getBoundingClientRect() }));
    boxes.forEach((first, index) => {
      for (const second of boxes.slice(index + 1)) {
        const inline =
          Math.min(first.box.right, second.box.right) - Math.max(first.box.left, second.box.left);
        const block =
          Math.min(first.box.bottom, second.box.bottom) - Math.max(first.box.top, second.box.top);
        if (inline > 0.5 && block > 0.5) {
          overlapping.push(
            `${describeElement(first.child)} overlaps ${describeElement(second.child)}`,
          );
        }
      }
    });
  }
  return overlapping;
}

function isLaidOutInFlow(element: Element): boolean {
  const box = element.getBoundingClientRect();
  const position = getComputedStyle(element).position;
  return box.width > 0 && box.height > 0 && (position === "static" || position === "relative");
}

function describeElement(element: Element): string {
  return `${element.localName}${Array.from(element.classList, (name) => `.${name}`).join("")}`;
}

function elementOf<TElement extends Element>(root: ParentNode, selector: string): TElement {
  const element = root.querySelector<TElement>(selector);
  if (element === null) {
    throw new Error(`nothing matched ${selector}`);
  }
  return element;
}

/** How wide `inlineSize` lays out inside `parent`, in CSS px, read off a box sized by it. */
function laidOutWidth(parent: Element, inlineSize: string): number {
  const box = document.createElement("div");
  box.style.inlineSize = inlineSize;
  parent.append(box);
  const width = box.getBoundingClientRect().width;
  box.remove();
  return width;
}

function boxOf(selector: string): DOMRect {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`the frame rendered no ${selector}`);
  }
  return element.getBoundingClientRect();
}

function screenRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(".meridian-frame__screen");
  if (region === null) {
    throw new Error("the frame rendered no screen region");
  }
  return region;
}

beforeEach(async () => {
  await resizeViewport(tierViewport.width, tierViewport.height);
});

afterEach(async () => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  await page.viewport(tierViewport.width, tierViewport.height);
});

describe("the window floor", () => {
  it("is reported again when the text size changes, its pane term holding in px", async () => {
    const floors = await renderFrame();
    applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });

    await expect.poll(() => floors.length).toBe(2);
    const [atDefault, atLargest] = floors;
    const growth = LARGEST_TEXT_SIZE / DEFAULT_APPEARANCE_RECORD.textSize;
    // Headless Chromium has no title-bar inset, so every part but the pane term is root-relative.
    const paneTerm = PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX;
    expect((atLargest?.width ?? 0) - paneTerm).toBeCloseTo(
      ((atDefault?.width ?? 0) - paneTerm) * growth,
      3,
    );
    expect(atLargest?.height).toBeCloseTo((atDefault?.height ?? 0) * growth, 3);
  });

  it("holds the rail, the open sessions track, the conversation and one pane side by side", async () => {
    const [floor] = await renderFrame(<p>sessions</p>);
    if (floor === undefined) {
      throw new Error("the frame reported no floor");
    }
    await resizeViewport(Math.ceil(floor.width), Math.ceil(floor.height));

    const rail = boxOf(".meridian-rail");
    const sessionsTrack = boxOf(".meridian-frame__sessions-track");
    const column = boxOf(".meridian-frame__column");
    expect(rail.right).toBeLessThanOrEqual(sessionsTrack.left);
    expect(sessionsTrack.right).toBeLessThanOrEqual(column.left);
    expect(column.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rail.width + sessionsTrack.width + column.width).toBeCloseTo(window.innerWidth, 0);
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    // The pane term is read where the frame set it, on the floor box.
    const sessionView =
      laidOutWidth(screenRegion(), "var(--meridian-conversation-floor)") +
      laidOutWidth(
        elementOf(document, ".meridian-frame__window-floor"),
        "var(--meridian-frame-minimum-pane-width)",
      );
    expect(column.width).toBeGreaterThanOrEqual(sessionView);
    // Main rounds the floor up to whole pixels, so the column holds them with under one to spare.
    expect(column.width - sessionView).toBeLessThan(1);

    // Negative control: one rem narrower, the column no longer holds the conversation and a pane.
    await resizeViewport(
      Math.ceil(floor.width) - DEFAULT_APPEARANCE_RECORD.textSize,
      Math.ceil(floor.height),
    );
    expect(boxOf(".meridian-frame__column").width).toBeLessThan(sessionView);
  });

  it("gives the sessions track no width while it is closed", async () => {
    await renderFrame();

    expect(document.querySelector(".meridian-frame__sessions-track")).toBeNull();
    const column = boxOf(".meridian-frame__column");
    expect(column.left).toBe(boxOf(".meridian-rail").right);
    expect(column.right).toBe(window.innerWidth);

    // Negative control: with the track open, the column starts past the rail.
    cleanup();
    await renderFrame(<p>sessions</p>);
    expect(boxOf(".meridian-frame__column").left).toBeGreaterThan(boxOf(".meridian-rail").right);
  });
});

describe("at the window floor", () => {
  it("keeps the agent library's two columns with nothing overflowing or overlapping", async () => {
    const stub = new RegistryStub({
      lists: [
        [
          definition(),
          definition({
            definitionId: "definition-2",
            name: "A reviewer whose name runs long enough to wrap",
            description: "Reads every diff twice, " + "and says so at length. ".repeat(8),
          }),
        ],
      ],
    });
    await renderAtWindowFloor(<AgentLibraryOverStub stub={stub} />);
    await stub.settle();

    const library = elementOf<HTMLElement>(document, ".meridian-agent-library");
    expect(library.querySelectorAll(".meridian-agent-library__rows > li")).toHaveLength(2);
    // The saved column takes its two fifths, not the whole width a single column would.
    const columns = elementOf<HTMLElement>(library, ".meridian-agent-library__columns");
    const savedColumn = elementOf<HTMLElement>(columns, ".meridian-agent-library__column");
    expect(savedColumn.getBoundingClientRect().width).toBeLessThan(
      columns.getBoundingClientRect().width / 2,
    );
    expect(describeHorizontalOverflow(library)).toStrictEqual([]);
    expect(describeOverlappingSiblings(library)).toStrictEqual([]);

    // Negative controls: a box wider than the view, and one pulled up over the rows.
    const tooWide = document.createElement("div");
    tooWide.className = "too-wide";
    tooWide.style.cssText = "inline-size: 60rem; block-size: 1rem";
    const overRows = document.createElement("div");
    overRows.className = "over-rows";
    overRows.style.cssText = "block-size: 2rem; margin-block-start: -3rem";
    savedColumn.append(tooWide, overRows);
    expect(describeHorizontalOverflow(library)).toContainEqual(
      expect.stringContaining("section.meridian-agent-library__column overflows"),
    );
    expect(describeOverlappingSiblings(library)).toContainEqual(
      "ul.meridian-agent-library__rows overlaps div.over-rows",
    );
  });

  it("sets each entity record label beside its value on one line at the inspector's width", async () => {
    const record = (width: string): React.JSX.Element => (
      <div className="record-box" style={{ inlineSize: width }}>
        <EntityRecord
          glyph="workspace"
          heading="Workspace"
          entityId={UNBREAKABLE_WIRE_VALUE}
          state="ready"
          isInitialized
          hasRecord
          degradedCause={undefined}
          degradedConsequence="the state below may be stale."
          absentTitle="No workspace."
          absentDetail="None is attached."
          facets={[
            wireFacet("Repo mount", "repo-mount-1", "repo mount"),
            wireFacet("Workspace", UNBREAKABLE_WIRE_VALUE, "workspace"),
          ]}
          linkedSourcePaneId={undefined}
        />
      </div>
    );
    await renderAtWindowFloor(record("var(--meridian-inspector-width)"));

    const box = elementOf<HTMLElement>(document, ".record-box");
    const facets = Array.from(box.querySelectorAll(".meridian-entity-record__facet"));
    expect(facets).toHaveLength(2);
    const values = facets.map((facet) => {
      const label = elementOf(facet, ".meridian-entity-record__label").getBoundingClientRect();
      const value = elementOf<HTMLElement>(facet, ".meridian-entity-record__value");
      const valueBox = value.getBoundingClientRect();
      expect(label.right).toBeLessThanOrEqual(valueBox.left);
      expect(valueBox.top).toBeLessThan(label.bottom);
      return value;
    });
    // The long value is cut to one line as tall as the short one's, and titled with all of it;
    // the short one is the negative control, laid out whole.
    const [shortValue, longValue] = values;
    expect(longValue?.scrollWidth).toBeGreaterThan(longValue?.clientWidth ?? 0);
    expect(longValue?.getBoundingClientRect().height).toBe(
      shortValue?.getBoundingClientRect().height,
    );
    expect(longValue?.title).toBe(UNBREAKABLE_WIRE_VALUE);
    expect(shortValue?.scrollWidth).toBe(shortValue?.clientWidth);
    expect(shortValue?.title).toBe("repo-mount-1");
    // The head's identifier is cut the same way and titled with itself.
    const identifier = elementOf<HTMLElement>(
      box,
      ".meridian-entity-record__head .meridian-figure--wire",
    );
    expect(identifier.scrollWidth).toBeGreaterThan(identifier.clientWidth);
    expect(identifier.title).toBe(UNBREAKABLE_WIRE_VALUE);
    expect(describeHorizontalOverflow(box)).toStrictEqual([]);
    expect(describeOverlappingSiblings(box)).toStrictEqual([]);

    // Negative control: a record narrower than its label column cannot hold its facets.
    box.style.inlineSize = "8rem";
    expect(describeHorizontalOverflow(box)).toContainEqual(
      expect.stringContaining("dl.meridian-entity-record__facets overflows"),
    );
  });
});
