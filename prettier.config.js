// Prettier 3 per ADR-022 §Decision row 5.
// Defaults except a few project-wide preferences locked here so editors agree.
/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
  proseWrap: "never",
};
