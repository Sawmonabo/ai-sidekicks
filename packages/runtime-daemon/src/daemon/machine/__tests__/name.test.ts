// This machine's friendly name: the Linux form runs here from stand-in files, and the macOS form
// against the real `scutil` when the tests run on a Mac.

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createNodeMachineNameSources, readMachineName, type MachineNameSources } from "../name.js";

function sources(
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>>,
): MachineNameSources {
  return {
    platform,
    runCommand: () => Promise.reject(new Error("no program runs on this platform")),
    readTextFile: (filePath) => Promise.resolve(files[filePath]),
    readHostname: () => "build-host",
  };
}

describe("readMachineName", () => {
  it.runIf(process.platform === "darwin")(
    "reads the computer name scutil reports on macOS",
    async () => {
      const computerName = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
      }).trim();

      expect(await readMachineName(createNodeMachineNameSources())).toBe(computerName);
    },
  );

  it("reads PRETTY_HOSTNAME on Linux, unquoting it, and falls back to the static hostname", async () => {
    const machineInfo =
      '# set by hostnamectl\nCHASSIS=laptop\nPRETTY_HOSTNAME="Ana\\"s \\\\ laptop"\n';
    expect(
      await readMachineName(
        sources("linux", { "/etc/machine-info": machineInfo, "/etc/hostname": "ana-laptop\n" }),
      ),
    ).toBe('Ana"s \\ laptop');
    expect(
      await readMachineName(
        sources("linux", {
          "/etc/machine-info": "CHASSIS=laptop\n",
          "/etc/hostname": "ana-laptop\n",
        }),
      ),
    ).toBe("ana-laptop");
    expect(await readMachineName(sources("linux", { "/etc/hostname": "ana-laptop\n" }))).toBe(
      "ana-laptop",
    );
  });

  it("refuses an empty name rather than inventing one", async () => {
    await expect(readMachineName(sources("linux", { "/etc/hostname": "\n" }))).rejects.toThrow(
      "This machine's name is empty",
    );
  });
});
