// The window bindings a mounted console installs — hash routing, idle warming, the
// colour scheme, the token sheet, and the per-window UI state store.
//
// A SUB-MODULE DOOR, NOT A FAMILY DOOR. It publishes to `frame/` alone, and the
// sibling edge that earns it is `composition/`: `ConsoleFrame.tsx` takes four of
// these five modules and `ConsoleFrameHost.tsx` takes the fifth, so the directory
// folds one wire for its sibling rather than five. `frame/index.ts` re-exports the
// two calls a composition root makes from `token-installation.ts` ITSELF — a family
// door forwards from the declaring module, never through an inner barrel, which is
// what `console-no-barrel-chain` enforces.
//
// `MERIDIAN_STYLE_ELEMENT_ID` is deliberately absent. Its readers are the suites
// that assert the sheet landed exactly once, and no production module names it, so a
// door line for it would be a dead export the barrel census reports rather than
// tolerates; those suites take it from the module that both declares the id and puts
// the element in the document.
export { useHashRouteBinding } from "./hash-route-binding.js";
export { useLazyBodyIdleWarm } from "./lazy-body-warm-binding.js";
export { useSchemePreference } from "./scheme-preference.js";
export { applyConsoleScheme, installMeridianTokens } from "./token-installation.js";
export { useUiStateStore } from "./ui-state-lifecycle.js";
