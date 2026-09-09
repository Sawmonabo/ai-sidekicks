// Pages whose body another plan authors: the seat, and what stands in for it.
//
// SPLIT FROM `settings-page-registry.ts`, which owns the entry index — which page
// holds which section and what text a term matches against. This owns a different
// question entirely: what a page renders when the body it mounts has not been written
// yet. The two were one file while the renderer was four lines; the registry is the
// module every settings page imports, and a page that only wanted the reservation
// renderer was reaching through the whole index to get it.
//
// Two settings sections are holes another plan fills: the provider-account
// registry and the MCP server inventory. Each is a PAGE this repository builds the
// chrome for and a BODY it does not author at all, so the arrangement is the seat
// contract `seats/slots/owner-slot.ts` declares — who owns the body, what the
// mount owes it, and where the shell dies.
//
// WHY THE RENDERER IS HERE AND THE SLOTS ARE NOT
//
// Each slot lives beside the page that mounts it, because the reservation copy, the
// body's props, and the section registration are one decision. What is shared is
// the four lines that CHOOSE between a body and its reservation, and those were
// written twice before this function existed — `apps/desktop/AGENTS.md` hoists on
// the second use.

//
// The reservation copy names the FEATURE and never the governance work — a slot
// contract is developer-facing (`seats/slots/owner-slot.ts` says so in terms),
// and the repository's standing rule keeps governance identifiers out of what a
// participant reads.

import { createElement, type ReactNode } from "react";

import { Nothing } from "../primitives/index.js";
import type { OwnerSlotProps } from "../seats/index.js";
import type { SettingsPageBody, SettingsPageContext } from "./settings-page-registry.js";

/** One page whose body another plan authors: the seat, and what it says today. */
export interface OwnerSlotPage {
  readonly slot: OwnerSlotProps<SettingsPageBody>;
  /** What is absent, in one sentence. The feature, never the work that owes it. */
  readonly reservationTitle: string;
  /** The second line: what the body will hold, and what has not been asked for. */
  readonly reservationDetail: string;
}

/**
 * Render one such page: the body if it has arrived, the reservation if not.
 *
 * "Reserved, not stubbed" — the console says the body has not been built rather
 * than drawing an empty pane that reads as a broken feature. The absence is a
 * `surface` placement because it stands in for the region the body would fill, not
 * for one value inside it.
 */
export function renderOwnerSlotPage(page: OwnerSlotPage, context: SettingsPageContext): ReactNode {
  const { body } = page.slot;
  if (body !== undefined) {
    return body(context);
  }
  return createElement(Nothing, {
    kind: "empty",
    placement: "surface",
    title: page.reservationTitle,
    detail: page.reservationDetail,
  });
}
