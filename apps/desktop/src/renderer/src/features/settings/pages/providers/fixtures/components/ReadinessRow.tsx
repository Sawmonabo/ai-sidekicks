import type {
  ProviderAccount,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ReactNode } from "react";

import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { PROVIDER_READINESS_STATE_WORDS } from "#renderer/lib/provider-accounts/sentences.js";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import type { ProviderAccountProbeCall, ProviderAccountRegisterCall } from "../sign-in/flow.js";
import { RemedyLine } from "./RemedyLine.js";

/**
 * One provider's readiness entry, and the single action its remedy names.
 *
 * The remedy is rendered, never computed: the daemon composes it at read time from the same
 * resolution the spawn path performs. An entry with no remedy is the authenticated one and
 * offers nothing; an undecided one says so through its look-again remedy, never as a failure.
 * Readiness blocks nothing (the spawn gate stays the daemon's live check); the one gate on this
 * row's control is the sign-in flow, one brokered flow at a time, which disables the control
 * with its reason.
 */
export function ReadinessRow(props: {
  readonly readiness: ProviderReadiness;
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
  /** Why this row's start may not be pressed right now, where it may not be. */
  readonly startBlockedReason: string | undefined;
  /** The last refusal this row's own start was answered with, where there is one. */
  readonly startRefusal: Refusal | undefined;
  /** The account the remedy names, as the registry carries it, where it carries it. */
  readonly remedyAccount: ProviderAccount | undefined;
  readonly register: ProviderAccountRegisterCall;
  /** Asks for a fresh registry read once a fresh token is stored or the account was checked. */
  readonly requestRegistryRead: () => void;
  readonly probe: ProviderAccountProbeCall;
}): ReactNode {
  const { readiness, onStartSignIn, startBlockedReason, startRefusal } = props;
  const clockLocale = useClockLocale();
  const { remedy } = readiness;
  return (
    <li className="meridian-accounts__readiness">
      <span className="meridian-accounts__readiness-head">
        <Chip label={PROVIDER_LABELS[readiness.provider]} />
        <Chip
          label={PROVIDER_READINESS_STATE_WORDS[readiness.state](readiness.provider)}
          tone={readiness.state === "authenticated" ? "neutral" : "attention"}
        />
        {readiness.observedAt === undefined ? (
          <span className="meridian-settings-page__aside">
            No stored observation backs this entry.
          </span>
        ) : (
          <>
            <span className="meridian-settings-page__aside">from the observation taken </span>
            <DerivedFigure text={formatDateTime(readiness.observedAt, clockLocale)} />
          </>
        )}
      </span>
      {remedy === undefined ? null : (
        <RemedyLine
          remedy={remedy}
          state={readiness.state}
          provider={readiness.provider}
          onStartSignIn={onStartSignIn}
          startBlockedReason={startBlockedReason}
          startRefusal={startRefusal}
          remedyAccount={props.remedyAccount}
          register={props.register}
          requestRegistryRead={props.requestRegistryRead}
          probe={props.probe}
        />
      )}
    </li>
  );
}
