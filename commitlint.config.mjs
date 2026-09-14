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
      1,
      "always",
      [
        // Per-package nouns
        "contracts",
        "crypto-paseto",
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
    "scope-empty": [1, "never"],
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
