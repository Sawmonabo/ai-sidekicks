// Ambient declarations for the console's two build-time environment signals.
//
// The renderer's `tsconfig.json` sets `types: []` deliberately (no Node types in
// a browser-context program), so Vite's own `vite/client` types are not pulled
// in wholesale; the two members the console actually reads are declared here
// instead of widening that config.
//
// `__SIDEKICKS_CONSOLE_FIXTURES__` is the console's compile-time gate, sibling to
// `__SIDEKICKS_SMOKE_BUILD__`. `Spec-023 §Pitfalls To Avoid` requires the fixture
// bridge, every scenario, and the scenario switcher to sit behind a
// `define`-substituted identifier so Rollup collapses `if (false && …)` and the
// bodies are physically absent from a release bundle; a runtime `process.env`
// check around any of them is a tripwire failure, not a style choice.

/**
 * `true` only in a build that ships the console's fixture bridge and scenarios.
 * Substituted textually by Vite's `define` before parsing, so this is a literal
 * at build time and never a variable read.
 */
declare const __SIDEKICKS_CONSOLE_FIXTURES__: boolean;

interface ImportMetaEnv {
  /** Vite's development-mode flag. Used only to decide whether a tripwire throws. */
  readonly DEV: boolean;
  /** Vite's production-mode flag. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
