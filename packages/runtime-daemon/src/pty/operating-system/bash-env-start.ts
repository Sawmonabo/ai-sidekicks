// The bash start every system but macOS's own bash takes: a login shell in posix mode, which reads
// only the file `ENV` names, the marks script, which turns posix mode off, puts the person's own
// `ENV` back and runs their login files itself.

import { SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME } from "@ai-sidekicks/contracts/machine-settings";

import { readSpawnEnvValue, type SpawnEnvPair } from "../../provider/spawn-env.js";
import type { BashStart, BashStartInput } from "./contract.js";

/** Starts bash as a posix-mode login shell whose `ENV` names the marks script. */
export function startBashThroughEnv(bash: BashStartInput): BashStart {
  // The script puts the person's own `ENV` back, or erases it where none came.
  const personEnv = readSpawnEnvValue(bash.environment, "ENV", bash.environmentNameMatch);
  return {
    command: bash.shellPath,
    args: ["--posix", "-l"],
    pairs: [
      ...(personEnv === undefined
        ? []
        : [[SHELL_ORIGINAL_ENV_ENVIRONMENT_NAME, personEnv] satisfies SpawnEnvPair]),
      ["ENV", bash.scriptPath],
    ],
  };
}
