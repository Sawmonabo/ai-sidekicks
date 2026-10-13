// Generates the contracts' TypeScript from the Rust contracts' emit folder: one file per contract
// module at `<output root>/<module path>.ts`.
// Usage: node --experimental-strip-types generator/generate.ts <emit folder> [output root = src]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readContractEmit } from "./emit-folder.ts";
import { writeModuleFile } from "./module-file.ts";

const [emitFolder, outputRoot = "src"] = process.argv.slice(2);
if (emitFolder === undefined) {
  throw new Error("usage: generate.ts <emit folder> [output root]");
}
const emit = readContractEmit(resolve(emitFolder));
const allSchemas = emit.modules.map((module) => module.schema);
for (const module of emit.modules) {
  const file = join(resolve(outputRoot), `${module.path}.ts`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await writeModuleFile(module, allSchemas, emit.refusalCodes));
}
console.log(`generated ${emit.modules.length} contract modules into ${resolve(outputRoot)}`);
