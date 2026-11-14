// ESLint and Prettier skip a staged file their ignore lists name, which holds every file of the
// packages the Rust port deletes; ESLint would warn about each one, so the warning is off.
// rustfmt and Tombi read no ignore list, so rustfmt is handed only the crates' Rust files and
// Tombi every TOML file outside those packages.

import { relative } from "node:path";

const DELETED_PACKAGE_FOLDERS = [
  "packages/control-plane/",
  "packages/search-index/",
  "packages/sidecar-rust-pty/",
];

/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,tsx,mts,cts}": ["eslint --fix --cache --no-warn-ignored", "prettier --write"],
  "*.{js,mjs,cjs,jsx}": ["eslint --fix --cache --no-warn-ignored", "prettier --write"],
  "*.{json,json5,md,yml,yaml,css,scss}": ["prettier --write"],
  "crates/**/*.rs": ["rustfmt"],
  "*.toml": (stagedFiles) => {
    const keptFiles = stagedFiles.filter(
      (file) => !DELETED_PACKAGE_FOLDERS.some((folder) => relative(".", file).startsWith(folder)),
    );
    return keptFiles.length === 0
      ? []
      : [`tombi format ${keptFiles.map((file) => JSON.stringify(file)).join(" ")}`];
  },
};
