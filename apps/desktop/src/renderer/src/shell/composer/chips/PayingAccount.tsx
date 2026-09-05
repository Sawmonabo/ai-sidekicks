// Who is paying for this agent's turns, or the reason the chip cannot say.
//
// Its own module because this package declares one component per `.tsx` file, and
// because the four arms below are the whole of rule 8 applied to one fact — a
// component with four absence arms inside another component is where an author
// eventually collapses two of them.

import { Chip, InlineRefusal, Nothing } from "../../../console/primitives/index.js";
import type { AgentBindingReading } from "./agent-binding-read.js";

/** What the chip says when the roster served and named no account for this agent. */
const PROVIDER_DEFAULT_ACCOUNT = "Provider's default account";

export interface PayingAccountProps {
  readonly binding: AgentBindingReading;
}

/**
 * Who is paying, or the reason the chip cannot say.
 *
 * Four arms because these are four different facts and rule 8 forbids collapsing
 * any two: nobody asked, a read is travelling, the roster served (and either named
 * an account whose label the account plane supplied, or named none — which IS the
 * provider's registered default paying and is stated as such), and a read refused.
 *
 * A label is rendered only where both reads served. An account id whose label has
 * not been read is a handle, and a handle in a chip is an internal identifier a
 * person cannot act on — so its absence is an absence, never the id.
 */
export function PayingAccount(props: PayingAccountProps): React.JSX.Element {
  const { phase, payingAccountLabel, isProviderDefaultAccount, refusal } = props.binding;
  if (phase === "refused" && refusal !== undefined) {
    return <InlineRefusal code={refusal.code} detail={refusal.detail} />;
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
        detail="The roster named the account this agent's turns are billed to, and the account registry has not supplied its label."
      />
    );
  }
  return <Chip mono glyph="member" label={payingAccountLabel} />;
}
