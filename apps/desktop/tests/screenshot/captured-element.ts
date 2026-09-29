// The element a capture is taken of, or a throw.
//
// All that is left of what used to be this tier's baseline-host reading. The tier
// compares nothing now — it writes a capture of every surface into the gitignored
// `__screenshots__/` so a person can look at the console without running Electron —
// so the host pin, the skip guard, the reason it printed, and the reserved
// never-committed capture name went with the comparison they existed for.
//
// This one function stays because it is a CAPTURE precondition rather than a
// comparison one: a capture aid that photographs nothing and says nothing is worse
// than one that refuses, and every family's suite reaches for the same throw.
//
// Not a test file — no `include` glob reaches it.

/**
 * The element a capture is taken of, or a throw.
 *
 * A throw rather than the assert-then-return-early shape, which turns "the surface did
 * not mount" into a test that passes having screenshotted nothing.
 */
export function requireCapturedElement(container: HTMLElement, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(
      `the console rendered no ${selector} element, so there is nothing for this tier to capture`,
    );
  }
  return element;
}
