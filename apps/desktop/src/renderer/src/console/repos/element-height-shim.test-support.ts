// The one place this family shadows `offsetHeight`, and the only thing it decides is
// install-and-restore.
//
// The console's unit tier runs under happy-dom, which has no layout engine and reports
// every box as zero. A virtualized list reads exactly two boxes — the scroller's, which
// is the viewport it windows against, and each rendered row's — and
// `@tanstack/react-virtual` reads both through `offsetHeight`. Against a zero-height
// scroller it answers with an empty range, which is correct and is not a bug to route
// around: a scroller with no height shows no rows. So a happy-dom case that asserts
// anything about a rendered row has to say how tall its container is.
//
// PARAMETERIZED BY THE MEASUREMENT AND BY NOTHING ELSE. The diff pane and the restore
// disclosure window different lists — different scroller class names, different row
// elements, different heights, and the diff additionally grows one row when the wrap
// toggle is on — so the RULE is each caller's. What is not each caller's is the shadow:
// this class writes a property on `HTMLElement.prototype`, which is global to the
// environment, and two independent copies of that write are two chances for one of them
// to leak a shadow into every later file in the same worker. Written twice, they were.
//
// IT IS IMPORTED BY NO RENDERING PATH, and the FILE NAME is what says so. A shim of this
// reach called from a rendering path would be a production surface monkey-patching the
// DOM. Under the `.test-support.ts` suffix the claim stops being a sentence in a header:
// the shared source walk every architecture gate reads excludes these modules, and the
// layering gate admits them as roots precisely because their only legitimate dependents
// are the suites it removes from the graph.

/** What one element measures, in CSS pixels. Zero is what happy-dom answers anyway. */
export type ElementHeightRule = (element: HTMLElement) => number;

/**
 * Report the heights a browser would have laid out.
 *
 * Installing twice replaces the reading rather than stacking a second shadow, so a case
 * that wants a different rule says so in one line and the hook that installed the first
 * stays where it is.
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
