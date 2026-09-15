/** @type {import("lint-staged").Configuration} */
export default {
  "*.{ts,tsx,mts,cts}": ["eslint --fix --cache", "prettier --write"],
  "*.{js,mjs,cjs,jsx}": ["eslint --fix --cache", "prettier --write"],
  "*.{json,json5,md,yml,yaml,css,scss}": ["prettier --write"],
};
