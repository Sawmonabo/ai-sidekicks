// The app at its narrowest supported viewport.
//
// WCAG 2.2 SC 1.4.10 (Reflow) is the one criterion no axe rule in this directory reaches,
// because reflow is a property of a layout at a width, not of a node. This file narrows the
// page to `REFLOW_MIN_WIDTH_PX`, the floor `styles/palette.ts` declares, and reads what would
// still need a sideways scroll.
//
// The rail destinations are derived from `RAIL_DESTINATIONS`, so a new destination is audited
// the day it is declared. The concurrent-streaming scenario is used rather than the first-run
// one because an empty app reflows trivially; real sessions, runs and wire identifiers
// decide whether a 320 px column holds.
//
// A clean result is guarded by the narrowing, which throws if the viewport did not move (see
// `reflow.ts`).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";
import {
  describeHorizontalOverflow,
  narrowTesterViewportTo,
  restoreTesterViewport,
} from "./reflow.js";
import { CONCURRENT_STREAMING_SCENARIO_ID } from "../../fixtures/scenarios/concurrent-streaming.js";
import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/AppProviders.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { routeForDestination } from "@renderer/layout/NavigationRail/rail-navigation.js";
import { RAIL_DESTINATIONS } from "@renderer/routing/route-readers.js";
import { formatRoute } from "@renderer/routing/routes.js";
// Imported for its side effect: it reaches the flyout that imports the sessions stylesheet
// the row case below measures.
import "@renderer/features/sessions/contributions/screens.js";
import { SessionRow } from "@renderer/features/sessions/components/SessionRow.js";
// Imported for its side effect: the lazily-loaded settings chunk root imports the keyboard
// stylesheet the meta-line case below measures.
import "@renderer/features/settings/settings-screen-body.js";
import { KeybindingRowBody } from "@renderer/features/settings/pages/keyboard/components/KeybindingRowBody.js";
import { SETTINGS_PAGE_IDS } from "@renderer/routing/settings-page-ids.js";
import { REFLOW_MIN_WIDTH_PX } from "@renderer/styles/palette.js";

/**
 * A wire identifier with no break opportunity anywhere in it. A UUID's hyphens are break
 * opportunities, so whether one fits depends on the font; this id overflows in every font
 * unless the box wraps whatever the wire sent.
 */
const UNBREAKABLE_SESSION_ID = "b3a7c1d95e2f48a06b1c3d5e7f9012345678abcdef0123456789abcdef012345";

/**
 * A command id no column at the floor holds on one line. The meta line renders a wire figure
 * verbatim in mono and never truncates it, and the id's longest dotted segment is still wider
 * than the column, so the row has to wrap inside a segment.
 */
const UNBREAKABLE_COMMAND_ID =
  "console.example.group.command.aVeryLongIdentifierWithNoBreakOpportunityInsideItAtAll";

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
  narrowTesterViewportTo(REFLOW_MIN_WIDTH_PX);
});

afterEach(() => {
  restoreTesterViewport();
});

describe("reflow — the app at 320 CSS px", () => {
  for (const destination of RAIL_DESTINATIONS) {
    it(`needs no horizontal scroll at the ${destination} destination`, async () => {
      document.location.hash = formatRoute(routeForDestination(destination));
      await renderSettled(
        <AppProviders composition={createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID)} />,
      );

      // Stated before it is read, so the measured width is in the record.
      expect(window.innerWidth).toBe(REFLOW_MIN_WIDTH_PX);
      // The whole document, not the mounted container: the criterion is about a page scrolling
      // in two dimensions, and a view pushes the document wider through whichever boxes sit
      // between them.
      expect(describeHorizontalOverflow(document.documentElement)).toStrictEqual([]);
    });
  }

  // Every settings page, because settings packs a form into a column: `settings-page.css` sets
  // its prose measure in `ch`, lays field groups on an auto-fitting track and caps a control at a
  // px width, and the three floors have to fit one 320 px viewport together. The set is
  // `SETTINGS_PAGE_IDS`, so a new page is audited the day it is declared.
  for (const page of SETTINGS_PAGE_IDS) {
    it(`needs no horizontal scroll on the ${page} settings page`, async () => {
      document.location.hash = formatRoute({ kind: "settings", page });
      await renderSettled(
        <AppProviders composition={createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID)} />,
      );

      expect(window.innerWidth).toBe(REFLOW_MIN_WIDTH_PX);
      expect(describeHorizontalOverflow(document.documentElement)).toStrictEqual([]);
    });
  }

  it("holds the frame at the floor rather than squeezing below it", async () => {
    // The floor's production half. `app-frame.css` declares `min-width` from the token, so a
    // viewport narrower than the floor scrolls the document sideways (which 1.4.10 permits below
    // 320 CSS px) instead of squeezing every view further. Without it the frame would track the
    // viewport and this case would read it at the narrower width.
    narrowTesterViewportTo(REFLOW_MIN_WIDTH_PX - 40);
    document.location.hash = formatRoute(routeForDestination("settings"));
    const { container } = await renderSettled(
      <AppProviders composition={createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID)} />,
    );

    const frame = container.querySelector(".meridian-frame");
    expect(frame?.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
  });

  // The session row on its own, at the floor, carrying an identifier the app did not choose
  // the width of. The destination cases measure the scenario's own ids in whatever face the host
  // resolves, so they answer "these ids fit here today"; the row owes that its identity column
  // wraps whatever the wire sent, which one row can be asked directly with an identifier no font
  // can fit.
  it("wraps a session identifier that has no break opportunity in it", async () => {
    const { container } = await renderSettled(
      <SessionRow
        row={{
          sessionId: UNBREAKABLE_SESSION_ID,
          state: "active",
          touchedAtIso: undefined,
          userIds: [],
        }}
        onOpen={() => undefined}
      />,
    );

    // The harness sizes its container to the viewport, which `beforeEach` narrowed to the floor,
    // so the row is laid out in exactly the width 1.4.10 asks about.
    expect(container.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
    expect(describeHorizontalOverflow(container)).toStrictEqual([]);
  });

  // The keyboard row on its own, at the floor, carrying a command id the app did not choose
  // the width of. The page cases measure the ids the command table holds today, so they answer
  // "these ids fit here"; the meta line owes that it wraps whatever the wire named. The id below
  // is wider than the floor in any face, leaving only whether the line may break inside a
  // segment.
  it("wraps a command id the meta line has no room for", async () => {
    const { container } = await renderSettled(
      <KeybindingRowBody
        row={{
          commandId: UNBREAKABLE_COMMAND_ID,
          title: "A command with a long identifier",
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
});
