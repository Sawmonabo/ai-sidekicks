// lint-staged 16.4.x configuration per ADR-023 §Axis 2.
// Function-form lets us run `tsc -b` once on the workspace
// (file-level invocation defeats project-references incremental rechecking).
// ESM file (`.mjs`) per lint-staged v16 auto-detection of "type": "module".

/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,tsx,mts,cts}": [
    "eslint --fix --cache",
    // Function form is REQUIRED here to suppress lint-staged's filename-append
    // behavior (lint-staged appends matched files to string commands; that
    // would invoke `tsc -b file1.ts file2.ts ...` and defeat project-references
    // incremental rechecking — TS6310). Returning a bare string from the
    // function tells lint-staged to invoke it verbatim, exactly once. Do not
    // convert to a string command.
    //
    // Composite project-references require referenced projects to emit; `tsc -b`
    // is the canonical typecheck primitive in that mode. Outputs land in
    // `dist/` which is gitignored.
    () => "tsc -b",
  ],
  "*.{js,mjs,cjs,jsx}": ["eslint --fix --cache"],
  "*.{json,md,yml,yaml,css,scss}": ["prettier --write"],
};
