// The one control that brings in the rest of an output: it names how much there is before the
// press, says the read is out while one runs, and offers the press again when the read failed. A
// caller that opens the rest without a read never leaves the first state. A copy never takes its
// words: a selection's part drops every button drawn among it.

import "./FullOutputControl.css";

import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { type FigureSentencePart } from "#renderer/lib/figure-sentence.js";

/** Where the rest of an output stands: offered, being read, or refused and offered again. */
export type FullOutputReading = "rest" | "reading" | "refused";

/** What the control says and does. */
export interface FullOutputControlProps {
  /** What the rest measures, drawn as the figure in `Show full output (<measure>)`. */
  readonly measure: FigureSentencePart;
  /** Where the read stands; a caller that opens the rest with no read stays at `rest`. */
  readonly reading: FullOutputReading;
  /** Brings the rest in, handed the pressed control; called at rest and on a refused read. */
  readonly onPress: (control: HTMLElement) => void;
}

/** `Show full output (840 KiB)`, `Loading the full output…`, or the refused read's retry. */
export function FullOutputControl(props: FullOutputControlProps): React.JSX.Element {
  const { onPress, reading } = props;
  return (
    <button
      type="button"
      className="meridian-full-output"
      data-reading={reading}
      // A read out is not pressed again; the control keeps its focus and its place.
      aria-disabled={reading === "reading"}
      onClick={(event) => {
        if (reading !== "reading") {
          onPress(event.currentTarget);
        }
      }}
    >
      {reading === "reading" ? (
        "Loading the full output…"
      ) : reading === "refused" ? (
        "Couldn't load the full output · Retry"
      ) : (
        <>
          Show full output (<FigureSentence parts={[props.measure]} />)
        </>
      )}
    </button>
  );
}
