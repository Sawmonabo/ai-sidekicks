// The compile-time fixture gate main, the preload and the renderer all read. The fixture
// composition, the fixture bridge and every scenario sit behind this `define`-substituted
// identifier so Rollup folds `if (false)` and the bodies are absent from a release bundle; a
// runtime `process.env` check would ship them.

/**
 * `true` only in a build that carries the scenario catalog: the development and fixtures builds.
 * The `define` block substitutes it textually before parsing, so it is a literal at build time,
 * never a variable read.
 */
declare const __FIXTURE_BUILD__: boolean;
