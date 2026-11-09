// The service's own case table for the machine's settings: the file read, a missing key taking its
// default, and the environment-name rule, each run here on the same rows, parsed strictly with zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { environmentNameRefusal } from "../settings/environment-name.js";
import { parseMachineSettingsFile } from "../settings/file.js";

const machineSettingsCases = readCaseTable(
  z
    .object({
      environmentNames: z.array(
        z
          .object({
            name: z.string(),
            refusal: z.enum(["notAName", "credentialShaped", "setByApp"]).nullable(),
          })
          .strict(),
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
  settings === null ? [] : [{ fileText: JSON.stringify(file), file, settings }],
);

describe("parseMachineSettingsFile", () => {
  // Only the rows the service reads: the generated check still takes a file naming one place twice,
  // which the service refuses.
  it.each(readSettings)("reads $fileText as the service does", ({ file, settings }) => {
    expect(parseMachineSettingsFile(file)).toStrictEqual(settings);
  });
});

describe("environmentNameRefusal", () => {
  it.each(machineSettingsCases.environmentNames)(
    "answers $refusal for $name, as the service does",
    ({ name, refusal }) => {
      expect(environmentNameRefusal(name)).toBe(refusal);
    },
  );
});
