// The console at its narrowest supported viewport.
//
// WCAG 2.2 SC 1.4.10 (Reflow) is the one criterion no axe rule in this directory reaches,
// because reflow is a property of a layout at a width, not of a node. This file narrows the
// page to `REFLOW_MIN_WIDTH_PX`, the floor `styles/palette.ts` declares, and reads what would
// still need a sideways scroll.
//
// The rail destinations are derived from `RAIL_DESTINATIONS`, so a new destination is audited
// the day it is declared. The concurrent-streaming scenario is used rather than the first-run
// one because an empty console reflows trivially; real sessions, runs and wire identifiers
// decide whether a 320 px column holds.
//
// A clean result is guarded twice: the narrowing throws if the viewport did not move (see
// `reflow.ts`), and the planted box below is wider than the floor but narrower than the
// tier's 1440 px window, so it goes unreported exactly when the narrowing failed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderAppSettled, renderSettled } from "../helpers/app/harness.js";
import { liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { describeHorizontalOverflow } from "../helpers/horizontal-overflow.js";
import { narrowTesterViewportTo, restoreTesterViewport } from "./reflow.js";
import { CONCURRENT_STREAMING_SCENARIO_ID } from "#fixtures/scenarios/concurrent-streaming.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { routeForDestination } from "#renderer/layout/NavigationRail/destinations.js";
import { RAIL_DESTINATIONS } from "#renderer/routing/readers.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { SessionRow } from "#renderer/features/sessions/components/SessionRow.js";
// Imported for its side effect: the lazily-loaded settings chunk root imports the settings
// stylesheets the settings-page cases measure.
import "#renderer/features/settings/screen-body.js";
import { SETTINGS_PAGE_IDS } from "#renderer/routing/settings-page-ids.js";
import { REFLOW_MIN_WIDTH_PX } from "#renderer/styles/palette.js";

/**
 * A wire identifier with no break opportunity anywhere in it. A UUID's hyphens are break
 * opportunities, so whether one fits depends on the font; this id overflows in every font
 * unless the box wraps whatever the wire sent.
 */
const UNBREAKABLE_SESSION_ID = "b3a7c1d95e2f48a06b1c3d5e7f9012345678abcdef0123456789abcdef012345";

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
      document.location.hash = formatRoute(routeForDestination(destination, undefined));
      const appWindow = await renderAppSettled(CONCURRENT_STREAMING_SCENARIO_ID);

      // Stated before it is read, so the measured width is in the record.
      expect(appWindow.innerWidth).toBe(REFLOW_MIN_WIDTH_PX);
      // The window's whole document, not one box: the criterion is about a page scrolling in two
      // dimensions, and a view pushes the document wider through whichever boxes sit between.
      expect(describeHorizontalOverflow(appWindow.document.documentElement)).toStrictEqual([]);
    });
  }

  // Every settings page, because settings packs a form into a column: `settings-page.css` sets
  // its prose measure in `ch`, lays field groups on an auto-fitting track and caps a control at a
  // px width, and the three floors have to fit one 320 px viewport together. The set is
  // `SETTINGS_PAGE_IDS`, so a new page is audited the day it is declared.
  for (const page of SETTINGS_PAGE_IDS) {
    it(`needs no horizontal scroll on the ${page} settings page`, async () => {
      document.location.hash = formatRoute({ kind: "settings", page });
      const appWindow = await renderAppSettled(CONCURRENT_STREAMING_SCENARIO_ID);

      expect(appWindow.innerWidth).toBe(REFLOW_MIN_WIDTH_PX);
      expect(describeHorizontalOverflow(appWindow.document.documentElement)).toStrictEqual([]);
    });
  }

  it("holds the frame at the floor rather than squeezing below it", async () => {
    // The floor's production half. `layout/AppShell/AppFrame.css` declares `min-width` from the
    // token, so a viewport narrower than the floor scrolls the document sideways (which 1.4.10
    // permits below 320 CSS px) instead of squeezing every view further. Without it the frame would
    // track the viewport and this case would read it at the narrower width.
    narrowTesterViewportTo(REFLOW_MIN_WIDTH_PX - 40);
    document.location.hash = formatRoute(routeForDestination("settings", undefined));
    const appWindow = await renderAppSettled(CONCURRENT_STREAMING_SCENARIO_ID);

    const frame = appWindow.document.querySelector(".meridian-frame");
    expect(frame?.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
  });

  // The session row on its own, at the floor, carrying an identifier the console did not choose
  // the width of. The destination cases measure the scenario's own ids in whatever face the host
  // resolves, so they answer "these ids fit here today"; the row owes that its identity column
  // wraps whatever the wire sent, which one row can be asked directly with an identifier no font
  // can fit.
  it("wraps a session identifier that has no break opportunity in it", async () => {
    // The row writes its clock figures in the machine's clock, which the bridge carries.
    const BridgeHost = liveBridgeWrapper();
    const { container } = await renderSettled(
      <BridgeHost>
        <SessionRow
          row={{
            sessionId: UNBREAKABLE_SESSION_ID,
            state: "active",
            touchedAtIso: undefined,
            userIds: [],
          }}
          onOpen={() => undefined}
          nowMilliseconds={0}
        />
      </BridgeHost>,
    );

    // The harness sizes its container to the viewport, which `beforeEach` narrowed to the floor,
    // so the row is laid out in exactly the width 1.4.10 asks about.
    expect(container.getBoundingClientRect().width).toBe(REFLOW_MIN_WIDTH_PX);
    expect(describeHorizontalOverflow(container)).toStrictEqual([]);
  });
});
