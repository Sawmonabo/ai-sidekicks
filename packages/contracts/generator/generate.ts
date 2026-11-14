// Generates the contracts' TypeScript into `src/generated` from the current Rust contracts, in
// place of everything the folder held.
// Usage: pnpm --filter @ai-sidekicks/contracts generate
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GENERATED_FOLDER_PATH, generatedFiles } from "./generated-files.ts";

// Every file is generated in memory before the folder is touched, so a run that fails while
// generating leaves the folder as it was; a failure while writing leaves it part written.
const files = await generatedFiles();
rmSync(GENERATED_FOLDER_PATH, { recursive: true, force: true });
for (const [path, source] of files) {
  const file = join(GENERATED_FOLDER_PATH, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}
console.log(`generated ${String(files.size)} files into ${GENERATED_FOLDER_PATH}`);
