// The next move under a refusal, in the region the `action` prop fills.
//
// ONE COMPONENT FOR EVERY TABLE. `refusal-props.ts` makes `action` a prop the caller fills,
// and the three refusal shapes render whatever node arrives there. What arrives has the
// same shape from every table: a sentence, then the exclusive alternatives where one
// code stands for more than one situation. The props name no repo, no mount and no
// artifact: they take the one `RefusalRemedy` model.
//
// IT RENDERS NOTHING FOR A CODE WITH NO MOVE, and that is deliberate rather than
// defensive: a refusal nobody has a remedy for shows the daemon's own code and sentence
// and stops there, which is more honest than a line of filler under every one. A caller
// with neither a remedy nor children does not render this at all.
//
// CHILDREN ARE INSIDE THE REGION AND NOT BESIDE IT. One code's remedy names data the
// refusal itself carried — the manifests a blocked delete listed — and a component that made
// the caller render that as a sibling would let the two be composed apart: a sentence
// reading "delete the derivatives named below" with nothing below it is the rendering
// this composition exists to prevent.

import "./Refusal.css";

import type { RefusalRemedy } from "@renderer/lib/refusal-remedies.js";

export interface RefusalRemedyContentProps {
  /** What is known to do about the code, or nothing where nothing is. */
  readonly remedy?: RefusalRemedy | undefined;
  /** What the refusal itself carried, rendered inside the same region as the move. */
  readonly children?: React.ReactNode;
}

/**
 * The remedy under a refusal: its next move and any exclusive cases.
 *
 * @consumedBy a refusal that offers the person a remedy
 */
export function RefusalRemedyContent(props: RefusalRemedyContentProps): React.JSX.Element {
  const { remedy, children } = props;
  const distinctions = remedy !== undefined && "distinctions" in remedy ? remedy.distinctions : [];
  return (
    <div className="meridian-refusal-remedy">
      {remedy === undefined ? null : (
        <p className="meridian-refusal-remedy__move">{remedy.nextMove}</p>
      )}
      {distinctions.length === 0 ? null : (
        // A LIST BECAUSE THE CASES ARE EXCLUSIVE. A code that carries these covers
        // several situations a person chooses between; run together as prose they would
        // read as steps to perform in order.
        <ul className="meridian-refusal-remedy__cases">
          {distinctions.map((distinction) => (
            <li key={distinction}>{distinction}</li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}
