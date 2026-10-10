// The one control that brings in the rest of an output. A body read in full when pressed names how
// much there is before the press, says the read is out while one runs, and offers the press again
// when the read failed; an output already held, cut at the visible flow, reads `Show all` and never
// leaves that state. A copy never takes its words: a selection's part drops every button drawn
// among it.

import "./FullOutputControl.css";

import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { type FigureSentencePart } from "#renderer/lib/figure-sentence.js";

/** Where the rest of an output stands: offered, being read, or refused and offered again. */
export type FullOutputReading = "rest" | "reading" | "refused";

/** What the control says and does. */
export interface FullOutputControlProps {
  /**
   * What a body read when pressed measures, drawn as the figure in `Show full output (<measure>)`;
   * absent for an output already held, which reads `Show all`.
   */
  readonly measure?: FigureSentencePart | undefined;
  /** Where the read stands; a caller that opens the rest with no read stays at `rest`. */
  readonly reading: FullOutputReading;
  /** Brings the rest in; called at rest and on a refused read. */
  readonly onPress: () => void;
}

/**
 * `Show all`, `Show full output (840 KiB)`, `Loading the full output…`, or the refused read's
 * retry.
 */
export function FullOutputControl(props: FullOutputControlProps): React.JSX.Element {
  const { onPress, reading } = props;
  return (
    <button
      type="button"
      className="meridian-full-output"
      data-reading={reading}
      // A read out is not pressed again; the control keeps its focus and its place.
      aria-disabled={reading === "reading"}
      onClick={() => {
        if (reading !== "reading") {
          onPress();
        }
      }}
    >
      {reading === "reading" ? (
        "Loading the full output…"
      ) : reading === "refused" ? (
        "Couldn't load the full output · Retry"
      ) : props.measure === undefined ? (
        "Show all"
      ) : (
        <>
          Show full output (<FigureSentence parts={[props.measure]} />)
        </>
      )}
    </button>
  );
}
