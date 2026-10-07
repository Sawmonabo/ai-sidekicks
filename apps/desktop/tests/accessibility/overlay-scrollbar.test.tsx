// The accessibility tier over scrollers with their overlay bars started and showing: the library
// appends its bars inside the scroller, so a bar inside a list would be a child the list may not
// hold. A pointer move over each scroller starts a bar that waits for one and shows it before axe
// runs: Review's file list and a payload, then Review's diff and the command palette's list, each
// keeping its table or listbox inside its scroller, and each scroller reachable from the keyboard.
// The negative control is a list that is itself the scroller, which axe must report.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import { buildDiffFixture } from "#test/helpers/diff/fixture/model.js";
import { SMALL_DIFF_SHAPE } from "#test/helpers/diff/fixture/shapes.js";
import { renderSettled } from "#test/helpers/app/harness.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { ArtifactPayloadSection } from "#renderer/features/repos/artifacts/components/ArtifactPayloadSection.js";
import { DiffFileList } from "#renderer/features/repos/diff/components/DiffFileList.js";
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
import { describeViolations, runTierAxe } from "./axe-run.js";

/** How long a bar may take to start and show: the library's load plus its window's idle time. */
const BAR_SHOWN_TIMEOUT_MS = 5000;

/** A vertical bar the library is showing, not one faded out or with nothing to scroll. */
const SHOWN_VERTICAL_BAR =
  ".os-scrollbar-vertical:not(.os-scrollbar-auto-hide-hidden):not(.os-scrollbar-unusable)";

/** More commands than the palette's list shows, so it scrolls. */
const PALETTE_COMMAND_COUNT = 120;

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

  it("has no axe violation with the bars of Review's diff and the command palette's list showing", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    const diffPane = await mountDiffPane();
    const registry = new CommandRegistry();
    registry.registerAll(
      Array.from({ length: PALETTE_COMMAND_COUNT }, (_unused, ordinal) => ({
        id: `test.command.${String(ordinal)}`,
        title: `A command ${String(ordinal).padStart(3, "0")}`,
        group: "Commands",
        run: () => undefined,
      })),
    );
    const BridgeHost = liveBridgeWrapper();
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
          }}
          open
          onOpenChange={() => undefined}
          platform="darwin"
        />
      </BridgeHost>,
    );
    const diff = diffPane.element.querySelector<HTMLElement>(".meridian-diff");
    const paletteList = document.querySelector<HTMLElement>(".command-palette__list");
    const palettePopup = paletteList?.closest<HTMLElement>(".command-palette__popup");
    if (
      diff === null ||
      paletteList === null ||
      palettePopup === null ||
      palettePopup === undefined
    ) {
      throw new Error("the diff or the palette drew no scroller");
    }
    // The pane holds the diff to a height, so its rows overflow it.
    diff.style.maxBlockSize = "8rem";
    await showEveryBar([diff, paletteList]);

    expect(describeViolations(await runTierAxe(diffPane.element))).toStrictEqual([]);
    expect(describeViolations(await runTierAxe(palettePopup))).toStrictEqual([]);
  });
});
