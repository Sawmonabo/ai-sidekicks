// The renderer unit tier's fuzzy matcher: compiles the module the app's markdown worker compiles,
// from the package's built file, and hands it to the app's matcher, as the worker's connection does
// in the app, before any suite ranks. No worker runs in the tier to compile it.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { appFuzzyMatcher } from "#renderer/lib/fuzzy-matcher.js";

appFuzzyMatcher.provide(
  new WebAssembly.Module(
    readFileSync(
      createRequire(import.meta.url).resolve("@ai-sidekicks/search-ranking/matcher.wasm"),
    ),
  ),
);
