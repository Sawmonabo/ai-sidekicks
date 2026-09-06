import type { ProviderReadiness } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import { Chip, DerivedFigure, formatDateTime } from "../../../../primitives/index.js";
import { RemedyLine } from "./RemedyLine.js";

/**
 * One provider's readiness entry, and the single action its remedy names.
 *
 * THE REMEDY IS RENDERED, NEVER COMPUTED. The daemon composes it at read time from the
 * same resolution the spawn path performs, and it arrives already decided — which
 * state calls for which kind, which account a sign-in authenticates into, and which
 * candidates a default could be chosen from. A renderer that derived one would be a
 * second answer to a question the account plane already answered.
 *
 * AN ENTRY WITH NO REMEDY IS THE AUTHENTICATED ONE, and it offers nothing. That is not
 * an omission to be filled with a "check again" button: an account that needs nothing
 * done is the one entry whose remedy would be wrong rather than merely redundant.
 *
 * `indeterminate` READS AS AN HONEST UNKNOWN AND NEVER AS A FAILURE. It carries the
 * `sign_in` remedy like the other two non-authenticated arms, and the sentence beside
 * it says the probe could not decide rather than that anything is broken.
 *
 * READINESS BLOCKS NOTHING. The spawn gate stays the daemon's live check, so this row
 * says what a run would find and never withholds a control anywhere else in the
 * console.
 */
export function ReadinessRow(props: {
  readonly readiness: ProviderReadiness;
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
}): ReactNode {
  const { readiness, onStartSignIn } = props;
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
      {remedy === undefined ? null : <RemedyLine remedy={remedy} onStartSignIn={onStartSignIn} />}
    </li>
  );
}
