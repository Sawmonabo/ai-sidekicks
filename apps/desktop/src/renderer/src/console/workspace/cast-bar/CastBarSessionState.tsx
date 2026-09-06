// The wire's own session state, as a chip.
//
// Its own module for the one-component rule. It is where the read's three arms are
// turned into what a person sees, which is a decision — the refusal is rendered
// rather than swallowed — and not the header's arrangement of elements.
//
// WHY THE STATE IS A CHIP AND NOT A WORD IN THE HEADER'S PROSE. It is a closed
// six-value wire vocabulary — `provisioning | active | archived | closed |
// purge_requested | purged` — and the console renders it VERBATIM, including the
// underscore. Re-casing it to "Purge requested" would be this renderer editing a wire
// value, which the figure rules forbid; a chip in mono is the shape that carries an
// unedited wire word without looking like a typo.

import { type GrowthSessionSummary } from "../../bridge/index.js";
import { Chip, InlineRefusal, Nothing } from "../../primitives/index.js";
import { type CastBarReadState } from "./cast-bar-reads.js";

export interface CastBarSessionStateProps {
  readonly identity: CastBarReadState<GrowthSessionSummary>;
}

/**
 * The wire's own session state.
 *
 * Three arms, and they are the three facts: the state, the read still in flight, and
 * the refusal. The refusal is RENDERED rather than swallowed, because a bar that
 * showed an id with no state beside it is indistinguishable from one whose session is
 * genuinely `active` — and only one of those is something the console established.
 *
 * Inline is the shape rule 9 assigns it: a read that did not answer changed nothing.
 * The session is what it was, the id beside it is still true, and the operator can
 * put the question again by reopening the session. A card would file this in the
 * ledger as something that happened to the session, and a banner would say the whole
 * room can no longer do something — and neither is true of a read that failed.
 *
 * `tone="neutral"` on every state, including `purged`. A chip coloured by which state
 * it carries would be this bar deciding which session states are alarming, on a
 * surface whose one colour rule spends hue on identity.
 */
export function CastBarSessionState(props: CastBarSessionStateProps): React.JSX.Element {
  const { identity } = props;
  if (identity.status === "reading") {
    return <Nothing kind="not-loaded" title="Reading this session's state." />;
  }
  if (identity.status === "unavailable") {
    return <InlineRefusal code={identity.refusal.code} detail={identity.refusal.detail} />;
  }
  return <Chip tone="neutral" mono label={identity.value.state} />;
}
