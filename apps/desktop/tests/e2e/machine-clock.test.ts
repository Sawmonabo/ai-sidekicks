// The machine's region and its 12- or 24-hour clock reach the console document's bridge as main
// read them off macOS: a Mac set to the United States with 24-Hour Time on, which System Settings
// keeps in `AppleICUForce24HourTime`, reports `h23` under a US English UI language, whose own
// clock is 12-hour like the region's. The setting is the launch's own, through
// Cocoa's argument domain, so the machine's settings never change. When macOS posts that the
// locale settings changed, main reads them again and the page hears the clock it read.

import { describe, expect, it } from "vitest";

import type { AppFacts, MachineClock } from "#shared/app-facts.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt || process.platform !== "darwin")(
  "end-to-end — the machine's clock on the bridge",
  () => {
    it("carries the 24-hour switch a US English Mac is set to, apart from its UI language, and again on each change notice", async () => {
      await withLaunchedApp(
        {
          macUserDefaults: {
            AppleLocale: "en_US",
            AppleLanguages: "(en-US)",
            AppleICUForce24HourTime: "YES",
          },
        },
        async (appUnderTest) => {
          const facts = await appUnderTest.consolePage.evaluate(
            (): AppFacts => (window as unknown as { desktopBridge: PreloadApi }).desktopBridge.app,
          );

          expect(facts.locale).toBe("en-US");
          expect(facts.regionLocale).toBe("en-US");
          expect(facts.hourCycle).toBe("h23");

          // The page's first delivery is the clock it holds; the second can come only from main.
          const delivered = appUnderTest.consolePage.evaluate(
            async (timeoutMs) =>
              await new Promise<MachineClock[]>((resolve, reject) => {
                const clocks: MachineClock[] = [];
                const timer = setTimeout(() => {
                  stop();
                  reject(
                    new Error(`main pushed no clock after the notice: ${JSON.stringify(clocks)}`),
                  );
                }, timeoutMs);
                const stop = (
                  window as unknown as { desktopBridge: PreloadApi }
                ).desktopBridge.app.subscribeMachineClock((clock) => {
                  clocks.push(clock);
                  if (clocks.length === 1) {
                    document.documentElement.dataset["machineClockHeard"] = "";
                  } else {
                    clearTimeout(timer);
                    stop();
                    resolve(clocks);
                  }
                });
              }),
            appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          );
          await appUnderTest.consolePage.waitForSelector("html[data-machine-clock-heard]", {
            state: "attached",
          });
          await appUnderTest.application.evaluate(({ systemPreferences }) => {
            systemPreferences.postLocalNotification(
              "kCFLocaleCurrentLocaleDidChangeNotification",
              {},
            );
          });

          const clock = { regionLocale: "en-US", hourCycle: "h23" };
          expect(await delivered).toStrictEqual([clock, clock]);
        },
      );
    });
  },
);
