// The accessibility tier for the transcript: a virtualized feed of cards, a facet bar and a
// find field, all hue-tinted per user. Many rules can fail here that fail nowhere else: a muted
// label on a tinted ground, rows mounted and unmounted under the reader, a hover-revealed
// control shipped without a name.
//
// The pane is mounted directly, not through `AppProviders`, under the window's one announcer.
// The store is opened on the scenario's own log because content delivered by scripted beats
// depends on how far a frozen clock was advanced, so the amount of transcript under test would be
// an accident of the test.
//
// Everything else is the real composition: `SessionStore`, the projection, the
// `@tanstack/react-virtual` instance, the registered row renderer, and the
// `SessionScreenContainer` that gives the scroll container a definite height (a virtualizer
// over a zero-height box reports no rows, and an empty feed would pass).
//
// A loaded transcript and an empty one are different documents, so both run, in both schemes
// for the frame case's contrast reason.
//
// The regions inside a row are mounted directly too, each holding more than a narrow column
// shows: a table wraps its cells to the column rather than scrolling, so a real Tab press passes
// over it.

import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { renderSettled } from "../../helpers/app/harness.js";
import { emulateSystemScheme } from "../../helpers/media-emulation.js";
import { describeViolations, runTierAxe } from "../axe-run.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "../../helpers/app/frame-fixtures.js";
import type { Scenario } from "#fixtures/scenario.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { TRANSCRIPT_STATES_SCENARIO } from "#fixtures/scenarios/transcript-states.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { ManualClock } from "#renderer/lib/clock.js";
// Imported deeply, not through the feature's `index.ts`: widening the public entry for one test
// would be wrong.
import { registerTranscriptRows } from "#renderer/features/transcript/contributions/rows.js";
import { TranscriptPane } from "#renderer/features/transcript/TranscriptPane.js";
import { transcriptPaneContext } from "#renderer/features/transcript/TranscriptPane.test-support.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { COLOR_SCHEMES } from "#renderer/styles/tokens.js";
import { SessionScreenContainer } from "#renderer/features/transcript/SessionScreenContainer.js";
import type { CodeSpanReader } from "#renderer/components/Markdown/highlight/code-span-reader.js";
import { MarkdownNodes } from "#renderer/components/Markdown/MarkdownNodes.js";
import { parseSettledBlock } from "#renderer/components/Markdown/parse.js";
import { installOverlayScrollbarLibrary } from "#renderer/lib/overlay-scrollbar-library.js";

/** A column narrower than the table below, as a narrow conversation is. */
const ROW_COLUMN_WIDTH = "30rem";

/** A table whose cells, laid out unwrapped, run several times the column's width. */
const WIDE_TABLE = [
  `| ${Array.from({ length: 8 }, (_unused, index) => `heading ${String(index)}`).join(" | ")} |`,
  `|${" --- |".repeat(8)}`,
  `| ${Array.from({ length: 8 }, () => "an_unbroken_cell_value_with_no_spaces").join(" | ")} |`,
  "",
].join("\n");

/** The table holds no code block, so nothing may ask for code colors. */
const NO_CODE_SPANS: CodeSpanReader = {
  heldSpans: () => {
    throw new Error("A table here asked for code colors.");
  },
  readSpans: () => {
    throw new Error("A table here asked for code colors.");
  },
};

/**
 * A real store holding the whole of one scenario's log, so the projection, the run group fold
 * and the superseded index run over real state. The quiet scenario scripts no beats, which is
 * how the empty case reaches a state a scripted stream never produces.
 */
function openStoreOnScenario(scenario: Scenario): SessionStore {
  const sessionStore = new SessionStore({ sessionId: scenario.sessionId });
  // `composeScriptBeats` numbers beats from 0, as the daemon numbers a log, so the store starts
  // before the first: a base of 0 would refuse beat 0 as one it already holds.
  sessionStore.initialize({ cursor: START_OF_LOG_POSITION, entities: [] });
  if (scenario.beats.length > 0) {
    sessionStore.applyBatch(scenario.beats.map((beat) => beat.event));
  }
  return sessionStore;
}

/**
 * Mount one scenario's transcript the way a window mounts it. `SessionScreenContainer` is
 * the production wrapper that carries the full-height grid down to the scroll container.
 */
async function mountTranscript(scenario: Scenario): Promise<HTMLElement> {
  const sessionStore = openStoreOnScenario(scenario);
  const { container } = await renderSettled(
    <FixtureBridgeProvider fixture={createFixtureBridge({ scenario })}>
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <SessionScreenContainer>
          <TranscriptPane context={transcriptPaneContext(sessionStore, scenario.sessionId)} />
        </SessionScreenContainer>
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  return container;
}

beforeEach(() => {
  installMeridianTokens(document);
  // The row renderer, registered the way the console registers it; the pane cannot render
  // rows without one.
  registerTranscriptRows();
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the transcript", () => {
  for (const scheme of COLOR_SCHEMES) {
    it(`has no axe violation over a loaded transcript in the ${scheme} scheme`, async () => {
      // Through the system preference, as in the frame case: the scheme attribute has an owner,
      // and writing it would measure both cases against one palette.
      await emulateSystemScheme(scheme);
      const container = await mountTranscript(TRANSCRIPT_STATES_SCENARIO);

      // The positive control for the case: axe over a feed that mounted no rows returns the same
      // empty list as one that mounted them all, so without this the clean result could hold
      // over a transcript that drew nothing.
      expect(
        container.querySelectorAll(".meridian-transcript-viewport__row").length,
        "the transcript mounted no rows, so a clean axe result says nothing about a card",
      ).toBeGreaterThan(0);

      expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
    });

    it(`has no axe violation on the transcript's empty state in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const container = await mountTranscript(EMPTY_SESSION_SCENARIO);

      // The same control from the other side: the pane must actually have reached the empty
      // state, which a scenario that grew a beat would silently stop doing.
      expect(container.textContent).toContain("No messages yet. Say what you are after.");
      expect(container.querySelectorAll(".meridian-transcript-viewport__row")).toHaveLength(0);

      expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
    });
  }
});

describe("accessibility — the regions inside a transcript row", () => {
  it("fits a table to the column, so Tab passes over it", async () => {
    installOverlayScrollbarLibrary(document);
    const { container } = await renderSettled(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <div className="row-column" style={{ inlineSize: ROW_COLUMN_WIDTH }}>
          <button type="button">Before the rows</button>
          <MarkdownNodes
            nodes={parseSettledBlock(WIDE_TABLE).children}
            context={{
              isSettled: true,
              definedFootnoteIdentifiers: new Set(),
              codeSpanReader: NO_CODE_SPANS,
              renderCopy: undefined,
              renderTable: undefined,
            }}
          />
          <button type="button">After the rows</button>
        </div>
      </LiveAnnouncerProvider>,
    );
    const column = requireElement(container, ".row-column");
    const table = requireElement(container, ".meridian-markdown__table");

    // The table wraps its cells instead, so it is no region to reach and stays in the column.
    expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(column.clientWidth);

    requireElement(container, "button").focus();
    const reached: string[] = [];
    await act(async () => {
      await userEvent.tab();
      reached.push(document.activeElement?.textContent ?? "nothing");
    });
    expect(reached).toStrictEqual(["After the rows"]);

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });
});

/** The one element `selector` names, or a failure naming what was missing. */
function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`nothing matched ${selector}`);
  }
  return element;
}
