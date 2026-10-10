// The window's floor and the frame's three tracks, measured in Chromium, since happy-dom has no
// layout. The floor the frame reports is recomputed from its parts when the text size changes,
// every part growing with it, and a window held at that floor gives the rail, the open sessions
// track and the real pane layout, the conversation at its own floor and the pane with the widest
// floor beside it, with nothing scrolling sideways. More panes than fit, or a window one rem
// narrower, scroll the block sideways rather than draw the conversation or a pane under its
// floor. A closed track takes no width, where an open one does. At the floor the agent library
// keeps its two columns and an entity record keeps each label beside its value on one line, a
// long value truncated with its whole text as its hover label, with nothing overflowing or
// overlapping; a box planted too wide, one planted over a row, a short value that is not cut, and
// a record narrower than its label column are the negative controls. The whole app held at its
// floor keeps the conversation in view above the composer with its command list open; on a
// screen shorter than the floor the conversation keeps its own height floor, and the list gives
// way and scrolls in what is left.

import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO_ID,
} from "#fixtures/scenarios/transcript-states.js";
import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  AgentLibraryOverStub,
  RegistryStub,
  definition,
} from "#renderer/features/agents/library/AgentLibrary.test-support.js";
import { EntityRecord } from "#renderer/features/inspector/entity-detail/components/EntityRecord.js";
import { wireFacet } from "#renderer/features/inspector/entity-detail/facets.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { SessionPaneLayout } from "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import type { SessionPane } from "#renderer/features/sessions/pane-layout/state.js";
import { PaneLayoutStore } from "#renderer/features/sessions/pane-layout/store.js";
import { PANE_WIDTH_RULE_BY_KIND } from "#renderer/features/sessions/pane-layout/widths.js";
import type { BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { AppFrame } from "#renderer/layout/AppShell/AppFrame.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import type { WindowSize } from "#shared/window/size.js";
import { SESSIONS_ROUTE, frameProps, liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { renderAppSettled, renderSettled } from "../helpers/app/harness.js";
import { describeHorizontalOverflow } from "../helpers/horizontal-overflow.js";
import { untilInsideAct } from "../helpers/settle.js";
import { HOVER_LABEL_TEXT_ATTRIBUTE } from "#renderer/components/HoverLabel/HoverLabel.js";

const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

/** The tier's own window, restored after each case so the next file starts at it. */
const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** A wire value with no break opportunity in it, longer than any record is wide. */
const UNBREAKABLE_WIRE_VALUE = "f".repeat(96);

/** The conversation's scroller, the box the transcript's rows scroll in. */
const CONVERSATION_SCROLLER = ".meridian-transcript-viewport__scroll-container";

/** A usable height under the window's floor at every text size, as a short display gives. */
const SHORT_SCREEN_HEIGHT_PX = 560;

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
  // Through Testing Library's wait, so a layout the frame holds may settle its state meanwhile.
  await waitFor(() => {
    expect(floors).toHaveLength(1);
  });
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

/** How long `size` lays out inside `parent` along `axis`, in CSS px, read off a box sized by it. */
function laidOutSize(parent: Element, axis: "inlineSize" | "blockSize", size: string): number {
  const box = parent.ownerDocument.createElement("div");
  box.style[axis] = size;
  parent.append(box);
  const { width, height } = box.getBoundingClientRect();
  box.remove();
  return axis === "inlineSize" ? width : height;
}

function boxOf(selector: string): DOMRect {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`the frame rendered no ${selector}`);
  }
  return element.getBoundingClientRect();
}

/** A pane's box: its slot in the block, the one-pixel line beside its frame included. */
function paneBoxOf(kind: BlockPaneKind): DOMRect {
  const slot = elementOf<HTMLElement>(document, `.meridian-pane--${kind}`).closest(
    ".meridian-pane-layout__pane",
  );
  if (slot === null) {
    throw new Error(`the ${kind} pane drew outside a pane slot`);
  }
  return slot.getBoundingClientRect();
}

/** Waits for the app's window to draw `selector`, inside act, and returns what it drew. */
async function untilDrawn(appWindow: Window, selector: string): Promise<HTMLElement> {
  await untilInsideAct(() =>
    expect.poll(() => appWindow.document.querySelector(selector)).not.toBeNull(),
  );
  return elementOf<HTMLElement>(appWindow.document, selector);
}

/** A pane registry whose bodies are framed panes, as the app's are. */
function framedPaneRegistry(): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of ["agents", "browser", "terminal"] as const) {
    registry.register({
      kind,
      owner: "window-floor-test",
      render: () => (
        <PaneFrame kind={kind} sessionId="session-window-floor">
          <p>{kind} body</p>
        </PaneFrame>
      ),
    });
  }
  return registry;
}

/**
 * The pane context, cast: the bodies above read nothing from it, so filling the stores a real
 * body reads would make the setup the subject.
 */
function framedPaneContext(pane: SessionPane): PaneContext {
  return { kind: pane.kind, entity: pane.entity, paneId: pane.paneId } as unknown as PaneContext;
}

function screenRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(".meridian-frame__screen");
  if (region === null) {
    throw new Error("the frame rendered no screen region");
  }
  return region;
}

/** Mounts the real pane layout in the frame, its sessions track open, beside a conversation. */
async function renderPaneLayoutInFrame(layout: PaneLayoutStore): Promise<void> {
  await renderFrame(
    <p>sessions</p>,
    <LiveAnnouncerProvider>
      <SessionPaneLayout
        layout={layout}
        registry={framedPaneRegistry()}
        paneContextFor={framedPaneContext}
        isSessionOpen
        sessionId={undefined}
        conversation={<p>the conversation</p>}
      />
    </LiveAnnouncerProvider>,
  );
}

function conversationFloorPx(): number {
  return laidOutSize(screenRegion(), "inlineSize", "var(--meridian-conversation-floor)");
}

function paneFloorPx(kind: BlockPaneKind): number {
  const floorRem = PANE_WIDTH_RULE_BY_KIND[kind].floorRem;
  return laidOutSize(screenRegion(), "inlineSize", `${String(floorRem)}rem`);
}

/** Whether the block of panes scrolls sideways or holds still. */
function describeBlockScroll(): "scrolls" | "still" {
  const block = elementOf<HTMLElement>(document, ".meridian-pane-layout__block");
  return block.scrollWidth > block.clientWidth ? "scrolls" : "still";
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
  it("is reported again when the text size changes, every part growing with it", async () => {
    const floors = await renderFrame();
    applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });

    await expect.poll(() => floors.length).toBe(2);
    const [atDefault, atLargest] = floors;
    const growth = LARGEST_TEXT_SIZE / DEFAULT_APPEARANCE_RECORD.textSize;
    // Headless Chromium has no title-bar inset, so every part is root-relative.
    expect(atLargest?.width).toBeCloseTo((atDefault?.width ?? 0) * growth, 3);
    expect(atLargest?.height).toBeCloseTo((atDefault?.height ?? 0) * growth, 3);
  });

  it("holds the rail, the open sessions track, the conversation and one pane side by side", async () => {
    const [floor] = await renderFrame(<p>sessions</p>);
    if (floor === undefined) {
      throw new Error("the frame reported no floor");
    }
    await resizeViewport(Math.ceil(floor.width), Math.ceil(floor.height));
    cleanup();

    // The real pane layout in the frame at its floor, holding the pane with the widest floor.
    const layout = new PaneLayoutStore();
    layout.open({ kind: "agents" });
    await renderPaneLayoutInFrame(layout);

    const rail = boxOf(".meridian-rail");
    const sessionsTrack = boxOf(".meridian-frame__sessions-track");
    const column = boxOf(".meridian-frame__column");
    expect(rail.right).toBeLessThanOrEqual(sessionsTrack.left);
    expect(sessionsTrack.right).toBeLessThanOrEqual(column.left);
    expect(column.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rail.width + sessionsTrack.width + column.width).toBeCloseTo(window.innerWidth, 0);
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    const conversation = boxOf(".meridian-pane-layout__conversation");
    const pane = paneBoxOf("agents");
    expect(conversation.width).toBeGreaterThanOrEqual(conversationFloorPx() - 0.5);
    // Main rounds the floor up to whole pixels, so the conversation holds its floor with under
    // one to spare.
    expect(conversation.width - conversationFloorPx()).toBeLessThan(1);
    expect(pane.left).toBeGreaterThanOrEqual(conversation.right - 0.5);
    expect(pane.right).toBeLessThanOrEqual(column.right + 0.5);
    expect(pane.width).toBeCloseTo(paneFloorPx("agents"), 0);
    expect(describeBlockScroll()).toBe("still");

    // One rem narrower, the block scrolls sideways and nothing goes under its floor.
    await act(async () => {
      await resizeViewport(
        Math.ceil(floor.width) - DEFAULT_APPEARANCE_RECORD.textSize,
        Math.ceil(floor.height),
      );
    });
    await waitFor(() => {
      expect(describeBlockScroll()).toBe("scrolls");
    });
    expect(boxOf(".meridian-pane-layout__conversation").width).toBeGreaterThanOrEqual(
      conversationFloorPx() - 0.5,
    );
    expect(paneBoxOf("agents").width).toBeCloseTo(paneFloorPx("agents"), 0);
  });

  it("scrolls more panes than fit rather than draw any of them under its floor", async () => {
    const [floor] = await renderFrame(<p>sessions</p>);
    if (floor === undefined) {
      throw new Error("the frame reported no floor");
    }
    await resizeViewport(Math.ceil(floor.width), Math.ceil(floor.height));
    cleanup();

    const layout = new PaneLayoutStore();
    layout.open({ kind: "agents" });
    layout.open({ kind: "browser" });
    layout.open({ kind: "terminal" });
    await renderPaneLayoutInFrame(layout);

    expect(describeBlockScroll()).toBe("scrolls");
    expect(boxOf(".meridian-pane-layout__conversation").width).toBeGreaterThanOrEqual(
      conversationFloorPx() - 0.5,
    );
    const kinds: readonly BlockPaneKind[] = ["agents", "browser"];
    for (const kind of kinds) {
      expect(paneBoxOf(kind).width).toBeGreaterThanOrEqual(paneFloorPx(kind) - 0.5);
    }
    // Stacked under the row, the terminal spans it.
    expect(paneBoxOf("terminal").width).toBeGreaterThanOrEqual(
      paneFloorPx("agents") + paneFloorPx("browser") - 0.5,
    );
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);

    // Negative control: a slot that lost its floor is squeezed under it, which the reading sees.
    const previewSlot = elementOf<HTMLElement>(
      document,
      ".meridian-pane--browser",
    ).closest<HTMLElement>(".meridian-pane-layout__pane");
    if (previewSlot === null) {
      throw new Error("Preview drew outside a pane slot");
    }
    previewSlot.style.minInlineSize = "0";
    previewSlot.style.inlineSize = "1rem";
    expect(paneBoxOf("browser").width).toBeLessThan(paneFloorPx("browser"));
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
    // The long value is cut to one line as tall as the short one's, and labeled with all of it;
    // the short one is the negative control, laid out whole.
    const [shortValue, longValue] = values;
    expect(longValue?.scrollWidth).toBeGreaterThan(longValue?.clientWidth ?? 0);
    expect(longValue?.getBoundingClientRect().height).toBe(
      shortValue?.getBoundingClientRect().height,
    );
    expect(longValue?.getAttribute(HOVER_LABEL_TEXT_ATTRIBUTE)).toBe(UNBREAKABLE_WIRE_VALUE);
    expect(shortValue?.scrollWidth).toBe(shortValue?.clientWidth);
    expect(shortValue?.getAttribute(HOVER_LABEL_TEXT_ATTRIBUTE)).toBe("repo-mount-1");
    // The head's identifier is cut the same way and labeled with itself.
    const identifier = elementOf<HTMLElement>(
      box,
      ".meridian-entity-record__head .meridian-figure--wire",
    );
    expect(identifier.scrollWidth).toBeGreaterThan(identifier.clientWidth);
    expect(identifier.getAttribute(HOVER_LABEL_TEXT_ATTRIBUTE)).toBe(UNBREAKABLE_WIRE_VALUE);
    expect(describeHorizontalOverflow(box)).toStrictEqual([]);
    expect(describeOverlappingSiblings(box)).toStrictEqual([]);

    // Negative control: a record narrower than its label column cannot hold its facets.
    box.style.inlineSize = "8rem";
    expect(describeHorizontalOverflow(box)).toContainEqual(
      expect.stringContaining("dl.meridian-entity-record__facets overflows"),
    );
  });

  it("keeps the conversation over the open command list, at the floor and under it", async () => {
    document.location.hash = formatRoute({ kind: "session", sessionId: SESSION_ID });
    const appWindow = await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID);
    const floor = (
      await untilDrawn(appWindow, ".meridian-frame__window-floor")
    ).getBoundingClientRect();
    // Main rounds the floor up to whole pixels before it holds the window there. Inside act,
    // since the frame and the pane layout set their state when the window resizes.
    await act(async () => {
      await resizeViewport(Math.ceil(floor.width), Math.ceil(floor.height));
    });
    (await untilDrawn(appWindow, ".meridian-composer textarea")).focus();
    await act(async () => {
      await userEvent.keyboard("/");
    });
    const list = await untilDrawn(appWindow, ".meridian-command-discovery__scroller");

    const conversation = elementOf<HTMLElement>(appWindow.document, CONVERSATION_SCROLLER);
    const paneRow = elementOf<HTMLElement>(
      appWindow.document,
      ".meridian-session-screen > .meridian-pane-layout",
    );
    const composer = elementOf<HTMLElement>(
      appWindow.document,
      ".meridian-session-screen__composer",
    );
    expect(conversation.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(appWindow.innerHeight);

    // A display shorter than the floor gives a window under it. The conversation keeps its own
    // height floor, and the list, shorter than its bound, scrolls in what is left.
    await act(async () => {
      await resizeViewport(Math.ceil(floor.width), SHORT_SCREEN_HEIGHT_PX);
    });
    // Read in the page's body, a block, where no flex row could shrink the measuring box.
    const { body } = appWindow.document;
    const heightFloorPx = laidOutSize(
      body,
      "blockSize",
      "var(--meridian-conversation-height-floor)",
    );
    const listBoundPx = laidOutSize(body, "blockSize", "var(--meridian-enumeration-max-height)");
    expect(paneRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(heightFloorPx - 0.5);
    expect(conversation.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(list.clientHeight).toBeLessThan(listBoundPx);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(appWindow.innerHeight);
  });
});
