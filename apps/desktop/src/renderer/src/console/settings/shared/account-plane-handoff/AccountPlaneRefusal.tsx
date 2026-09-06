// An account-plane refusal, and the one place a person can do something about it.
//
// THE REFUSAL IS NEVER SUPPRESSED AND NEVER REWORDED. It renders first, through the
// console's own inline shape, carrying the daemon's code verbatim and the daemon's
// sentence as its author wrote it. Whatever this component adds is added AFTER it
// and is about navigation.
//
// AND THE HANDOFF IS A NAVIGATION AND NOT AN ACT. The control opens the settings
// section where the act lives. It runs no sign-in command, renders no credential-home
// path, and re-derives no eligibility — the daemon decides whether a run is
// admissible, and this window's job on a refusal is to stop being a dead end.
//
// It fires on a refusal that ALREADY HAPPENED, which is the trigger the design fixes:
// nothing here runs ahead of a call, so a run that would have been admitted is never
// interrupted by an offer to sign in.

import type { ReactNode } from "react";

import { type ConsoleRefusal } from "../../../core/index.js";
import { InlineRefusal } from "../../../primitives/index.js";
import { SETTINGS_SECTION_LABELS, type SettingsSectionId } from "../../settings-page-registry.js";
import { accountPlaneHandoffFor } from "./account-plane-handoff.js";
import { ACCOUNT_PLANE_ACT_SENTENCES } from "./account-plane-sentences.js";

export function AccountPlaneRefusal(props: {
  readonly refusal: ConsoleRefusal;
  readonly openSection: (section: SettingsSectionId) => void;
  /**
   * The section this refusal is being rendered ON, where it is on one at all.
   *
   * So the handoff never offers to open the page a person is already reading, which
   * is a control that appears to do something and does nothing. The sentence still
   * renders: what has to happen is worth saying even when the place to do it is the
   * surface it is said on.
   */
  readonly currentSection?: SettingsSectionId | undefined;
}): ReactNode {
  const handoff = accountPlaneHandoffFor(props.refusal.code);
  const { openSection } = props;
  const isAlreadyThere = handoff !== undefined && handoff.section === props.currentSection;
  return (
    <>
      <InlineRefusal code={props.refusal.code} detail={props.refusal.detail} />
      {handoff === undefined ? null : (
        <p className="meridian-account-handoff">
          <span className="meridian-account-handoff__sentence">
            {ACCOUNT_PLANE_ACT_SENTENCES[handoff.remedyKind]}
          </span>
          {isAlreadyThere ? null : (
            <button
              type="button"
              className="meridian-account-handoff__action"
              onClick={() => {
                openSection(handoff.section);
              }}
            >
              Open {SETTINGS_SECTION_LABELS[handoff.section]}
            </button>
          )}
        </p>
      )}
    </>
  );
}
