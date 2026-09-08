// What the control plane said about an invitation, and what it means for this reader.
//
// BOTH, ALWAYS, AND IN THAT ORDER. The code and the message the wire sent print
// verbatim, and the console's sentence sits beside them — a surface showing only the
// sentence would be answering for a control plane it cannot see, and one showing only
// the code would hand a person a string to search for.
//
// A CODE WITH NO REGISTERED MEANING STILL RENDERS. The wire's message carries it, and
// the console adds nothing rather than guessing, which is what keeps a refusal raised
// by some other subsystem out of the invite plane's own table.
//
// ONE COMPONENT FOR TWO PATHS, hoisted on this package's second-use rule the moment a
// refused PREVIEW needed the same pair a refused ACCEPTANCE already had. The two
// refusals are different facts — one is about the link, the other about the attempt on
// it — but the words are read the same way, and the acceptance table is what supplies
// the sentence for both: `invite.preview` is registered with accept-aligned refusal
// ordering, so a code refusing a preview means for this reader exactly what it means
// refusing an acceptance. A second copy of the pair would be two renderings of one
// fact, free to drift the first time either is styled.
//
// IT RENDERS A FRAGMENT AND NOT A BLOCK, deliberately: each caller owns the section
// its words sit in — the outcome's own `__body`, the preview's — and a wrapper here
// would put a second box inside one of them.

import { WireFigure } from "../../primitives/index.js";
import { inviteAcceptanceMeaning } from "./invite-refusal-copy.js";

export interface InviteRefusalWordsProps {
  /** The wire's own code, printed verbatim. */
  readonly code: string;
  /** The wire's own message, printed beside it. */
  readonly detail: string;
}

export function InviteRefusalWords(props: InviteRefusalWordsProps): React.JSX.Element {
  const meaning = inviteAcceptanceMeaning(props.code);
  return (
    <>
      <p className="meridian-invite-outcome__wire">
        <WireFigure value={props.code} />
        <span className="meridian-invite-outcome__detail">{props.detail}</span>
      </p>
      {meaning === undefined ? null : <p className="meridian-invite-outcome__meaning">{meaning}</p>}
    </>
  );
}
