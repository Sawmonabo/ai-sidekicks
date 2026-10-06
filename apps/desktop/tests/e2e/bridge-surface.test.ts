// The bridge the console document holds, read from the console document of an app launched beside a
// background service of the test's own. `window.desktopBridge` has exactly the members of
// `PreloadApi`, each of the kind the type gives it, and no member at any depth is named for auth
// material. The `daemon.status` topic carries main's link to that service to the console document,
// through the real preload and main, with no key of what it delivers named for auth material
// either. Once linked, `machineSettings.read()` reaches that service's settings verb and answers
// the defaults of its fresh home folder. Neither side holds the other's object: an appearance the
// page changes after sending it, and a record main handed it that the page changes, leave main's
// kept record as sent.

import { describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";

import type { AppFacts } from "#shared/app-facts.js";
import type { AppearanceChoice, AppearanceRecord, TextSize } from "#shared/appearance.js";
import type { MainProcessState } from "#shared/daemon/status-topic.js";
import { createStubBridge, type PreloadApi } from "#shared/preload-api.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

/** The names a bridge member carrying auth material would have. */
const AUTH_MATERIAL_NAME = /token|dpop|secret/i;

/** Every key, at any depth, of `value` that is named for auth material. */
function authMaterialNames(value: unknown): string[] {
  const names: string[] = [];
  JSON.stringify(value, (name: string, member: unknown) => {
    names.push(name);
    return member;
  });
  return names.filter((name) => AUTH_MATERIAL_NAME.test(name));
}

/**
 * A `JSON.stringify` replacer that keeps every object and writes each other member as its kind,
 * so two bridges compare by member names and kinds. The page evaluates its own copy, since a
 * function cannot cross into it.
 */
function memberKind(_name: string, value: unknown): unknown {
  return typeof value === "object" && value !== null ? value : typeof value;
}

/**
 * Facts of every kind `AppFacts` declares. The stub's `app` is built from this literal, so it
 * holds exactly the type's members.
 */
const SAMPLE_APP_FACTS: AppFacts = {
  version: "",
  platform: "darwin",
  arch: "arm64",
  locale: "",
  physicalMemoryBytes: 0,
};

describe.skipIf(!bundleIsBuilt)("end-to-end — the bridge surface", () => {
  it("matches PreloadApi, names no member for auth material, carries main's link state, reads the settings, and shares no object with main", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const pageSurface = await appUnderTest.consolePage.evaluate(() =>
        JSON.stringify(
          (window as unknown as { desktopBridge: unknown }).desktopBridge,
          (_name: string, value: unknown) =>
            typeof value === "object" && value !== null ? value : typeof value,
        ),
      );

      // The stub is `PreloadApi` as an object literal, so it has exactly the type's members.
      expect(JSON.parse(pageSurface)).toStrictEqual(
        JSON.parse(JSON.stringify(createStubBridge(SAMPLE_APP_FACTS, ""), memberKind)),
      );
      const surface = JSON.parse(pageSurface) as { daemon: object };
      expect(authMaterialNames(surface)).toEqual([]);
      // The control: the same walk finds a name planted inside one of the surface's members.
      expect(
        authMaterialNames({ ...surface, daemon: { ...surface.daemon, sessionToken: "string" } }),
      ).toEqual(["sessionToken"]);

      const connected = await appUnderTest.consolePage.evaluate(
        async (timeoutMs) =>
          await new Promise<MainProcessState>((resolve, reject) => {
            const bridge = (window as unknown as { desktopBridge: PreloadApi }).desktopBridge;
            const timer = setTimeout(() => {
              unsubscribe();
              reject(new Error("daemon.status never reported connected"));
            }, timeoutMs);
            const unsubscribe = bridge.daemon.subscribe(
              "daemon.status",
              {},
              (state) => {
                if (state.connection.kind === "connected") {
                  clearTimeout(timer);
                  unsubscribe();
                  resolve(state);
                }
              },
              (end) => {
                clearTimeout(timer);
                reject(new Error(`daemon.status ended: ${JSON.stringify(end)}`));
              },
            );
          }),
        appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      );

      expect(connected.connection).toEqual({ kind: "connected" });
      expect(authMaterialNames(connected)).toEqual([]);

      const reading = await appUnderTest.consolePage.evaluate(
        async (): Promise<MachineSettingsReading> =>
          await (
            window as unknown as { desktopBridge: PreloadApi }
          ).desktopBridge.machineSettings.read(),
      );
      expect(reading).toStrictEqual({ settings: MACHINE_SETTINGS_DEFAULTS });

      const textSizes = await appUnderTest.consolePage.evaluate(async () => {
        const bridge = (window as unknown as { desktopBridge: PreloadApi }).desktopBridge;
        const readKept = (): Promise<AppearanceRecord> =>
          new Promise((resolve) => {
            const stop = bridge.window.subscribeAppearance((record) => {
              stop();
              resolve(record);
            });
          });
        const kept = await readKept();
        const sent: TextSize = kept.textSize === 20 ? 18 : 20;
        const choice: { -readonly [Key in keyof AppearanceChoice]: AppearanceChoice[Key] } = {
          theme: kept.theme,
          scheme: kept.scheme,
          textSize: sent,
          transcriptWidth: kept.transcriptWidth,
        };
        await bridge.window.setAppearance(choice, { ...kept.grounds });
        choice.textSize = 15;
        const handed = await readKept();
        const handedTextSize = handed.textSize;
        (handed as { textSize: TextSize }).textSize = 16;
        const readAgain = await readKept();
        return { sent, handed: handedTextSize, readAgain: readAgain.textSize };
      });
      expect(textSizes.handed).toBe(textSizes.sent);
      expect(textSizes.readAgain).toBe(textSizes.sent);
    });
  });
});
