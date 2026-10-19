// Desktop main and the Rust daemon resolve the run folder by the same rule, each asserting the same
// cases, so the two cannot drift into looking for the socket in different folders.
import { describe, expect, it } from "vitest";

import { resolveDaemonRunFolder } from "../run-folder.js";

describe("the run folder on macOS and Linux", () => {
  it.each([
    ["linux", "/run/user/1000", "/home/ada", "/run/user/1000/ai-sidekicks"],
    ["linux", "/run/user/1000/", "/home/ada", "/run/user/1000/ai-sidekicks"],
    ["linux", "", "/home/ada", "/home/ada/.ai-sidekicks/run"],
    ["linux", undefined, "/home/ada/", "/home/ada/.ai-sidekicks/run"],
    ["darwin", "/run/user/1000", "/Users/ada", "/Users/ada/.ai-sidekicks/run"],
    ["darwin", undefined, "/Users/ada", "/Users/ada/.ai-sidekicks/run"],
  ] as const)(
    "on %s with the runtime folder %j and the home folder %s resolves %s",
    (platform, runtimeDirectory, homeDirectory, folderPath) => {
      const resolved = resolveDaemonRunFolder({ platform, runtimeDirectory, homeDirectory });

      expect(resolved).toEqual({
        folderPath,
        socketPath: `${folderPath}/daemon.sock`,
        tokenPath: `${folderPath}/daemon.token`,
      });
    },
  );
});

describe("the run folder on Windows", () => {
  it.each([
    ["C:\\Users\\Ada\\AppData\\Local", "C:\\Users\\Ada\\AppData\\Local\\ai-sidekicks\\run"],
    ["D:\\Profiles\\Ada\\Local\\", "D:\\Profiles\\Ada\\Local\\ai-sidekicks\\run"],
  ])("under %s resolves %s", (localAppDataDirectory, folderPath) => {
    const userSid = "S-1-5-21-1004336348-1177238915-682003330-1001";

    const resolved = resolveDaemonRunFolder({ localAppDataDirectory, userSid });

    expect(resolved).toEqual({
      folderPath,
      socketPath: `\\\\.\\pipe\\ai-sidekicks-${userSid}`,
      tokenPath: `${folderPath}\\daemon.token`,
    });
  });
});
