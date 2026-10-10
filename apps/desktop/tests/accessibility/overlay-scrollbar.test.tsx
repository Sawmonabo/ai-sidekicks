// The accessibility tier over scrollers with their overlay bars started and showing: the library
// appends its bars inside the scroller, so a bar inside a list would be a child the list may not
// hold. A pointer move over each scroller starts a bar that waits for one and shows it before axe
// runs. Review's file list and a payload hold their lists inside their scrollers; the negative
// control is a list that is itself the scroller, which axe must report.
//
// Every scroller that is a tab stop of its own is a group named for what it holds: a diff, two of
// them with one name as two cards in a conversation show them, a
// step's payload rows, a payload's text and the command palette's matches. None is a landmark,
// which would fill the landmark list with one entry per card, and no bar sits inside the table or
// listbox a scroller holds.

import { act, cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import { buildDiffFixture } from "#test/helpers/diff/fixture/model.js";
import { SMALL_DIFF_SHAPE } from "#test/helpers/diff/fixture/shapes.js";
import { renderSettled } from "#test/helpers/app/harness.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { ArtifactPayloadSection } from "#renderer/features/repos/artifacts/components/ArtifactPayloadSection.js";
import { DiffFileList } from "#renderer/features/repos/diff/components/DiffFileList.js";
import { DiffRenderer } from "#renderer/features/repos/diff/components/DiffRenderer.js";
import { diffRendererProps } from "#renderer/features/repos/diff/components/DiffRenderer.test-support.js";
import { DIFF_FILE_LIST_SCROLL_THRESHOLD } from "#renderer/features/repos/diff/caps.js";
import {
  installOverlayScrollbarLibrary,
  waitForOverlayScrollbarLibrary,
} from "#renderer/lib/overlay-scrollbar-library.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { scenarioBridgeAndStore } from "./feature-mounts/repos/fixtures.js";
import { mountDiffPane } from "./feature-mounts/repos/views.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { CommandPalette } from "#renderer/layout/CommandPalette/CommandPalette.js";
import { CommandRegistry } from "#renderer/registries/commands/registry.js";
import { PayloadRowWindow } from "#renderer/features/workflows/runs/page/step/components/StepPayload/PayloadRowWindow.js";
import { describeViolations, runTierAxe } from "./axe-run.js";

/** How long a bar may take to start and show: the library's load plus its window's idle time. */
const BAR_SHOWN_TIMEOUT_MS = 5000;

/** A vertical bar the library is showing, not one faded out or with nothing to scroll. */
const SHOWN_VERTICAL_BAR =
  ".os-scrollbar-vertical:not(.os-scrollbar-auto-hide-hidden):not(.os-scrollbar-unusable)";

/** More commands than the palette's list shows, so it scrolls. */
const PALETTE_COMMAND_COUNT = 120;

/** The one name two diff cards share when they show the same pair of refs. */
const DIFF_LABEL = "Diff, main to feat/rate-limit-wiring";

/** What a step's payload window is named for. */
const PAYLOAD_ROWS_LABEL = "Output of Summarize";

/** A role whose element holds only its own kind of child, so a bar may not sit inside it. */
const CONTAINER_ROLES_HOLDING_NO_BAR = '[role="table"], [role="listbox"], table';

afterEach(() => {
  cleanup();
});

/** Moves the pointer over each scroller until every one shows its bar, past its fade. */
async function showEveryBar(scrollers: readonly HTMLElement[]): Promise<void> {
  await act(async () => {
    await expect
      .poll(
        () =>
          scrollers.map((scroller) => {
            scroller.dispatchEvent(
              new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
            );
            const bar = scroller.querySelector(`:scope > ${SHOWN_VERTICAL_BAR}`);
            return bar !== null && getComputedStyle(bar).opacity === "1";
          }),
        { timeout: BAR_SHOWN_TIMEOUT_MS },
      )
      .toStrictEqual(scrollers.map(() => true));
  });
}

/**
 * Every bar under `root` that sits inside a table or a listbox, which may hold only their own
 * kind of child; throws when `root` holds no bar at all, so an empty answer means something.
 */
function barsInsideTableOrListbox(root: ParentNode): Element[] {
  const bars = Array.from(root.querySelectorAll(".os-scrollbar"));
  if (bars.length === 0) {
    throw new Error("no overlay bar was drawn here");
  }
  return bars.filter((bar) => bar.closest(CONTAINER_ROLES_HOLDING_NO_BAR) !== null);
}

describe("accessibility — the overlay scrollbar", () => {
  it("has no axe violation with the bars of a list and a payload showing", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    const { bridge, clock } = scenarioBridgeAndStore();
    // Past the threshold, so the file list scrolls and attaches its bar.
    const diff = buildDiffFixture({
      ...SMALL_DIFF_SHAPE,
      fileCount: DIFF_FILE_LIST_SCROLL_THRESHOLD * 3,
    });
    const { container } = await renderSettled(
      <PlatformBridgeProvider bridge={bridge} clock={clock}>
        {/* The pane's row holds the list to a height, as the diff pane does. */}
        <div style={{ display: "flex", blockSize: "12rem" }}>
          <DiffFileList
            diff={diff}
            selectedFilePath={undefined}
            onSelectFilePath={() => undefined}
          />
        </div>
        <ArtifactPayloadSection
          payload={{
            status: "text",
            artifactId: "artifact-overlay-scrollbar" as ArtifactId,
            encoding: "utf8",
            text: "a payload line\n".repeat(200),
          }}
        />
      </PlatformBridgeProvider>,
    );
    const scrollers = Array.from(
      container.querySelectorAll<HTMLElement>(
        ".meridian-diff-files__scroller, .meridian-artifact-payload__preview",
      ),
    );
    expect(scrollers).toHaveLength(2);
    await showEveryBar(scrollers);

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);

    // Negative control: a list that is itself the scroller holds the bars, which axe reports.
    const library = await waitForOverlayScrollbarLibrary(document);
    if (library === undefined) {
      throw new Error("this window loaded no overlay scrollbar library");
    }
    const listScroller = document.createElement("ul");
    listScroller.className = "list-scroller";
    listScroller.style.cssText = "overflow: auto; block-size: 4rem; margin: 0";
    listScroller.tabIndex = 0;
    listScroller.innerHTML = "<li>an item</li>".repeat(20);
    container.append(listScroller);
    // Called without options the library only looks an instance up; with them it starts one.
    const forced = library.OverlayScrollbars(
      { target: listScroller, elements: { viewport: listScroller } },
      {},
    );
    await showEveryBar([listScroller]);
    expect(describeViolations(await runTierAxe(container))).toStrictEqual([
      "list (serious): .list-scroller",
    ]);
    forced.destroy();
  });

  it("names every scroller that is a tab stop as a group, with no landmark and no bar in a table or listbox", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    const diffPane = await mountDiffPane();
    const BridgeHost = liveBridgeWrapper();
    const { container: conversation } = render(
      <BridgeHost>
        {/* Two cards over the same refs, each diff held to a height so its rows overflow. */}
        <DiffRenderer {...diffRendererProps({ label: DIFF_LABEL, heightCapPx: 120 })} />
        <DiffRenderer {...diffRendererProps({ label: DIFF_LABEL, heightCapPx: 120 })} />
        <PayloadRowWindow
          rowCount={200}
          label={PAYLOAD_ROWS_LABEL}
          className=""
          renderRow={(rowIndex) => <span>row {rowIndex}</span>}
        />
        <ArtifactPayloadSection
          payload={{
            status: "text",
            artifactId: "artifact-overlay-scrollbar" as ArtifactId,
            encoding: "utf8",
            text: "a payload line\n".repeat(200),
          }}
        />
      </BridgeHost>,
    );
    const paneDiff = diffPane.element.querySelector<HTMLElement>(".meridian-diff");
    if (paneDiff === null) {
      throw new Error("the diff pane drew no diff");
    }
    // The pane holds the diff to a height, so its rows overflow it.
    paneDiff.style.maxBlockSize = "8rem";
    const conversationScrollers = Array.from(
      conversation.querySelectorAll<HTMLElement>(
        ".meridian-diff, .meridian-workflow-payload__window, .meridian-artifact-payload__preview",
      ),
    );
    expect(conversationScrollers).toHaveLength(4);
    const [firstCard, secondCard, payloadRows, payloadText] = conversationScrollers;
    await showEveryBar([paneDiff, ...conversationScrollers]);
    expect(barsInsideTableOrListbox(document)).toStrictEqual([]);
    // Nothing here adds a landmark: two diff cards over the same refs would be two landmarks of
    // one name, which `landmark-unique` reports.
    for (const root of [diffPane.element, conversation]) {
      expect(describeViolations(await runTierAxe(root, ["landmark-unique"]))).toStrictEqual([]);
    }
    // Each scroller is the group a reader finds by its name, both computed as assistive
    // technology computes them. A table must carry a name, so each diff's keeps its scroller's.
    const groupsNamed = (name: string | RegExp, root: HTMLElement): HTMLElement[] =>
      within(root).getAllByRole("group", { name });
    expect(groupsNamed(/^Diff, \S+ to \S+$/u, diffPane.element)).toStrictEqual([paneDiff]);
    expect(groupsNamed(DIFF_LABEL, conversation)).toStrictEqual([firstCard, secondCard]);
    expect(within(conversation).getAllByRole("table", { name: DIFF_LABEL })).toHaveLength(2);
    expect(groupsNamed(PAYLOAD_ROWS_LABEL, conversation)).toStrictEqual([payloadRows]);
    expect(groupsNamed("Payload text", conversation)).toStrictEqual([payloadText]);

    // The palette opens last: it is modal, so the rest of the page is hidden from a reader.
    const registry = new CommandRegistry();
    registry.registerAll(
      Array.from({ length: PALETTE_COMMAND_COUNT }, (_unused, ordinal) => ({
        id: `test.command.${String(ordinal)}`,
        title: `A command ${String(ordinal).padStart(3, "0")}`,
        group: "Commands",
        run: () => undefined,
      })),
    );
    await renderSettled(
      <BridgeHost>
        <CommandPalette
          registry={registry}
          context={{
            sessionActive: false,
            onSessions: true,
            onSession: false,
            onWorkflows: false,
            onSettings: false,
            transcriptHoldsRunGroup: false,
          }}
          open
          onOpenChange={() => undefined}
          platform="darwin"
        />
      </BridgeHost>,
    );
    const paletteList = document.querySelector<HTMLElement>(".command-palette__list");
    const palettePopup = paletteList?.closest<HTMLElement>(".command-palette__popup");
    if (paletteList === null || palettePopup === null || palettePopup === undefined) {
      throw new Error("the palette drew no list");
    }
    await showEveryBar([paletteList]);
    expect(barsInsideTableOrListbox(palettePopup)).toStrictEqual([]);
    expect(describeViolations(await runTierAxe(palettePopup, ["landmark-unique"]))).toStrictEqual(
      [],
    );
    expect(groupsNamed("Matching commands", palettePopup)).toStrictEqual([paletteList]);
    expect(within(paletteList).getAllByRole("listbox", { name: "Matching commands" })).toHaveLength(
      1,
    );
  });
});
