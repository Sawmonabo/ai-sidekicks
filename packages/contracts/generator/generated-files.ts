// The files of `src/generated`, made in memory from the current Rust contracts: runs the contracts'
// emit into a temporary folder, then makes one file per contract module at `<module path>.ts` and
// its checks at `checks/<module path>.ts`, formatted by the repository's Prettier. Generated
// modules import the hand-written ones from `src`, the folder above.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readContractEmit } from "./emit-folder.ts";
import { writeModuleFiles } from "./module-file.ts";
import { GENERATED_FOLDER } from "./module-imports.ts";
import { CHECKS_FOLDER, checksModulePath, createCheckCompiler } from "./schema-checks.ts";

/** The contracts package's folder, where the emit runs. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The generated folder's path on disk. */
export const GENERATED_FOLDER_PATH: string = join(PACKAGE_ROOT, "src", GENERATED_FOLDER);

/**
 * Every file the generated folder holds, by its path under the folder. Throws when the contracts'
 * emit fails, or a contract module sits in the checks folder.
 */
export async function generatedFiles(): Promise<ReadonlyMap<string, string>> {
  const emitFolder = mkdtempSync(join(tmpdir(), "sidekicks-contracts-emit-"));
  try {
    const emitRun = spawnSync(
      "cargo",
      ["run", "--quiet", "--package", "sidekicks-contracts", "--example", "emit", "--", emitFolder],
      { cwd: PACKAGE_ROOT, stdio: ["ignore", "inherit", "inherit"] },
    );
    if (emitRun.status !== 0) {
      throw new Error(
        `the contracts' emit failed: ${emitRun.error?.message ?? `exit status ${String(emitRun.status)}`}`,
      );
    }
    const emit = readContractEmit(emitFolder);
    const checkCompiler = createCheckCompiler(emit.modules, (module) => module.checks);
    const files = new Map<string, string>();
    for (const module of emit.modules) {
      if (module.path.startsWith(`${CHECKS_FOLDER}/`)) {
        throw new Error(`${module.path}: a contract module sits in the checks folder`);
      }
      const written = await writeModuleFiles(module, emit.refusalCodes, checkCompiler);
      files.set(`${module.path}.ts`, written.module);
      if (written.checks !== undefined) {
        files.set(`${checksModulePath(module.path)}.ts`, written.checks);
      }
    }
    return files;
  } finally {
    rmSync(emitFolder, { recursive: true, force: true });
  }
}
