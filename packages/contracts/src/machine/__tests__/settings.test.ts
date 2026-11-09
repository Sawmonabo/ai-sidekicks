// The settings the service reads from its file are what the page checks a reading against, and the
// defaults the page falls back to are the service's. The service's file read runs the same case
// table, parsed strictly here with zod; its environment-name refusals are the service's alone.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import {
  MACHINE_SETTINGS_DEFAULTS,
  validateMachineSettings,
} from "../../generated/machine/settings.js";

const machineSettingsCases = readCaseTable(
  z
    .object({
      environmentNames: z.array(
        z.object({ name: z.string(), refusal: z.string().nullable() }).strict(),
      ),
      settingsFiles: z.array(
        z
          .object({ file: z.unknown(), settings: z.record(z.string(), z.unknown()).nullable() })
          .strict(),
      ),
    })
    .strict(),
  "machine-settings.json",
);

const readSettings = machineSettingsCases.settingsFiles.flatMap(({ file, settings }) =>
  settings === null ? [] : [{ file: JSON.stringify(file), settings }],
);

describe("the generated machine settings", () => {
  it("default to what the service reads from an empty file", () => {
    expect(MACHINE_SETTINGS_DEFAULTS).toStrictEqual(
      readSettings.find(({ file }) => file === "{}")?.settings,
    );
  });

  it.each(readSettings)("take the settings the service reads from $file", ({ settings }) => {
    expect(validateMachineSettings(settings)).toBe(true);
  });
});
