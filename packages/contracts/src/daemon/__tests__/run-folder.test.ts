// Desktop main and the Rust daemon resolve the run folder by the same rule, each reading this case
// table, so the two cannot drift into looking for the socket in different folders.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveDaemonRunFolder } from "../run-folder.js";

interface RunFolderCaseTable {
  readonly posix: readonly {
    readonly system: "darwin" | "linux";
    readonly runtimeFolder: string | null;
    readonly home: string;
    readonly folder: string;
  }[];
  readonly windows: readonly {
    readonly localAppData: string;
    readonly userSid: string;
    readonly folder: string;
    readonly pipe: string;
  }[];
}

const runFolderCases = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../crates/sidekicks-contracts/tests/fixtures/run-folder.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as RunFolderCaseTable;

describe("the run folder on macOS and Linux", () => {
  it.each(runFolderCases.posix)(
    "on $system with the runtime folder $runtimeFolder and the home folder $home resolves $folder",
    ({ system, runtimeFolder, home, folder }) => {
      const resolved = resolveDaemonRunFolder({
        platform: system,
        runtimeDirectory: runtimeFolder ?? undefined,
        homeDirectory: home,
      });

      expect(resolved).toEqual({
        folderPath: folder,
        socketPath: `${folder}/daemon.sock`,
        tokenPath: `${folder}/daemon.token`,
      });
    },
  );
});

describe("the run folder on Windows", () => {
  it.each(runFolderCases.windows)(
    "under $localAppData resolves $folder",
    ({ localAppData, userSid, folder, pipe }) => {
      const resolved = resolveDaemonRunFolder({ localAppDataDirectory: localAppData, userSid });

      expect(resolved).toEqual({
        folderPath: folder,
        socketPath: pipe,
        tokenPath: `${folder}\\daemon.token`,
      });
    },
  );
});
