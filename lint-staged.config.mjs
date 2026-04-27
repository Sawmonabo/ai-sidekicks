// lint-staged 16.4.x configuration per ADR-023 §Axis 2.
// Function-form lets us run `tsc -b --noEmit` once on the workspace
// (file-level invocation defeats project-references incremental rechecking).
// ESM file (`.mjs`) per lint-staged v16 auto-detection of "type": "module".

/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,tsx,mts,cts}": [
    "eslint --fix --cache",
    // Composite project-references require referenced projects to emit; `tsc -b` is the
    // canonical typecheck primitive in that mode (see TS6310). Outputs land in `dist/` which
    // is gitignored. We invoke once on the whole workspace (file-level invocation defeats
    // project-references incremental rechecking).
    () => "tsc -b",
  ],
  "*.{js,mjs,cjs,jsx}": [
    "eslint --fix --cache",
  ],
  "*.{json,md,yml,yaml,css,scss}": [
    "prettier --write",
  ],
};
