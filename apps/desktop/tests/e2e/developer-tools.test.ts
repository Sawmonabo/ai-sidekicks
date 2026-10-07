// Developer tools in the console's windows outside a development build, on the fixtures build. A
// console window a person sees adopts the page Chromium made for the console document's
// `window.open`, whose developer tools Electron leaves on whatever its options say, so the factory
// refuses that page's openers and closes developer tools anything else opens in it. The menu
// carries no developer-tools row; the row's chord is checked through the row, since a key a test
// presses reaches the page and never the menu.
//
// A refused opener reports nothing, so the openers are given one in-window step to announce
// `devtools-opened`, and a passing run waits that step out. An opener that works announces it in
// well under a second.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

/** The address a console window a person sees starts on: a blank page the console document draws. */
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
  it("refuses every way a console window opens developer tools, and offers no menu row", async () => {
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      const stepMs = appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS);
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
      const menuRoles = await appUnderTest.application.evaluate(({ Menu }) => {
        const roles: string[] = [];
        const pending = [...(Menu.getApplicationMenu()?.items ?? [])];
        for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
          // Electron answers `null`, not `undefined`, for a row built without a role.
          if (typeof item.role === "string") {
            roles.push(item.role);
          }
          pending.push(...(item.submenu?.items ?? []));
        }
        return roles;
      });

      expect(openerReadings.length, "no window a person sees was found").toBeGreaterThan(0);
      for (const reading of openerReadings) {
        expect(reading, `developer tools opened in ${reading.url}`).toEqual<OpenerReading>({
          url: reading.url,
          isDevToolsAnnounced: false,
          isDevToolsOpened: false,
        });
      }
      for (const reading of backstopReadings) {
        expect(reading, `developer tools left open in ${reading.url}`).toEqual<BackstopReading>({
          url: reading.url,
          isClosedByBackstop: true,
          isDevToolsOpened: false,
        });
      }
      expect(menuRoles).toContain("togglefullscreen");
      expect(menuRoles).not.toContain("toggledevtools");
    });
  });
});
