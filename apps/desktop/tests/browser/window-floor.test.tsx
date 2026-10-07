// The window's floor and the frame's three tracks, measured in Chromium, since happy-dom has no
// layout. The floor the frame reports is recomputed from its parts when the text size changes, its
// root-relative parts growing and the pane term holding in px, and a window held at that floor
// gives the rail, the open sessions track and the real pane layout, the conversation at its own
// floor and one pane past the separator at the loosest pane floor, with nothing scrolling
// sideways; one rem narrower, that pane falls under its floor. A closed track takes no width,
// where an open one does. At the floor the agent library keeps its two columns and an entity
// record keeps each label beside its value on one line, a long value truncated with its whole text
// as its title, with nothing overflowing or overlapping; a box planted too wide, one planted over
// a row, a short value that is not cut, and a record narrower than its label column are the
// negative controls. The whole app held at its floor keeps the conversation in view above the
// composer with its command list open; a window shorter by the conversation's height leaves none.

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
import { PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX } from "#renderer/features/sessions/pane-layout/measures.js";
import type { SessionPane } from "#renderer/features/sessions/pane-layout/state.js";
import {
  PANE_LAYOUT_RESTORED_PANE_CAP,
  PaneLayoutStore,
} from "#renderer/features/sessions/pane-layout/store.js";
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

const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

/** The tier's own window, restored after each case so the next file starts at it. */
const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** A wire value with no break opportunity in it, longer than any record is wide. */
const UNBREAKABLE_WIRE_VALUE = "f".repeat(96);

/** The conversation's scroller, the box the transcript's rows scroll in. */
const CONVERSATION_SCROLLER = ".meridian-transcript-viewport__scroll-container";

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

/** Waits for the app's window to draw `selector`, inside act, and returns what it drew. */
async function untilDrawn(appWindow: Window, selector: string): Promise<HTMLElement> {
  await untilInsideAct(() =>
    expect.poll(() => appWindow.document.querySelector(selector)).not.toBeNull(),
  );
  return elementOf<HTMLElement>(appWindow.document, selector);
}

/** A pane registry whose transcript and terminal bodies are framed panes, as the app's are. */
function framedPaneRegistry(): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of ["transcript", "terminal"] as const) {
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
    const conversationFloorPx = laidOutWidth(screenRegion(), "var(--meridian-conversation-floor)");
    const separatorPx = laidOutWidth(screenRegion(), "var(--meridian-pane-separator-width)");
    const columnPx = boxOf(".meridian-frame__column").width;
    cleanup();

    // The real pane layout in the frame at its floor: the conversation and one pane, the
    // conversation held at its own floor, so the pane gets whatever the floor left it.
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    const conversationPaneId = layout.open({ kind: "transcript" });
    const paneId = layout.open({ kind: "terminal" });
    const conversationPercent = (conversationFloorPx / (columnPx - separatorPx)) * 100;
    layout.applyLayout(
      { [conversationPaneId]: conversationPercent, [paneId]: 100 - conversationPercent },
      0,
    );
    await renderFrame(
      <p>sessions</p>,
      <LiveAnnouncerProvider>
        <SessionPaneLayout
          layout={layout}
          registry={framedPaneRegistry()}
          paneContextFor={framedPaneContext}
        />
      </LiveAnnouncerProvider>,
    );

    const rail = boxOf(".meridian-rail");
    const sessionsTrack = boxOf(".meridian-frame__sessions-track");
    const column = boxOf(".meridian-frame__column");
    expect(rail.right).toBeLessThanOrEqual(sessionsTrack.left);
    expect(sessionsTrack.right).toBeLessThanOrEqual(column.left);
    expect(column.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rail.width + sessionsTrack.width + column.width).toBeCloseTo(window.innerWidth, 0);
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    const conversationPane = boxOf(".meridian-pane--transcript");
    const pane = boxOf(".meridian-pane--terminal");
    expect(conversationPane.width).toBeCloseTo(conversationFloorPx, 0);
    expect(pane.left).toBeGreaterThanOrEqual(conversationPane.right + separatorPx - 0.5);
    expect(pane.right).toBeLessThanOrEqual(column.right + 0.5);
    expect(pane.width).toBeGreaterThanOrEqual(PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX);
    // Main rounds the floor up to whole pixels, so the pane holds its floor with under one to
    // spare.
    expect(pane.width - PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX).toBeLessThan(1);

    // Negative control: one rem narrower, the conversation at its floor leaves the pane short.
    // Inside act, since the pane layout sets its state when the window resizes.
    await act(async () => {
      await resizeViewport(
        Math.ceil(floor.width) - DEFAULT_APPEARANCE_RECORD.textSize,
        Math.ceil(floor.height),
      );
    });
    await waitFor(() => {
      expect(boxOf(".meridian-pane--terminal").width).toBeLessThan(
        PANE_LAYOUT_LOOSEST_MINIMUM_PANE_WIDTH_PX,
      );
    });
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

  it("keeps the conversation in view above the composer with its command list open", async () => {
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
    await untilDrawn(appWindow, ".meridian-command-discovery__scroller");

    const conversation = elementOf<HTMLElement>(appWindow.document, CONVERSATION_SCROLLER);
    const composer = elementOf<HTMLElement>(
      appWindow.document,
      ".meridian-session-screen__composer",
    );
    const conversationHeight = conversation.getBoundingClientRect().height;
    expect(conversationHeight).toBeGreaterThan(0);
    expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(appWindow.innerHeight);

    // Negative control: a window shorter by the conversation's height leaves it none.
    await act(async () => {
      await resizeViewport(
        Math.ceil(floor.width),
        Math.ceil(floor.height) - Math.ceil(conversationHeight),
      );
    });
    await waitFor(() => {
      expect(conversation.getBoundingClientRect().height).toBe(0);
    });
  });
});
