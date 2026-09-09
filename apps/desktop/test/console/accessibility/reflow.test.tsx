// The console at its narrowest supported viewport.
//
// `Spec-023 §Console Design (Meridian)` sets WCAG 2.2 AA, and SC 1.4.10 (Reflow) is
// the one criterion in it that no rule in this directory's axe runs can reach —
// `axe-tags.test.ts` records that the 2.2 tags select `target-size` and nothing
// else at this pin, and reflow is a property of a layout at a width rather than of
// a node. So this file narrows the page to `REFLOW_MIN_WIDTH_PX`, the floor
// `tokens/palette.ts` declares and `frame.css` spends, and reads what would still
// need a sideways scroll.
//
// THE THREE RAIL DESTINATIONS, DERIVED AND NOT LISTED. `RAIL_DESTINATIONS` is the
// routing family's closed tuple and `routeForDestination` is the frame's map from
// one to an address, so a fourth destination is audited here the day it is declared
// rather than the day somebody remembers this file. They are the whole of what the
// main window opens at, which is what makes them the criterion's subject: reflow is
// about a PAGE, and a pane mounted inside one is measured by whichever destination
// carries it.
//
// THE FLAGSHIP SCENARIO AND NOT THE FIRST-RUN ONE. A console with nothing in it
// reflows trivially — there is no row long enough to push a box wide. The flagship
// fixture is the one carrying real sessions, runs, and wire identifiers, which are
// the strings that actually decide whether a 320 px column holds.
//
// WHAT A CLEAN RESULT MEANS is guarded twice over: the narrowing itself throws if
// the viewport did not move (see `reflow.ts`), and the planted box below has to be
// found — it is wider than the floor and narrower than the tier's own 1440 px
// window, so it fits, and reports nothing, in exactly the world where the narrowing
// failed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";
import {
  describeHorizontalOverflow,
  narrowTesterViewportTo,
  plantHorizontalOverflow,
  restoreTesterViewport,
} from "./reflow.js";

import { FLAGSHIP_SCENARIO_ID } from "../../../src/renderer/src/console/bridge/scenario/flagship/flagship.js";
import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { routeForDestination } from "../../../src/renderer/src/console/frame/composition/rail-navigation.js";
import { RAIL_DESTINATIONS, formatRoute } from "../../../src/renderer/src/console/routing/index.js";
// The family door, imported for its side effect: `apps/desktop/AGENTS.md` puts a
// family's stylesheet behind its own barrel, and the case below is about what that
// stylesheet computes to when the row is given a column narrower than its text.
import "../../../src/renderer/src/console/sessions/index.js";
import { SessionRow } from "../../../src/renderer/src/console/sessions/SessionRow.js";
// The chunk root the settings surface's loader fetches, imported for its side effect:
// `apps/desktop/AGENTS.md` puts a lazily-loaded directory's stylesheets behind that
// root, and the case below is about what the keyboard sheet computes to when the meta
// line is given a column narrower than the id on it.
import "../../../src/renderer/src/console/settings/settings-surface-body.js";
import { KeybindingRowBody } from "../../../src/renderer/src/console/settings/pages/keyboard/KeybindingRowBody.js";
import { SETTINGS_SECTION_IDS } from "../../../src/renderer/src/console/settings/settings-sections.js";
import { REFLOW_MIN_WIDTH_PX } from "../../../src/renderer/src/console/tokens/palette.js";

/**
 * A wire identifier with no break opportunity anywhere in it.
 *
 * The flagship's session ids are UUIDs, and a UUID's four hyphens are break
 * opportunities — so the narrowest line one can make is a twelve-character group,
 * and whether THAT fits the column the floor leaves the row is a question about the
 * face as much as about the layout. A digest-shaped id hands the line breaker
 * nothing at all, so this case asks the row the question the flagship's data can only
 * ask of one font at a time: the box wraps whatever the wire sent, or it overflows on
 * every font there is.
 */
const UNBREAKABLE_SESSION_ID = "b3a7c1d95e2f48a06b1c3d5e7f9012345678abcdef0123456789abcdef012345";

/**
 * A command id long enough that no column at the floor holds it on one line.
 *
 * The keyboard page's meta line carries this id as a wire figure, and a figure is
 * rendered verbatim in mono and never truncated — so whether the page reflows is a
 * question about the longest id the command table happens to hold, which is data and
 * changes. The dotted segments are real break opportunities, which is what makes this
 * the honest question to ask: the row has to wrap INSIDE a segment, because the
 * narrowest line the segments alone can draw is still wider than the column.
 */
const UNBREAKABLE_COMMAND_ID =
  "console.workspace.deck.pane.terminal.lease.releaseAndReclaimEverySeatedViewer";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
  narrowTesterViewportTo(REFLOW_MIN_WIDTH_PX);
});

afterEach(() => {
  restoreTesterViewport();
});

describe("reflow — the console at 320 CSS px", () => {
  for (const destination of RAIL_DESTINATIONS) {
    it(`needs no horizontal scroll at the ${destination} destination`, async () => {
      document.location.hash = formatRoute(routeForDestination(destination));
      await renderSettled(<ConsoleRoot scenarioId={FLAGSHIP_SCENARIO_ID} />);

      // Stated before it is read, so the width this case measured is in the record
      // rather than inferred from the assertion that follows it.
      expect(window.innerWidth).toBe(REFLOW_MIN_WIDTH_PX);
      // The whole document, not the mounted container: the criterion is about a page
      // scrolling in two dimensions, and a surface that pushes the document wider
      // does it through whichever boxes sit between them.
      expect(describeHorizontalOverflow(document.documentElement)).toStrictEqual([]);
    });
  }

  // Every settings page, because settings is where the console packs a form into a
  // column: `settings-page.css` sets its prose measure in `ch`, lays field groups
  // out on an auto-fitting track, and caps a control at a px width — three things
  // that each hold a floor of their own and have to fit inside one 320 px viewport
  // together. The set is `SETTINGS_SECTION_IDS`, the family's own closed tuple, so a
  // fourteenth page is audited the day it is declared.
  for (const page of SETTINGS_SECTION_IDS) {
    it(`needs no horizontal scroll on the ${page} settings page`, async () => {
      document.location.hash = formatRoute({ kind: "settings", page });
      await renderSettled(<ConsoleRoot scenarioId={FLAGSHIP_SCENARIO_ID} />);

      expect(window.innerWidth).toBe(REFLOW_MIN_WIDTH_PX);
      expect(describeHorizontalOverflow(document.documentElement)).toStrictEqual([]);
    });
  }

  it("holds the frame at the floor rather than squeezing below it", async () => {
    // The floor's production half. `frame.css` declares `min-width` from the token,
    // so a viewport NARROWER than the floor scrolls the document sideways — which is
    // what 1.4.10 permits below 320 CSS px — instead of taking every surface inside
    // the frame further into a squeeze the criterion says nothing about. Without the
    // declaration the frame would simply track the viewport and this case would read
    // the frame at the narrower width.
    narrowTesterViewportTo(REFLOW_MIN_WIDTH_PX - 40);
    document.location.hash = formatRoute(routeForDestination("settings"));
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FLAGSHIP_SCENARIO_ID} />);

    const frame = container.querySelector(".meridian-frame");
    expect(frame?.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
  });

  // The session row on its own, at the floor, carrying an identifier the console did
  // not choose the width of.
  //
  // WHY A COMPONENT CASE BESIDE THE PAGE ONES. The destination case above measures
  // the flagship's own ids in whatever face the host resolves, and both are
  // variables — so it answers "these ids fit here today" rather than the thing the
  // row actually owes, which is that the identity column wraps whatever the wire
  // sent. That is a property one row can be asked about directly, with an identifier
  // no font can fit and the face therefore out of the question.
  it("wraps a session identifier that has no break opportunity in it", async () => {
    const { container } = await renderSettled(
      <SessionRow
        row={{
          sessionId: UNBREAKABLE_SESSION_ID,
          state: "active",
          touchedAtIso: undefined,
          participantIds: [],
          attentionSeverity: undefined,
          tier: "front",
        }}
        onOpen={() => undefined}
        onSetTier={() => undefined}
      />,
    );

    // The harness sizes its container to the viewport, which `beforeEach` has already
    // narrowed to the floor — so the row is laid out in exactly the width 1.4.10 asks
    // about, and the same reader the destination cases use names the box that fails.
    expect(container.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
    expect(describeHorizontalOverflow(container)).toStrictEqual([]);
  });

  // The keyboard row on its own, at the floor, carrying a command id the console did
  // not choose the width of.
  //
  // The page case above measures whatever ids the command table holds today, in
  // whatever face the host resolves — so it answers "these ids fit here" rather than
  // the thing the meta line owes, which is that it wraps whatever the wire named. The
  // id below is wider than the floor in any face, so the face is out of the question
  // and what is left is whether the line is allowed to break inside a segment at all.
  it("wraps a command id the meta line has no room for", async () => {
    const { container } = await renderSettled(
      <KeybindingRowBody
        row={{
          commandId: UNBREAKABLE_COMMAND_ID,
          title: "Release every seated viewer's terminal lease",
          group: "Workspace",
          chord: "⌘⇧L",
          whenExpression: undefined,
          unavailableReason: undefined,
          shippedChord: "⌘⇧L",
          overridden: false,
        }}
        recording={false}
        refusal={undefined}
        onStartRecording={() => undefined}
        onRecorded={() => undefined}
        onReset={() => undefined}
      />,
    );

    expect(container.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
    expect(describeHorizontalOverflow(container)).toStrictEqual([]);
  });

  it("finds a planted overflow, so a clean result means something", async () => {
    document.location.hash = formatRoute(routeForDestination("sessions"));
    const { container } = await renderSettled(<ConsoleRoot scenarioId={FLAGSHIP_SCENARIO_ID} />);

    const planted = plantHorizontalOverflow(container, REFLOW_MIN_WIDTH_PX);
    try {
      expect(describeHorizontalOverflow(document.documentElement).join("\n")).toContain(
        "overflows by",
      );
    } finally {
      planted.remove();
    }
  });
});
