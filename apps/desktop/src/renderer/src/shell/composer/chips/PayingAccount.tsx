// Who is paying for this agent's turns, or the reason the chip cannot say.
//
// Its own module because this package declares one component per `.tsx` file, and
// because the arms below are the whole of rule 8 applied to one fact — a component
// with four absence arms inside another component is where an author eventually
// collapses two of them. The refusal's own three arms went one file further, to
// `PayingAccountRefusal.tsx`, for that same reason.

import { Chip, Nothing } from "../../../console/primitives/index.js";
import type { AgentBindingReading } from "./agent-binding-read.js";
import { PayingAccountRefusal } from "./PayingAccountRefusal.js";

/** What the chip says when the roster served and named no account for this agent. */
const PROVIDER_DEFAULT_ACCOUNT = "Provider's default account";

export interface PayingAccountProps {
  readonly binding: AgentBindingReading;
}

/**
 * Who is paying, or the reason the chip cannot say.
 *
 * Five arms because these are five different facts and rule 8 forbids collapsing
 * any two: a read that could not be taken, nobody asked, a read travelling, the
 * roster served and named no account — which IS the provider's registered default
 * paying and is stated as such — and the label itself.
 *
 * A REFUSAL IS RENDERED ON EITHER READ'S ARM. The reading is a join of two: the
 * roster's, and the account plane's word for the handle the roster names. The
 * account plane can refuse while the roster served — `agent-binding-read.ts` says
 * why that is deliberately not reported as a refused reading — and this component
 * rendered that case as "the account registry has not supplied its label", a
 * sentence that says nobody asked about a read that failed. So the presence of a
 * reason is tested BEFORE the phase, and the phase decides only what is rendered
 * when there is none.
 *
 * A label is rendered only where both reads served. An account id whose label has
 * not been read is a handle, and a handle in a chip is an internal identifier a
 * person cannot act on — so its absence is an absence, never the id.
 */
export function PayingAccount(props: PayingAccountProps): React.JSX.Element {
  const { phase, payingAccountLabel, isProviderDefaultAccount, refusal } = props.binding;
  if (phase === "refused" || refusal !== undefined) {
    return <PayingAccountRefusal refusal={refusal} />;
  }
  if (phase === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        title="Paying account not read"
        detail="Nothing has asked the daemon which account pays for this agent's turns."
      />
    );
  }
  if (phase === "loading") {
    return (
      <Nothing
        kind="not-loaded"
        title="Reading the paying account"
        detail="The agent roster read is still travelling."
      />
    );
  }
  if (isProviderDefaultAccount) {
    return <Chip mono glyph="member" label={PROVIDER_DEFAULT_ACCOUNT} />;
  }
  if (payingAccountLabel === undefined) {
    return (
      <Nothing
        kind="not-checked"
        title="Account label not read"
        detail="The roster named the account this agent's turns are billed to, and the account registry has not reported a label for it."
      />
    );
  }
  return <Chip mono glyph="member" label={payingAccountLabel} />;
}
