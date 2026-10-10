// The search a provider's default command falls back to after the login shell's PATH: the Node
// version managers' folders are searched, of several builds the newest runs, each build's version
// read once, and a build found there runs with its folder first on its search path, so a Node
// script finds the Node installed beside it.

import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ProviderCommandSearch } from "../command-search.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../operating-system/darwin.js";
import { resolveProviderExecutable } from "../spawned-version.js";

// Names no real install answers to, so no build or Node already on this machine joins the search.
const COMMAND = "provider-under-search";
const NODE = "provider-under-search-node";

const runProgram = promisify(execFile);

let home: string | undefined;

afterEach(async () => {
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("ProviderCommandSearch", () => {
  it("runs the newest build, a Node script in nvm's folders, under the Node beside it", async () => {
    home = await mkdtemp(join(tmpdir(), "aisk-command-search-"));
    const versionReads = join(home, "version-reads");
    const printVersion = (version: string): string =>
      `echo read >> '${versionReads}'\necho 'provider-cli ${version}'\n`;
    const writeProgram = async (file: string, text: string): Promise<void> => {
      await writeFile(file, text);
      await chmod(file, 0o755);
    };
    // As npm installs one: the command links to a script deep in the version's packages, which
    // names its interpreter on its `#!` line, and that version's `node` sits beside the command.
    const installNodeScript = async (nodeVersion: string, version: string): Promise<string> => {
      const versionFolder = join(home ?? "", ".nvm", "versions", "node", nodeVersion);
      const commandFolder = join(versionFolder, "bin");
      const packageFolder = join(versionFolder, "lib", "node_modules", "provider-cli");
      await mkdir(commandFolder, { recursive: true });
      await mkdir(packageFolder, { recursive: true });
      const script = join(packageFolder, "cli.js");
      await writeProgram(script, `#!/usr/bin/env ${NODE}\n${printVersion(version)}`);
      await symlink(script, join(commandFolder, COMMAND));
      await writeProgram(join(commandFolder, NODE), '#!/bin/sh\nexec /bin/sh "$@"\n');
      return script;
    };
    // The installer's folder is searched first but holds an older build than one version's.
    const installerFolder = join(home, ".local", "bin");
    await mkdir(installerFolder, { recursive: true });
    await writeProgram(join(installerFolder, COMMAND), `#!/bin/sh\n${printVersion("0.150.0")}`);
    await installNodeScript("v18.20.0", "0.149.0");
    const newestScript = await installNodeScript("v24.21.0", "0.156.0");
    const serviceLog: string[] = [];
    const commandSearch = new ProviderCommandSearch({
      operatingSystem: DARWIN_PROVIDER_OPERATING_SYSTEM,
      homeDirectory: home,
      writeServiceLog: (line) => serviceLog.push(line),
    });
    const environment = [["PATH", "/usr/bin:/bin"]] as const;

    const first = await resolveProviderExecutable("codex", COMMAND, environment, {
      commandSearch,
    });
    const second = await resolveProviderExecutable("codex", COMMAND, environment, {
      commandSearch,
    });

    expect(first.resolvedExecutablePath).toBe(await realpath(newestScript));
    expect(second.resolvedExecutablePath).toBe(first.resolvedExecutablePath);
    const reads = (await readFile(versionReads, "utf8")).split("\n").filter((line) => line !== "");
    expect(reads).toHaveLength(3);
    expect(serviceLog).toStrictEqual([]);
    const { stdout } = await runProgram(
      first.start.program,
      [...first.start.leadingArguments, "--version"],
      { env: Object.fromEntries(first.environment) },
    );
    expect(stdout.trim()).toBe("provider-cli 0.156.0");
  });
});
