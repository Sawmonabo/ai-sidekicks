// The renderer unit tier's workflow checks: compiles the module the app's markdown worker compiles,
// from the package's built file, and hands it to the checks, as the worker's connection does in the
// app, before any suite draws a form. No worker runs in the tier to compile it.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { provideWorkflowCheckModule } from "@ai-sidekicks/contracts/workflow/definition/check";

provideWorkflowCheckModule(
  new WebAssembly.Module(
    readFileSync(
      createRequire(import.meta.url).resolve(
        "@ai-sidekicks/contracts/workflow/definition/check.wasm",
      ),
    ),
  ),
);
