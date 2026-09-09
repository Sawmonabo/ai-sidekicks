// One shell sentence, as elements: the console's words, and the shell's own figures.
//
// `shell-sentences.ts` decides WHAT each sentence says and which of its parts are
// values the shell reported; this decides how a part reaches the screen, and it makes
// exactly one decision per kind. That split is the whole point of the model: a
// sentence returned as a string has one way to carry a version — pasted into the prose
// — and no element to hang `Spec-023 §Console Design (Meridian)` rule 4's mono
// provenance signature on.
//
// IT FORMATS NOTHING ITSELF. A `figure` part is a byte-for-byte string the shell sent
// and goes through `WireFigure` untouched; a `count` part is a quantity and goes
// through `formatCount`, which is `primitives/figures/wire-figures.ts`' own `Intl` reading and
// the only formatter this console has. The exact number rides the element's `title`,
// which is rule 4's "no formatted figure hides the number the daemon sent" met where a
// locale's grouping would otherwise be the only thing on screen.
//
// AND IT IS NOT A SECOND `PartialRead`. That primitive's `counted-sentence` shape is a
// leading figure and a paragraph after it — one figure, always first, one shape for
// every reading. These sentences interleave, twice in one line, and the parts are the
// author's rather than the shape's, which is a different model for a different job.

import { WireFigure, formatCount } from "../../primitives/index.js";
import type { ShellSentence } from "./shell-sentences.js";

export interface ShellSentenceTextProps {
  readonly sentence: ShellSentence;
}

/** One sentence's parts, in order, each in the form its kind names. */
export function ShellSentenceText(props: ShellSentenceTextProps): React.JSX.Element {
  return (
    <>
      {props.sentence.map((part, position) => {
        // The position is the key because the parts ARE a sequence and nothing else
        // about one identifies it: two `", "` separators in a supported-versions list
        // are the same part twice, and a sentence is rebuilt whole whenever it moves.
        const key = `${String(position)}:${part.kind}`;
        if (part.kind === "words") {
          return <span key={key}>{part.words}</span>;
        }
        if (part.kind === "figure") {
          return <WireFigure key={key} value={part.value} />;
        }
        return <WireFigure key={key} value={formatCount(part.count)} title={String(part.count)} />;
      })}
    </>
  );
}
