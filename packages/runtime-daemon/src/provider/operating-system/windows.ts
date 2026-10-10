// What the provider drivers take from Windows.

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { defaultSpawnTaskkill } from "../../pty/taskkill-windows.js";
import type {
  ProviderOperatingSystem,
  ProviderProgramFinder,
  ProviderProgramStart,
} from "./contract.js";

// The extensions of the command shims npm and pnpm write, which Windows runs only through `cmd`.
const COMMAND_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat"]);

// The script an npm or pnpm shim hands its arguments to, written relative to the shim's folder:
// `"%dp0%\…\cli.js" %*` from npm, `"%~dp0\…\cli.js" %*` from pnpm.
const SHIM_SCRIPT_PATTERN = /"%~?dp0%?\\([^"]+)"\s+%\*/g;

// A shim whose program is Node names the `node.exe` it prefers, beside the shim.
const SHIM_NODE_PATTERN = /%~?dp0%?\\node\.exe/i;

/**
 * Windows: Claude Code's managed settings under Program Files; its Bash sandbox does not run on
 * native Windows, and the system compares variable names case-insensitively, so a deny of `PATH`
 * must also catch `path`. A command shim runs as its script under Node, a child process ends with
 * its whole tree, Node opens no Unix socket, and a local socket the daemon listens on is a named
 * pipe.
 */
export const WINDOWS_PROVIDER_OPERATING_SYSTEM: ProviderOperatingSystem = {
  claudeManagedSettingsFolder: "C:\\Program Files\\ClaudeCode",
  canRunClaudeBashSandbox: false,
  environmentNameMatch: "case-insensitive",
  homeVariable: "USERPROFILE",
  // Each where its installer or manager puts it; npm's prefix holds its shims itself on Windows.
  providerCommandFolders: (place) => {
    const home = place.homeDirectory;
    const appData = place.readVariable("APPDATA") ?? `${home}\\AppData\\Roaming`;
    const localAppData = place.readVariable("LOCALAPPDATA") ?? `${home}\\AppData\\Local`;
    const npmPrefix =
      place.readVariable("npm_config_prefix") ?? place.readVariable("NPM_CONFIG_PREFIX");
    const nvmSymlink = place.readVariable("NVM_SYMLINK");
    return [
      `${home}\\.local\\bin`,
      `${localAppData}\\Programs\\OpenAI\\Codex\\bin`,
      ...(npmPrefix === undefined ? [] : [npmPrefix]),
      `${appData}\\npm`,
      place.readVariable("PNPM_HOME") ?? `${localAppData}\\pnpm`,
      `${localAppData}\\Programs\\nodejs`,
      ...(nvmSymlink === undefined ? [] : [nvmSymlink]),
      `${home}\\scoop\\shims`,
      `${home}\\.bun\\bin`,
    ];
  },
  startProviderBuild: async (build, findOnSearchPath) =>
    COMMAND_SHIM_EXTENSIONS.has(path.win32.extname(build).toLowerCase())
      ? await startCommandShim(build, findOnSearchPath)
      : { program: build, leadingArguments: [] },
  // Windows has no signal a process can answer, so a stop and a kill both end the process and
  // every process it started.
  endChildProcess: (child) => {
    if (child.pid !== undefined) {
      void defaultSpawnTaskkill(child.pid);
    }
  },
  canOpenUnixSocket: false,
  localSocketEndpoint: (folder, name) => path.win32.join("\\\\?\\pipe", folder, name),
  // A named pipe ends with the server that made it, so a stopped daemon leaves nothing there.
  prepareLocalSocketEndpoint: () => Promise.resolve(),
  // A double-quoted word for `cmd.exe`; a Windows path holds no double quote.
  quoteShellWord: (word) => `"${word}"`,
};

/**
 * The script an npm or pnpm command shim runs, relative to the shim's folder, read from the
 * shim's text; `undefined` for a shim that runs no script under Node.
 */
export function readCommandShimScript(shimText: string): string | undefined {
  const script = [...shimText.matchAll(SHIM_SCRIPT_PATTERN)].at(-1)?.[1];
  return script !== undefined && SHIM_NODE_PATTERN.test(shimText) ? script : undefined;
}

// Node refuses to start a `.cmd` without a shell, and a shell would read the provider's arguments
// as its own syntax, so the shim's script runs under the Node the shim names: its own `node.exe`,
// else the first `node` on the search path.
async function startCommandShim(
  shim: string,
  findOnSearchPath: ProviderProgramFinder,
): Promise<ProviderProgramStart> {
  const script = readCommandShimScript(await readFile(shim, "utf8"));
  if (script === undefined) {
    throw new Error(`${shim} is not an npm or pnpm shim of a Node script, so it cannot be started`);
  }
  const shimFolder = path.win32.dirname(shim);
  const besideNode = path.win32.join(shimFolder, "node.exe");
  const node = (await isPresent(besideNode)) ? besideNode : await findOnSearchPath("node");
  if (node === undefined) {
    throw new Error(`${shim} runs its script under Node, and no node is on its search path`);
  }
  return { program: node, leadingArguments: [path.win32.resolve(shimFolder, script)] };
}

async function isPresent(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
