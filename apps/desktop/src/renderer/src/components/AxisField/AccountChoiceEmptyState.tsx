// Why there is no account picker, in the words of whichever answer produced it. Five
// empty states, only one of which is "the registry holds none"; an empty picker would report an
// unanswered registry as an answer of nothing. The account list's own states read as the
// Providers page words them, since the picker lists accounts exactly as that page does.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import {
  ACCOUNT_LIST_READ_WORDS,
  ACCOUNT_PLANE_REMEDY_SENTENCES,
} from "#renderer/lib/provider-accounts/sentences.js";
import type { AccountAxisReading } from "#renderer/lib/provider-binding/account/axis.js";

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
    return <Nothing kind="not-loaded" title={ACCOUNT_LIST_READ_WORDS.reading} />;
  }
  if (reading.kind === "refused") {
    return (
      <Nothing
        kind="error"
        title={ACCOUNT_LIST_READ_WORDS.refused}
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
  return <Nothing kind="empty" title={ACCOUNT_PLANE_REMEDY_SENTENCES.register(reading.provider)} />;
}
