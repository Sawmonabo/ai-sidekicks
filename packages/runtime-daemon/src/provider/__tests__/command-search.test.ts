// The search a provider's default command falls back to after the login shell's PATH: the Node
// version managers' folders are searched, and of several builds the newest runs, each build's
// version read once.

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProviderCommandSearch } from "../command-search.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../operating-system/darwin.js";

// A name no real install answers to, so no build already on this machine joins the search.
const COMMAND = "provider-under-search";

let home: string | undefined;

afterEach(async () => {
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("ProviderCommandSearch", () => {
  it("picks the newest build in nvm's folders, reading each version once", async () => {
    home = await mkdtemp(join(tmpdir(), "aisk-command-search-"));
    const versionReads = join(home, "version-reads");
    const writeBuild = async (folder: string, version: string): Promise<void> => {
      await mkdir(folder, { recursive: true });
      const build = join(folder, COMMAND);
      await writeFile(
        build,
        `#!/bin/sh\necho read >> '${versionReads}'\necho 'provider-cli ${version}'\n`,
      );
      await chmod(build, 0o755);
    };
    // The installer's folder is searched first but holds an older build than one version's.
    await writeBuild(join(home, ".local", "bin"), "0.150.0");
    await writeBuild(join(home, ".nvm", "versions", "node", "v18.20.0", "bin"), "0.149.0");
    const newest = join(home, ".nvm", "versions", "node", "v24.21.0", "bin");
    await writeBuild(newest, "0.156.0");
    const serviceLog: string[] = [];
    const search = new ProviderCommandSearch({
      operatingSystem: DARWIN_PROVIDER_OPERATING_SYSTEM,
      homeDirectory: home,
      writeServiceLog: (line) => serviceLog.push(line),
    });
    const environment = [["PATH", "/usr/bin:/bin"]] as const;

    const first = await search.find(COMMAND, environment);
    const second = await search.find(COMMAND, environment);

    const newestBuild = await realpath(join(newest, COMMAND));
    expect(first).toBe(newestBuild);
    expect(second).toBe(newestBuild);
    const reads = (await readFile(versionReads, "utf8")).split("\n").filter((line) => line !== "");
    expect(reads).toHaveLength(3);
    expect(serviceLog).toStrictEqual([]);
  });
});
