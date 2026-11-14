// Generates the contracts' TypeScript into `src/generated`: runs the Rust contracts' emit into a
// temporary folder, then writes one file per contract module at `src/generated/<module path>.ts`,
// its checks at `src/generated/checks/<module path>.ts`, and the index of every method's checks,
// formatted by the repository's Prettier, in place of everything the folder held. Generated
// modules import the hand-written ones from `src`, the folder above.
// Usage: pnpm --filter @ai-sidekicks/contracts generate
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readContractEmit } from "./emit-folder.ts";
import { METHOD_CHECKS_MODULE, methodChecksSource } from "./method-checks.ts";
import {
  checkedDefinitions,
  formatGenerated,
  GENERATED_HEADER,
  writeModuleFiles,
} from "./module-file.ts";
import { GENERATED_FOLDER } from "./module-imports.ts";
import { CHECKS_FOLDER, checksModulePath, createCheckCompiler } from "./schema-checks.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(packageRoot, "src", GENERATED_FOLDER);
const emitFolder = mkdtempSync(join(tmpdir(), "sidekicks-contracts-emit-"));
try {
  const emitRun = spawnSync(
    "cargo",
    ["run", "--quiet", "--package", "sidekicks-contracts", "--example", "emit", "--", emitFolder],
    { cwd: packageRoot, stdio: "inherit" },
  );
  if (emitRun.status !== 0) {
    throw new Error(
      `the contracts' emit failed: ${emitRun.error?.message ?? `exit status ${String(emitRun.status)}`}`,
    );
  }
  const emit = readContractEmit(emitFolder);
  const checkCompiler = createCheckCompiler(emit.modules, (module) =>
    checkedDefinitions(module, emit.modules),
  );
  // Every file is generated in memory before the folder is touched, so a run that fails while
  // generating leaves the folder as it was; a failure while writing leaves it part written.
  const files = new Map<string, string>();
  for (const module of emit.modules) {
    if (module.path.startsWith(`${CHECKS_FOLDER}/`)) {
      throw new Error(`${module.path}: a contract module sits in the checks folder`);
    }
    const written = await writeModuleFiles(module, emit.modules, emit.refusalCodes, checkCompiler);
    files.set(join(outputRoot, `${module.path}.ts`), written.module);
    if (written.checks !== undefined) {
      files.set(join(outputRoot, `${checksModulePath(module.path)}.ts`), written.checks);
    }
  }
  files.set(
    join(outputRoot, `${METHOD_CHECKS_MODULE}.ts`),
    await formatGenerated(methodChecksSource(emit.modules, GENERATED_HEADER)),
  );
  rmSync(outputRoot, { recursive: true, force: true });
  for (const [file, source] of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  console.log(`generated ${files.size} files into ${outputRoot}`);
} finally {
  rmSync(emitFolder, { recursive: true, force: true });
}
