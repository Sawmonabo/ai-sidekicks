import type { ProviderReadiness } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import type { Refusal } from "@renderer/lib/refusal.js";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import { RemedyLine } from "./RemedyLine.js";

/**
 * One provider's readiness entry, and the single action its remedy names.
 *
 * The remedy is rendered, never computed: the daemon composes it at read time from the same
 * resolution the spawn path performs. An entry with no remedy is the authenticated one and
 * offers nothing. `indeterminate` reads as an honest unknown, not a failure. Readiness blocks
 * nothing (the spawn gate stays the daemon's live check); the one gate on this row's control is
 * the sign-in flow, one brokered flow at a time, which disables the control with its reason.
 */
export function ReadinessRow(props: {
  readonly readiness: ProviderReadiness;
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
  /** Why this row's start may not be pressed right now, where it may not be. */
  readonly startBlockedReason: string | undefined;
  /** The last refusal this row's own start was answered with, where there is one. */
  readonly startRefusal: Refusal | undefined;
}): ReactNode {
  const { readiness, onStartSignIn, startBlockedReason, startRefusal } = props;
  const { remedy } = readiness;
  return (
    <li className="meridian-accounts__readiness">
      <span className="meridian-accounts__readiness-head">
        <Chip label={readiness.provider} mono />
        <Chip
          label={readiness.state}
          mono
          tone={readiness.state === "authenticated" ? "neutral" : "attention"}
        />
        {readiness.observedAt === undefined ? (
          <span className="meridian-settings-page__aside">
            No stored observation backs this entry.
          </span>
        ) : (
          <>
            <span className="meridian-settings-page__aside">from the observation taken </span>
            <DerivedFigure text={formatDateTime(readiness.observedAt)} />
          </>
        )}
      </span>
      {readiness.state === "indeterminate" ? (
        <p className="meridian-settings-page__aside">
          The stored observation could not decide. That is not a failure — nothing has been run to
          find out, and a run will validate the account for itself.
        </p>
      ) : null}
      {remedy === undefined ? null : (
        <RemedyLine
          remedy={remedy}
          onStartSignIn={onStartSignIn}
          startBlockedReason={startBlockedReason}
          startRefusal={startRefusal}
        />
      )}
    </li>
  );
}
