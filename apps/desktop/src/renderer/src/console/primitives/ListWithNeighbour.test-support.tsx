// The roving list with something else on the page to tab to.
//
// The steal the focus-claim suite is about is only observable against a second focus
// target: "focus did not move" is a claim about where it stayed, and the body is where
// focus goes when nothing holds it, which is also where a dropped claim leaves it.

import { RovingList } from "./RovingList.test-support.js";

/** The list with a neighbour. */
export function ListWithNeighbour(props: {
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
      <button type="button" data-neighbour="">
        elsewhere
      </button>
    </>
  );
}

/** The element the reader tabbed to, read back from the tree that rendered it. */
export function neighbourOf(container: HTMLElement): HTMLElement {
  const neighbour = container.querySelector<HTMLElement>("[data-neighbour]");
  if (neighbour === null) {
    throw new Error("the neighbour did not render");
  }
  return neighbour;
}
