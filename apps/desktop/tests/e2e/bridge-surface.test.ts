// The bridge the page holds, read from the page of an app launched beside a background service of
// the test's own. `window.desktopBridge` has exactly the members of `PreloadApi`, each of the kind
// the type gives it, and no member at any depth is named for auth material. The `daemon.status`
// topic carries main's link to that service to the page, through the real preload and main, with
// no key of what it delivers named for auth material either. Once linked,
// `machineSettings.read()` reaches that service's settings verb and answers the defaults of its
// fresh home folder.

import { describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";

import type { AppFacts } from "../../src/shared/app-facts.js";
import type { MainProcessState } from "../../src/shared/daemon-status-topic.js";
import { createStubBridge, type PreloadApi } from "../../src/shared/preload-api.js";
import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";

const bundleIsBuilt = fixtureBundleExists();

/** The names a bridge member carrying auth material would have. */
const AUTH_MATERIAL_NAME = /token|dpop|secret/i;

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
  it("matches PreloadApi, names no member for auth material, carries main's link state, and reads the settings", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const pageSurface = await appUnderTest.window.evaluate(() =>
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
      const memberNames: string[] = [];
      JSON.parse(pageSurface, (name: string, value: unknown) => {
        memberNames.push(name);
        return value;
      });
      expect(memberNames.filter((name) => AUTH_MATERIAL_NAME.test(name))).toEqual([]);

      const connected = await appUnderTest.window.evaluate(
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
        appUnderTest.bodyAllowance.remainingMs(),
      );

      expect(connected.connection).toEqual({ kind: "connected" });
      const deliveredKeys: string[] = [];
      JSON.stringify(connected, (key: string, value: unknown) => {
        deliveredKeys.push(key);
        return value;
      });
      expect(deliveredKeys.filter((key) => AUTH_MATERIAL_NAME.test(key))).toEqual([]);

      const reading = await appUnderTest.window.evaluate(
        async (): Promise<MachineSettingsReading> =>
          await (
            window as unknown as { desktopBridge: PreloadApi }
          ).desktopBridge.machineSettings.read(),
      );
      expect(reading).toStrictEqual({ settings: MACHINE_SETTINGS_DEFAULTS });
    });
  });
});
