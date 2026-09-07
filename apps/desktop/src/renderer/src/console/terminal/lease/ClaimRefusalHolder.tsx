// Who is holding the shell, read off the refusal that named them.
//
// `Spec-023 §Console Design (Meridian)` 8.8 asks a refused claim to NAME the holder
// with a manual retry, and `error-contracts.md` is what makes that possible without
// paraphrasing anyone: `pty.control_held_by_other` carries `holderParticipantId` on
// the envelope's structured context, beside the daemon's own sentence. So the code and
// the sentence render verbatim through the refusal grammar, and this is the next-move
// slot beside them.
//
// NOTHING HERE IS DERIVED. The holder is the member the refusing side sent, and the
// component is not rendered at all where it sent none — a refusal that names nobody
// keeps the daemon's sentence and gains no invented one. That is the same rule
// `lease-claim.ts` keeps for the served arm: this surface never decides who holds the
// shell, it only reads who was named.
//
// THE RETRY IS MANUAL AND SAID SO. Nothing re-issues the claim, nothing polls, and no
// control appears that would: the sentence tells a person what has to happen first,
// and the Claim control they already pressed is still there to press again.

import { DerivedFigure, WireFigure } from "../../primitives/index.js";
import type { TerminalParticipantMark } from "./participant-mark.js";

export interface ClaimRefusalHolderProps {
  /** Wire-verbatim, off the refusal's own structured context. */
  readonly holderParticipantId: string;
  /** How the wheel draws them, or `undefined` for a participant it has not admitted. */
  readonly mark: TerminalParticipantMark | undefined;
}

export function ClaimRefusalHolder(props: ClaimRefusalHolderProps): React.JSX.Element {
  const displayName = props.mark?.displayName;
  if (displayName !== undefined) {
    return (
      <DerivedFigure
        text={`${displayName} holds it. Ask them to release the shell, then claim it again.`}
      />
    );
  }
  return (
    <span className="meridian-lease-line__holder-id">
      <DerivedFigure text="Held by" /> <WireFigure value={props.holderParticipantId} />{" "}
      <DerivedFigure text="Ask them to release the shell, then claim it again." />
    </span>
  );
}
