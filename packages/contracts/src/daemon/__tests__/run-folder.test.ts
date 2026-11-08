// Desktop main and the Rust daemon resolve the run folder by the same rule, each reading this case
// table, so the two cannot drift into looking for the socket in different folders.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { resolveDaemonRunFolder } from "../run-folder.js";

// Parsed, not cast, so a row naming any other system fails here as it fails the Rust suite.
const runFolderCaseTable = z
  .object({
    posix: z.array(
      z
        .object({
          system: z.enum(["darwin", "linux"]),
          runtimeFolder: z.string().nullable(),
          home: z.string(),
          folder: z.string(),
        })
        .strict(),
    ),
    windows: z.array(
      z
        .object({
          localAppData: z.string(),
          userSid: z.string(),
          folder: z.string(),
          pipe: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const runFolderCases = readCaseTable(runFolderCaseTable, "run-folder.json");

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
