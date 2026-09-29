// The roving list with something else on the page to tab to.
//
// The steal the focus-claim suite is about is only observable against a second focus
// target: "focus did not move" is a claim about where it stayed, and the body is where
// focus goes when nothing holds it, which is also where a dropped claim leaves it.

import { RovingList } from "./RovingList.test-support.js";

/** The list with a neighbor. */
export function ListWithNeighbor(props: {
  readonly rowCount: number;
  readonly windowStart: number;
  readonly windowLength: number;
}): React.JSX.Element {
  return (
    <>
      <RovingList
        rowCount={props.rowCount}
        windowStart={props.windowStart}
        windowLength={props.windowLength}
        onReveal={() => undefined}
      />
      <button type="button" data-neighbor="">
        elsewhere
      </button>
    </>
  );
}

/** The element the reader tabbed to, read back from the tree that rendered it. */
export function neighborOf(container: HTMLElement): HTMLElement {
  const neighbor = container.querySelector<HTMLElement>("[data-neighbor]");
  if (neighbor === null) {
    throw new Error("the neighbor did not render");
  }
  return neighbor;
}
