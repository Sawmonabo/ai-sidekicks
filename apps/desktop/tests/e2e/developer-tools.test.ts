// Developer tools in the console's windows outside a development build, on the fixtures build. A
// console window a person sees adopts the page Chromium made for the console document's
// `window.open`, which Electron builds with no options, so no `devTools` preference reaches it: the
// factory refuses that page's openers and closes developer tools anything else opens in it. The
// openers driven here are the three that need no worker; the worker inspectors are refused the same
// way and have no worker to open here. The menu carries no developer-tools row; the row's chord is
// checked through the row, since a key a test presses reaches the page and never the menu.
//
// A refused opener reports nothing, so a passing run waits out its announcement window.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How long an opener has to announce `devtools-opened`, in milliseconds. One that works announces
 * it in about 0.4 s on an unloaded macOS M1 Pro, so 5 s leaves a slower runner room before a
 * working opener is missed.
 */
const DEVELOPER_TOOLS_ANNOUNCEMENT_MS = 5_000;

/** Where a console window a person sees starts: a blank page the console document draws. */
const VISIBLE_WINDOW_ADDRESS = "about:blank";

/** One visible window, read once its openers have had their step. */
interface OpenerReading {
  readonly url: string;
  readonly isDevToolsAnnounced: boolean;
  readonly isDevToolsOpened: boolean;
}

/** One visible window, read once developer tools opened past its refused openers had their step. */
interface BackstopReading {
  readonly url: string;
  readonly isClosedByBackstop: boolean;
  readonly isDevToolsOpened: boolean;
}

describe.skipIf(!bundleIsBuilt)("end-to-end — developer tools outside a development build", () => {
  it("refuses a console window's developer-tools openers, and offers no menu row", async () => {
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      const stepMs = appUnderTest.bodyAllowance.boundedMs(DEVELOPER_TOOLS_ANNOUNCEMENT_MS);
      const openerReadings = await appUnderTest.application.evaluate(
        async ({ webContents }, { address, stepMs }): Promise<OpenerReading[]> =>
          await Promise.all(
            webContents
              .getAllWebContents()
              .filter((contents) => contents.getURL().startsWith(address))
              .map(async (contents) => {
                const isDevToolsAnnounced = await new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => {
                    resolve(false);
                  }, stepMs);
                  contents.once("devtools-opened", () => {
                    clearTimeout(timer);
                    resolve(true);
                  });
                  contents.openDevTools({ mode: "detach", activate: false });
                  contents.toggleDevTools();
                  contents.inspectElement(0, 0);
                });
                return {
                  url: contents.getURL(),
                  isDevToolsAnnounced,
                  isDevToolsOpened: contents.isDevToolsOpened(),
                };
              }),
          ),
        { address: VISIBLE_WINDOW_ADDRESS, stepMs },
      );
      // Electron's own opener, reached past the refused one, stands in for a path a later Electron
      // adds: the factory closes what it opens.
      const backstopReadings = await appUnderTest.application.evaluate(
        async ({ webContents }, { address, stepMs }): Promise<BackstopReading[]> =>
          await Promise.all(
            webContents
              .getAllWebContents()
              .filter((contents) => contents.getURL().startsWith(address))
              .map(async (contents) => {
                const isClosedByBackstop = await new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => {
                    resolve(false);
                  }, stepMs);
                  contents.once("devtools-closed", () => {
                    clearTimeout(timer);
                    resolve(true);
                  });
                  const electronOpener = Reflect.get(
                    Object.getPrototypeOf(contents) as object,
                    "openDevTools",
                  ) as typeof contents.openDevTools;
                  electronOpener.call(contents, { mode: "detach", activate: false });
                });
                return {
                  url: contents.getURL(),
                  isClosedByBackstop,
                  isDevToolsOpened: contents.isDevToolsOpened(),
                };
              }),
          ),
        { address: VISIBLE_WINDOW_ADDRESS, stepMs },
      );
      const menuRows = await appUnderTest.application.evaluate(({ Menu }) => {
        const rows: { readonly role: string | null; readonly label: string }[] = [];
        const pending = [...(Menu.getApplicationMenu()?.items ?? [])];
        for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
          // Electron answers `null`, not `undefined`, for a row built without a role.
          rows.push({ role: typeof item.role === "string" ? item.role : null, label: item.label });
          pending.push(...(item.submenu?.items ?? []));
        }
        return rows;
      });
      const menuRoles = menuRows.map((row) => row.role);
      const menuLabels = menuRows.map((row) => row.label);

      expect(openerReadings.length, "no window a person sees was found").toBeGreaterThan(0);
      for (const reading of openerReadings) {
        expect(reading, `developer tools opened in ${reading.url}`).toEqual<OpenerReading>({
          url: reading.url,
          isDevToolsAnnounced: false,
          isDevToolsOpened: false,
        });
      }
      expect(backstopReadings).toHaveLength(openerReadings.length);
      for (const reading of backstopReadings) {
        expect(reading, `developer tools left open in ${reading.url}`).toEqual<BackstopReading>({
          url: reading.url,
          isClosedByBackstop: true,
          isDevToolsOpened: false,
        });
      }
      expect(menuRoles).toContain("togglefullscreen");
      expect(menuRoles).not.toContain("toggledevtools");
      expect(menuLabels).not.toContain("Toggle Developer Tools");
    });
  });
});
