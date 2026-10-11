// The daemon's `git`, found along the login shell's PATH: never in a relative PATH entry, where a
// planted `git.exe` in the daemon's working folder would run.

import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAC_PROVIDER_OPERATING_SYSTEM } from "../../provider/operating-system/mac.js";
import { findGitExecutable } from "../process.js";

describe("findGitExecutable", () => {
  it("passes over a relative PATH entry for the absolute git after it", async () => {
    const absoluteFolder = join("/", "usr", "bin");
    const found = await findGitExecutable(
      [["PATH", [".", "tools", absoluteFolder].join(delimiter)]],
      {
        operatingSystem: MAC_PROVIDER_OPERATING_SYSTEM,
        isExecutableFile: () => Promise.resolve(true),
      },
    );

    expect(found).toBe(join(absoluteFolder, "git"));
  });
});
