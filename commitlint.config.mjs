// commitlint 20.5.x configuration per ADR-023 §Axis 2.
//
// type-enum: 10-type set (default 11 minus `style`). Prettier auto-applies formatting via
// lint-staged, so a "pure formatting" commit shouldn't exist; use `chore(format): ...`
// if a manual formatting pass is genuinely needed (per CONTRIBUTING.md Anti-Patterns).
//
// scope-enum: required, lowercase, hyphen-only. Mirrors the package + cross-cutting nouns
// the workspace owns:
//   - per-package nouns: `contracts`, `client-sdk`, `daemon`, `control-plane`, `desktop`,
//     `sidecar-rust-pty`, `pty-sidecar-publishing`
//   - cross-cutting nouns: `repo` (workspace-root scaffolding), `deps` (dependency bumps),
//     `ci` (workflow files), `format` (manual format passes), `release` (release tooling)
//
// `daemon` is the conventional short alias for `runtime-daemon` (per CONTRIBUTING.md
// Worked Example: `feat(daemon): scaffold pnpm workspace + Turbo pipeline`).
// `sidecar-rust-pty` matches the Rust crate at `packages/sidecar-rust-pty/` (Plan-024).
// `pty-sidecar-publishing` matches the platform-package publishing dir at
// `packages/pty-sidecar-publishing/<platform>/<arch>/` (Plan-024 Phase 4 + Phase 5).

/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "build", "chore", "ci", "docs", "perf", "refactor", "revert", "test"],
    ],
    "scope-enum": [
      2,
      "always",
      [
        // Per-package nouns
        "contracts",
        "client-sdk",
        "daemon",
        "control-plane",
        "desktop",
        "sidecar-rust-pty",
        "pty-sidecar-publishing",
        // Cross-cutting nouns
        "repo",
        "deps",
        "ci",
        "format",
        "release",
      ],
    ],
    "scope-empty": [2, "never"],
    // Subject case follows config-conventional default — disallow sentence/start/
    // pascal/upper case starts (so subjects begin lowercase) but allow proper-
    // noun caps inside the subject. Strict "always lower-case" would reject valid
    // subjects like `feat(daemon): wire BLAKE3 hash chain` or `feat(contracts):
    // add PASETO v4 token shape`.
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
  },
};
