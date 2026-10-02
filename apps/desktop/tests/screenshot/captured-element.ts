// The element a capture is taken of, or a throw. A capture precondition every feature's suite
// shares: a capture aid that photographs nothing and says nothing is worse than one that
// refuses. Not a test file.

/**
 * The element a capture is taken of, or a throw. A throw rather than assert-then-return-early,
 * which would let "the element did not mount" pass having screenshotted nothing.
 */
export function requireCapturedElement(container: HTMLElement, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(
      `the app rendered no ${selector} element, so there is nothing for this tier to capture`,
    );
  }
  return element;
}
