// ESLint and Prettier skip a staged file their ignore lists name, which holds every file of the
// packages the Rust port replaces; ESLint would warn about each one, so the warning is off.
// rustfmt reads no ignore list, so it is handed only the crates' Rust files.

/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,tsx,mts,cts}": ["eslint --fix --cache --no-warn-ignored", "prettier --write"],
  "*.{js,mjs,cjs,jsx}": ["eslint --fix --cache --no-warn-ignored", "prettier --write"],
  "*.{json,json5,md,yml,yaml,css,scss}": ["prettier --write"],
  "crates/**/*.rs": ["rustfmt"],
  "*.toml": ["tombi format"],
};
