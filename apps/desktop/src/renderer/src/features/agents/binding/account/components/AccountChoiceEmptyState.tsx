// Why there is no account picker, in the words of whichever answer produced it. Five
// empty states, only one of which is "the registry holds none"; an empty picker would report an
// unanswered registry as an answer of nothing. A refusal renders verbatim with a way to retry.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type { AccountAxisReading } from "../axis.js";

/** What the empty state shows, and how it asks for a fresh read. */
export interface AccountChoiceEmptyStateProps {
  readonly reading: AccountAxisReading;
  /** Ask the window's one account registry reading for a fresh read. */
  readonly onReopen: () => void;
}

/** The empty state for the account picker: one message per reason there is no list. */
export function AccountChoiceEmptyState(props: AccountChoiceEmptyStateProps): React.JSX.Element {
  const { reading, onReopen } = props;
  if (reading.kind === "driver-unchosen") {
    return (
      <Nothing
        kind="not-checked"
        title="Choose a provider first."
        detail={
          "An account belongs to one provider, so which accounts may be " +
          "pinned follows from the provider."
        }
      />
    );
  }
  if (reading.kind === "reading") {
    return <Nothing kind="not-loaded" title="Reading this node's provider accounts" />;
  }
  if (reading.kind === "refused") {
    return (
      <InlineRefusal
        code={reading.refusal.code}
        detail={reading.refusal.detail}
        action={<TryAgainButton onPress={onReopen} />}
      />
    );
  }
  if (reading.kind === "unknown-provider") {
    return (
      <Nothing
        kind="not-checked"
        title="No provider the account registry knows."
        detail={
          "Nothing is offered rather than another provider's accounts, " +
          "which would pin a run to an account nobody chose for it."
        }
      />
    );
  }
  return <Nothing kind="empty" title="No account is registered for this provider on this node." />;
}
