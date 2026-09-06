import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import {
  CLIPPING_OVERFLOW_VALUES,
  PaneGeometryPublisher,
  type ClippingOverflowValue,
} from "./geometry-publisher.js";
import { PaneOcclusionRegistry } from "./occlusion-registry.js";
import type { PaneRect } from "./pane-geometry.js";
import { elementWithRect, RecordingViewHost, rect } from "./geometry-publisher.test-support.js";

// Which ancestors clip, and the shape the answer is declared in.
//
// The set was a module-level `Set` singleton, which `apps/desktop/AGENTS.md` rejects.
// The declaration is a tuple now, and these are the two claims the move has to keep:
// the values that clip still clip and the ones that do not still do not, and the
// union a reader derives is still closed over exactly the tuple.
describe("PaneGeometryPublisher — the ancestors that clip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Report one computed `overflow` for ONE element and `visible` for every other.
   *
   * Scoped rather than blanket, because the walk runs to the document root: a blanket
   * answer makes `body` and the document element clippers too, and both report the
   * zero box an unlaid-out environment gives them — so every case would read a pane
   * clipped to nothing whichever value it named, which is no test at all.
   */
  function withComputedOverflow(clipper: Element, overflow: string): void {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (subject: Element) =>
        (subject === clipper
          ? { overflowX: overflow, overflowY: overflow }
          : { overflowX: "visible", overflowY: "visible" }) as CSSStyleDeclaration,
    );
  }

  /**
   * The pane's published rectangle under one ancestor whose box is half its width,
   * with that ancestor reporting the named `overflow`.
   */
  function publishedRectUnder(overflow: string): PaneRect | undefined {
    const clipper = elementWithRect(rect(0, 0, 50, 100));
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    clipper.append(hostElement);
    withComputedOverflow(clipper, overflow);
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new PaneOcclusionRegistry({ clock }),
    });
    publisher.observe(hostElement);
    clock.runFrame();
    publisher.dispose();
    clipper.remove();
    return host.samples[0]?.rect;
  }

  it.each([...CLIPPING_OVERFLOW_VALUES])("subtracts an ancestor whose overflow is %s", (value) => {
    expect(publishedRectUnder(value)).toStrictEqual(rect(0, 0, 50, 100));
  });

  it.each(["visible", "", "revert-layer", "hiddenish"])(
    "leaves the pane's own box alone under an ancestor whose overflow is %o",
    (value) => {
      // The empty string is the case the positive set exists for: a stylesheet-free
      // document reports it for every box, and a `!== "visible"` reading would clip
      // every pane to nothing and look exactly like a pane that never attached.
      expect(publishedRectUnder(value)).toStrictEqual(rect(0, 0, 100, 100));
    },
  );

  it("negative control: the union is closed over exactly the tuple", () => {
    // A type-level foil, and it is the control on the declaration rather than on the
    // behaviour: adding a sixth value to the tuple without adding it here fails to
    // compile, and so does naming one here that the tuple does not hold. Without it
    // the cases above would pass over a tuple that had quietly grown a member no
    // reader knew about.
    const everyClippingValue = {
      hidden: true,
      clip: true,
      scroll: true,
      auto: true,
      overlay: true,
    } satisfies Record<ClippingOverflowValue, true>;

    expect(Object.keys(everyClippingValue).toSorted()).toStrictEqual(
      [...CLIPPING_OVERFLOW_VALUES].toSorted(),
    );
  });
});
