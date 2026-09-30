// The console's one place that shadows `offsetHeight`; it decides only install and restore.
//
// The unit tier runs under happy-dom, which has no layout engine and reports every box as zero,
// and `@tanstack/react-virtual` reads the scroller's viewport and each row's height through
// `offsetHeight`. A zero-height scroller correctly shows no rows, so a happy-dom case that asserts
// about a rendered row must say how tall its container is.
//
// It is parameterized by the measurement alone: each caller owns its rule (scroller class names,
// row elements, heights), but the write to `HTMLElement.prototype` is global to the environment,
// and two copies of it are two chances to leak a shadow into every later file in the same worker.
// No rendering path imports it, since a DOM monkey-patch there would be production code.

/** What one element measures, in CSS pixels. Zero is what happy-dom answers anyway. */
export type ElementHeightRule = (element: HTMLElement) => number;

/**
 * Reports the heights a browser would have laid out.
 *
 * Installing twice replaces the reading instead of stacking a second shadow.
 */
export class ElementHeightShim {
  #restore: (() => void) | undefined;

  public install(heightOf: ElementHeightRule): void {
    this.restore();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return heightOf(this);
      },
    });
    this.#restore = () => {
      if (original === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      } else {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      }
    };
  }

  public restore(): void {
    this.#restore?.();
    this.#restore = undefined;
  }
}
