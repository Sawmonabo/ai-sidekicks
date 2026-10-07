// The compile-time flag of the builds the automated Electron tiers launch, a main-process define.
// Rollup folds every branch on it out of a build it is false in.

/**
 * `true` only in the smoke and fixtures builds, which the test tiers launch and drive: their
 * windows may stay hidden and they keep the remote-debugging switches Playwright attaches through.
 * Not the fixture flag, which the development build also turns on. The `define` block substitutes
 * it textually, and the Vitest projects set it too.
 */
declare const __TEST_TIER_BUILD__: boolean;
