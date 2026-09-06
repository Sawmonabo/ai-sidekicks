import type { ProviderAccount } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import { Chip, DerivedFigure, WireFigure, formatDateTime } from "../../../../primitives/index.js";
import { observationAgeInDays } from "./quota-rows.js";

/**
 * How old an observation has to be before the row says so out loud.
 *
 * A PRESENTATION threshold and nothing else: the timestamp renders either way, because
 * this page's degraded state is "a stale `healthObservedAt` renders with its timestamp
 * rather than being hidden". What crossing this line changes is the chip's tone, so a
 * reading a fortnight old reads as one rather than as current.
 *
 * Not in `core/constants.ts` because it bounds no resource — it is a word this one row
 * chooses, in the way the stall badge chooses its own volume.
 */
const STALE_OBSERVATION_DAYS = 14;

/**
 * One registry row: the label, the provider, how it is charged, whether it is the
 * default, and the health reading with the moment it was taken.
 *
 * THE HEALTH READING IS NOT A CLAIM OF AUTHENTICATION. It is a stored observation and
 * renders as one — the state, and when it was observed — so a row never says an account
 * works, only what the last look found. An account nothing has ever observed carries
 * `healthObservedAt: null`, and that renders as its own sentence rather than as a
 * timestamp this console picked.
 *
 * THE PROVIDER-REPORTED IDENTITY RENDERS ONLY WHERE IT WAS OBSERVED. Each member is
 * independently optional on the wire, so the row tests each rather than assuming a
 * provider that reported one reported all of them.
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
        <span className="meridian-accounts__row-label">{account.displayLabel}</span>
        <span className="meridian-accounts__row-chips">
          <Chip label={account.provider} mono />
          {/* The billing-mode label beside every money figure, so plan-included usage
              is never presented as billed currency without saying so. It rides the row
              rather than only the detail pane because the quota figures are read from
              here down. */}
          <Chip label={account.billingMode} mono />
          {account.isDefault ? <Chip label="Default" tone="accent" glyph="check" /> : null}
          <Chip
            label={account.healthState}
            mono
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
          {account.observedAuthMode === null ? null : (
            <>
              <span className="meridian-settings-page__aside"> · mode </span>
              <WireFigure value={account.observedAuthMode} />
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
