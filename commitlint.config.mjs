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
        "search-ranking",
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
    // Subjects begin lowercase but may carry proper-noun caps inside, so "always lower-case"
    // would wrongly reject `feat(daemon): wire BLAKE3 hash chain`.
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
  },
};
