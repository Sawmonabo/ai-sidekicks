// The machine's region and its 12- or 24-hour clock reach the console document's bridge as main
// reads them off macOS. Each launch stands on a US English Mac with one of the two overrides System
// Settings writes, given through Cocoa's argument domain so the machine's settings never change.
// One launch per clock, so on any Mac one of them reads against the machine's own setting and
// proves the launch's setting, and not the machine's, is what main read. When macOS posts that
// the locale settings changed, main reads them again and pushes the clock it read.

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
    it.each([
      { force24HourTime: "YES", force12HourTime: "NO", hourCycle: "h23" },
      { force24HourTime: "NO", force12HourTime: "YES", hourCycle: "h12" },
    ] as const)(
      "carries $hourCycle from the launch's setting, and again on each change notice",
      async ({ force24HourTime, force12HourTime, hourCycle }) => {
        await withLaunchedApp(
          {
            macUserDefaults: {
              AppleLocale: "en_US",
              AppleLanguages: "(en-US)",
              AppleICUForce24HourTime: force24HourTime,
              AppleICUForce12HourTime: force12HourTime,
            },
          },
          async (appUnderTest) => {
            const facts = await appUnderTest.consolePage.evaluate(
              (): AppFacts =>
                (window as unknown as { desktopBridge: PreloadApi }).desktopBridge.app,
            );

            expect(facts.locale).toBe("en-US");
            expect(facts.regionLocale).toBe("en-US");
            expect(facts.hourCycle).toBe(hourCycle);

            // The page's first delivery is the clock it holds; the second can come only from main,
            // which pushes a clock only after reading it again.
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

            const clock = { regionLocale: "en-US", hourCycle };
            expect(await delivered).toStrictEqual([clock, clock]);
          },
        );
      },
    );
  },
);
