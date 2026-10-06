// An account-plane refusal, and the one place a person can do something about it.
//
// The refusal is never suppressed or reworded: it renders first through the inline shape with
// the daemon's code and sentence verbatim, and whatever this adds comes after it and is about
// navigation. The handoff opens the settings section where the act lives; it runs no sign-in
// command, renders no credential-home path and re-derives no eligibility. It fires on a refusal
// that already happened, so a run that would have been admitted is never interrupted by an offer.

import "./AccountPlaneRefusal.css";

import type { ProviderLoginExpiredRemedy } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { ReactNode } from "react";

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "#renderer/features/settings/pages/labels.js";
import { accountPlaneHandoffFor } from "../account-plane-handoff.js";
import { ACCOUNT_PLANE_REMEDY_SENTENCES } from "#renderer/lib/account-plane-sentences.js";

/** A refusal line plus, where a console act answers it, a handoff to the settings section. */
export function AccountPlaneRefusal(props: {
  readonly refusal: Refusal;
  /** The provider the refused request was about, which the remedy sentence names. */
  readonly provider: ProviderName;
  /**
   * The remedy the refusal's own data named, read from it at the wire boundary. A refused account
   * move carries the account's own; a code routed by it offers no handoff without one.
   */
  readonly carriedRemedy?: ProviderLoginExpiredRemedy | undefined;
  /**
   * Opens the settings section the handoff names. Absent where the refusal renders on that very
   * section, which `currentSection` then names.
   */
  readonly openPage?: ((section: SettingsPageId) => void) | undefined;
  /**
   * The section this refusal is rendered on, if any, so the handoff never offers to open the
   * page a person is already reading. The sentence still renders.
   */
  readonly currentSection?: SettingsPageId | undefined;
}): ReactNode {
  const handoff = accountPlaneHandoffFor(props.refusal.code, props.carriedRemedy);
  const { openPage } = props;
  const isAlreadyThere = handoff !== undefined && handoff.section === props.currentSection;
  return (
    <>
      <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      {handoff === undefined ? null : (
        <p className="meridian-account-handoff">
          <span className="meridian-account-handoff__sentence">
            {ACCOUNT_PLANE_REMEDY_SENTENCES[handoff.remedyKind](props.provider)}
          </span>
          {isAlreadyThere || openPage === undefined ? null : (
            <button
              type="button"
              className="meridian-account-handoff__action"
              onClick={() => {
                openPage(handoff.section);
              }}
            >
              Open {SETTINGS_PAGE_LABELS[handoff.section]}
            </button>
          )}
        </p>
      )}
    </>
  );
}
