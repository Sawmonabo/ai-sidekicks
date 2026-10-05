import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/account";
import type { ReactNode } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import {
  BILLING_MODE_WORDS,
  CREDENTIAL_KIND_WORDS,
  PROVIDER_READINESS_STATE_WORDS,
} from "@renderer/lib/account-plane-sentences.js";
import { PROVIDER_LABELS } from "@renderer/lib/provider-labels.js";
import { observationAgeInDays } from "../quota-rows.js";

/**
 * How old an observation has to be before the row says so.
 *
 * A presentation threshold only: the timestamp renders either way, and crossing this line
 * changes the chip's tone so a fortnight-old reading does not read as current.
 */
const STALE_OBSERVATION_DAYS = 14;

/**
 * One registry row: the label, the provider, how it is charged, whether it is the default, and
 * the health reading with the moment it was taken. Pressing it selects the account, and the
 * caller makes a press on an account the mark is not on do what `Set as default` does.
 *
 * The health reading is a stored observation, not a claim of authentication, so the row says
 * what the last look found. An account never observed has `healthObservedAt: null`, which
 * renders as its own sentence. The provider-reported identity renders only where observed,
 * since each member is independently optional on the wire.
 */
export function AccountRow(props: {
  readonly account: ProviderAccount;
  readonly selected: boolean;
  readonly nowMilliseconds: number;
  readonly onSelect: (account: ProviderAccount) => void;
}): ReactNode {
  const { account, selected, nowMilliseconds, onSelect } = props;
  const ageInDays =
    account.healthObservedAt === null
      ? undefined
      : observationAgeInDays(account.healthObservedAt, nowMilliseconds);
  const isStale = ageInDays !== undefined && ageInDays >= STALE_OBSERVATION_DAYS;
  // A token or API-key account reads the name the person gave it beside its credential's kind.
  const credentialKind =
    account.observedAuthMode === null ? null : CREDENTIAL_KIND_WORDS[account.observedAuthMode];
  return (
    <li>
      <button
        type="button"
        className="meridian-accounts__row"
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          onSelect(account);
        }}
      >
        <span className="meridian-accounts__row-label">
          {credentialKind === null
            ? account.displayLabel
            : `${account.displayLabel} · ${credentialKind(account.provider)}`}
        </span>
        <span className="meridian-accounts__row-chips">
          <Chip label={PROVIDER_LABELS[account.provider]} />
          {/* The billing-mode label beside every money figure, so plan-included usage is never
              presented as billed currency; it rides the row because quota figures are read from
              here down. */}
          <Chip label={BILLING_MODE_WORDS[account.billingMode]} />
          {account.isDefault ? <Chip label="Default" tone="accent" glyph="check" /> : null}
          <Chip
            label={PROVIDER_READINESS_STATE_WORDS[account.healthState](account.provider)}
            tone={account.healthState === "authenticated" && !isStale ? "neutral" : "attention"}
          />
        </span>
        <span className="meridian-accounts__row-observed">
          {account.healthObservedAt === null ? (
            <span className="meridian-settings-page__aside">Never observed.</span>
          ) : (
            <>
              <span className="meridian-settings-page__aside">Observed </span>
              <DerivedFigure text={formatDateTime(account.healthObservedAt)} />
            </>
          )}
        </span>
        {account.observedAccountEmail === undefined &&
        account.observedAccountOrgName === undefined ? null : (
          <span className="meridian-accounts__row-identity">
            {account.observedAccountEmail === undefined ? null : (
              <WireFigure value={account.observedAccountEmail} />
            )}
            {account.observedAccountOrgName === undefined ? null : (
              <WireFigure value={account.observedAccountOrgName} />
            )}
          </span>
        )}
      </button>
    </li>
  );
}
