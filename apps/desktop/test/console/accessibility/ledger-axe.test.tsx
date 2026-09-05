// The accessibility tier — the ledger.
//
// `Spec-023 §Console Design (Meridian)` 14.11 puts WCAG 2.2 AA over every console
// surface, and the ledger is the one a person spends the day inside: a virtualized
// feed of cards, a provenance rail, a replay dock, and a find field, all of them
// hue-tinted per participant. Almost every rule this tier owns has a way to fail
// here that it has nowhere else — a card whose muted label sits on a tinted ground,
// a feed whose rows are mounted and unmounted under the reader, a control that is
// revealed on hover and therefore easy to ship without a name.
//
// WHY THE PANE IS MOUNTED DIRECTLY AND NOT THROUGH `ConsoleRoot`
//
// The frame's own case next door mounts the root, which is right for the frame. The
// ledger needs a session with CONTENT in it, and content reaches a store either from
// a scripted beat — which a frozen clock delivers only when somebody advances it —
// or from the log the store is handed. Advancing the fixture clock from here would
// make the amount of ledger under test a function of how far the test wound the
// clock, which is a quantity nobody reading a failure would think to check. So the
// store is opened on the scenario's own log directly, and what is measured is the
// whole of it.
//
// Everything else is the real composition: the real `SessionStore`, the real
// projection, the real `@tanstack/react-virtual` instance, the real card family
// through the seat the console actually registers, and the same
// `meridian-ledger-surface` wrapper `ledger/index.ts` mounts the pane inside — which
// is also what gives the scroll container a definite height, since a virtualizer
// over a zero-height box reports no rows and would leave this file asserting that an
// empty feed is accessible.
//
// TWO SURFACES, NOT ONE. A loaded ledger and an empty one are different documents:
// the empty one has no feed items at all and renders an absence in their place, so a
// rule that only bites over rows and a rule that only bites over the absence are two
// rules, and running one surface would leave the other unmeasured. Both run in both
// schemes, on the frame case's reasoning about contrast.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";
import { describeViolations, runAxe } from "./axe-run.js";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import type { ConsoleScenario } from "../../../src/renderer/src/console/bridge/scenario.js";
import { LEDGER_QUIET_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/ledger-quiet.js";
import { LEDGER_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/ledger.js";
import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { registerFixtureShellRows } from "../../../src/renderer/src/console/ledger/index.js";
import {
  TimelinePane,
  type TimelinePaneContext,
} from "../../../src/renderer/src/console/panes/timeline/TimelinePane.js";
import { FrameStore, SessionStore } from "../../../src/renderer/src/console/store/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";
import { unregisterTimelineRowRenderer } from "../../../src/renderer/src/console/seats/index.js";

/**
 * The cursor a scenario's log is applied on top of.
 *
 * Zero rather than `-1`, because `scriptLedgerBeats` numbers a scenario's beats from
 * one: a store rebased at `-1` would see its first beat as sequence one arriving
 * after sequence zero never did, record the gap, and render the rail's dotted head
 * and a degraded banner — a surface neither case here is about, and a difference
 * between the two scenarios only one of them would show.
 */
const SCENARIO_BASE_CURSOR = 0;

/**
 * The pane context, with the members this surface reads real and the rest cast.
 *
 * `frameStore` is real because the pane subscribes to it for the breadcrumb, and
 * `sessionStore` is real because it is the whole subject. The three it never touches
 * — the bridge handle on the context, the durable UI-state store, and the draft
 * store — are cast rather than constructed: one of them opens a database, and
 * building it to satisfy a field nothing reads would make the setup the subject.
 * (The bridge the ledger DOES read is the provider's, one level up, which is real.)
 */
function ledgerPaneContext(sessionId: string, sessionStore: SessionStore): TimelinePaneContext {
  return {
    kind: "timeline",
    paneId: "ledger-timeline",
    frameStore: new FrameStore({ initialRoute: { kind: "workspace", sessionId } }),
    sessionStore,
    focusHue: undefined,
  } as unknown as TimelinePaneContext;
}

/**
 * A real store holding the whole of one scenario's log.
 *
 * Real rather than a stand-in, because the projection, the chapter fold, the
 * superseded index, and the rail model all run over what this returns — and a fake
 * store would let every one of them be wrong together while axe reported a clean
 * document. The quiet scenario scripts no beats at all, which is exactly how the
 * empty case reaches a state a scripted stream can never produce.
 */
function openStoreOnScenario(scenario: ConsoleScenario): SessionStore {
  const sessionStore = new SessionStore({ sessionId: scenario.sessionId });
  sessionStore.initialise({
    cursor: SCENARIO_BASE_CURSOR,
    entities: [],
    participantJoinLog: [...scenario.participantIdsInJoinOrder],
  });
  if (scenario.beats.length > 0) {
    sessionStore.applyBatch(scenario.beats.map((beat) => beat.event));
  }
  return sessionStore;
}

/**
 * Mount one scenario's ledger the way a window mounts it.
 *
 * `meridian-ledger-surface` is production markup — `ledger/index.ts` wraps the pane
 * in exactly this element on both of the surfaces it registers — and it is what
 * carries the full-height grid down to the scroll container. A bare test wrapper
 * would have been a second layout nobody ships, measured instead of the one that is.
 */
async function mountLedger(scenario: ConsoleScenario): Promise<HTMLElement> {
  const sessionStore = openStoreOnScenario(scenario);
  const { container } = await renderSettled(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario })}>
      <div className="meridian-ledger-surface">
        <TimelinePane context={ledgerPaneContext(scenario.sessionId, sessionStore)} />
      </div>
    </SidekicksBridgeProvider>,
  );
  return container;
}

beforeEach(() => {
  installMeridianTokens(document);
  // The row seat, filled with the same shell the console registers. Without it the
  // pane renders its reserved-not-built absence and this whole file would be
  // measuring a grey line where the ledger is supposed to be.
  registerFixtureShellRows();
});

afterEach(async () => {
  // The seat is module-scope, so a filled one would outlive this file.
  unregisterTimelineRowRenderer();
  await emulateSystemScheme("light");
});

describe("accessibility — the ledger", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    it(`has no axe violation over a loaded ledger in the ${scheme} scheme`, async () => {
      // Through the system preference rather than a stamped attribute, on the frame
      // case's reasoning: the scheme attribute has an owner, and a test that wrote
      // it would have both cases silently measured against one palette.
      await emulateSystemScheme(scheme);
      const container = await mountLedger(LEDGER_SCENARIO);

      // The positive control for the whole case, and it is not a formality: axe over
      // a feed that mounted no rows returns the same empty violation list as axe over
      // a feed that mounted them all, so without this the clean result below would
      // hold over a ledger that drew nothing.
      expect(
        container.querySelectorAll(".meridian-ledger-viewport__row").length,
        "the ledger mounted no rows, so a clean axe result says nothing about a card",
      ).toBeGreaterThan(0);

      expect(describeViolations(await runAxe(container))).toStrictEqual([]);
    });

    it(`has no axe violation over the ledger's empty state in the ${scheme} scheme`, async () => {
      await emulateSystemScheme(scheme);
      const container = await mountLedger(LEDGER_QUIET_SCENARIO);

      // The same control from the other side: this case is only about the empty
      // state if the surface actually reached it, and a scenario that had grown a
      // beat would put this file back on the loaded surface without saying so.
      expect(container.textContent).toContain("Nothing has happened in this session yet.");
      expect(container.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(0);

      expect(describeViolations(await runAxe(container))).toStrictEqual([]);
    });
  }

  it("finds a violation planted inside the ledger, so a clean result means something", async () => {
    // Negative control, planted INSIDE the mounted surface rather than beside it: a
    // run scoped to the wrong root, given the wrong tags, or swallowing an exception
    // returns exactly the same nothing as a clean one, and planting within the
    // container proves the run reaches the subtree the cases above assert over.
    const container = await mountLedger(LEDGER_SCENARIO);
    const planted = document.createElement("div");
    planted.innerHTML = '<img src="data:," />';
    container.append(planted);
    try {
      expect((await runAxe(container)).map((violation) => violation.id)).toContain("image-alt");
    } finally {
      planted.remove();
    }
  });
});
