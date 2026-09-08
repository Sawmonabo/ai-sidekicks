// What the account axis SAYS — the sentences beside the picker, and nothing that
// decides which account they are about.
//
// A MODULE OF ITS OWN beside `account-axis.ts` rather than a second half of it. That
// module answers which accounts this axis may offer and which one a sentence speaks
// for; this one answers what there is to say about the account it named. The two are
// different subjects with different readers — the picker consumes the first and never
// the second — and the split is what keeps either from being read as the other's
// implementation detail.
//
// THE SENTENCE SAYS ONLY WHAT THE WEAKEST PRODUCER OF THAT STATE ESTABLISHED. Four
// things write the stored health pair — the deliberate probe verb, validation at
// spawn, the registration-time status invocation, and the background observer — and
// the last of those is a freshness-and-liveness reading over LOCAL credential state
// that never spends a credential rotation. So an `authenticated` value establishes
// that a credential is present and not locally known to be dead, and nothing about
// whether the provider would accept it right now: a server-revoked credential stays
// in that arm until a run or a deliberate probe finds otherwise. Every sentence below
// is therefore written to be true of every producer, which is what stops this field
// reporting a local observation as a sign-in the provider has confirmed.
//
// AND IT NAMES WHEN. The reading travels with the moment it was taken precisely so a
// surface can weigh it, and the pair is the only thing that separates "no observation
// has ever been taken" from "one was taken and could not decide" — both of which
// project the same `indeterminate` state. A sentence that dropped the instant would
// render a reading from months ago and one from a moment ago identically and collapse
// those two facts into one.
//
// NOTHING HERE IS A COMMAND. A remedy is named as the ACT it is; the provider's own
// first-party invocation and the credential home it authenticates into travel on the
// same reply and belong to the operator surface that owns them, never to a form.

import type { ProviderAccount, ProviderRemedy } from "@ai-sidekicks/contracts";

import { formatDateTime } from "../../../primitives/index.js";
import {
  advisoryChoiceIn,
  type AttachAccountAxisReading,
  type AttachAccountChoice,
} from "./account-axis.js";

/**
 * What the observation FOUND, given the moment it was taken.
 *
 * TOTAL over the contract's own union, so a fifth health state cannot land upstream
 * and leave this field rendering a term it never explains. It is a reading and never
 * a verdict: every sentence says what was OBSERVED, and none of them says the account
 * will or will not work — the spawn probe decides that and this form never does.
 *
 * EVERY ARM TAKES THE INSTANT rather than one of them appending it, because the age of
 * a reading is part of what the reading says: an account whose home went missing a
 * minute ago and one whose home went missing in March are two different situations
 * and the state alone renders them alike.
 *
 * AND EVERY ARM IS WORDED FOR THE WEAKEST PRODUCER OF THAT STATE, per the module
 * header. `authenticated` therefore claims credential presence and local health and
 * says outright where the question is actually settled; `reauth_required` names what
 * the account needs rather than who asked for it, because a terminal authentication
 * refusal on a token-mode account lands here too and nobody asked for anything there.
 */
const OBSERVED_HEALTH_ADVISORIES: Readonly<
  Record<ProviderAccount["healthState"], (observedAt: string) => string>
> = {
  authenticated: (observedAt) =>
    `The observation at ${observedAt} found a credential in this account's home and nothing local reporting it dead. Whether the provider still accepts it is decided when a run starts.`,
  reauth_required: (observedAt) =>
    `The observation at ${observedAt} found this account needing a fresh sign-in before a run can use it.`,
  home_missing: (observedAt) =>
    `The observation at ${observedAt} found no credential home where this account expects one.`,
  indeterminate: (observedAt) =>
    `The observation at ${observedAt} did not decide about this account.`,
};

/**
 * Said instead wherever the account carries no observation time at all.
 *
 * ITS OWN SENTENCE AND NOT AN `indeterminate` VARIANT. A never-observed account and a
 * probe that could not decide both project `indeterminate`, and the timestamp is the
 * only member that separates them — so a field that rendered one sentence for both
 * would report "we looked and could not tell" over an account nothing has ever looked
 * at.
 *
 * Reached from every state rather than only from `indeterminate`, which is deliberate:
 * the durable pair is set and cleared together, so a null timestamp says no
 * observation was taken whatever state arrived beside it, and the contract's own
 * parser is what keeps the other three arms from reaching here at all.
 */
const NEVER_OBSERVED_ADVISORY = "This account has never been observed.";

/** The stored reading as one sentence: what was found, and when it was found. */
function storedHealthAdvisoryFor(choice: AttachAccountChoice, locale: string | undefined): string {
  const { healthObservedAt } = choice;
  if (healthObservedAt === null) {
    return NEVER_OBSERVED_ADVISORY;
  }
  // Through the console's ONE date formatter, which answers an em dash for a stamp it
  // cannot read rather than throwing — so a malformed instant costs this sentence its
  // reading and never the field.
  return OBSERVED_HEALTH_ADVISORIES[choice.healthState](formatDateTime(healthObservedAt, locale));
}

/**
 * What the act that closes a readiness entry IS, named and never composed.
 *
 * TOTAL over the registered remedy kinds, and deliberately naming only the ACT. The
 * remedy's content — the credential home a sign-in authenticates into and the
 * provider's own first-party invocation — is the daemon's, it travels on the reply,
 * and it belongs on the operator surface that owns it. An attach form printing a
 * command a person is invited to run would be this console composing a remedy, which
 * the account plane's own rule forbids.
 *
 * ONE VOCABULARY AND NOT ONE PER READER. Both readers below reach this table: the
 * per-account list, where the entry resolved to a row the picker can show, and
 * {@link unresolvedDefaultAdvisoryIn}, where it resolved to none. A second sentence
 * composed for the same kind would let the two drift and would make which sentence a
 * person meets depend on whether an account happened to resolve.
 */
const REMEDY_ADVISORIES: Readonly<Record<ProviderRemedy["kind"], string>> = {
  register: "No account is registered for this provider.",
  choose_default: "Accounts are registered for this provider and none of them is the default.",
  sign_in: "Signing this account in again is what run admission is waiting for.",
};

/**
 * Every advisory line this account carries, in the order they are read.
 *
 * A LIST rather than one joined sentence, because the two halves answer different
 * questions — what was stored about this account, and what run admission last made of
 * it — and a reader who only needs the first should not have to find it inside the
 * second. Empty is impossible: the stored reading always says something.
 *
 * @param locale Optional, and trailing, exactly as the console's own formatters take
 *   one: the stored reading names an instant, and the caller that has a locale to
 *   render it under is the one composing the field rather than this model.
 */
export function accountAdvisoriesFor(
  choice: AttachAccountChoice,
  locale?: string,
): readonly string[] {
  const advisories = [storedHealthAdvisoryFor(choice, locale)];
  const { readiness } = choice;
  if (readiness === undefined) {
    return advisories;
  }
  advisories.push(`Run admission last read this provider as ${readiness.state}.`);
  if (readiness.remedy !== undefined) {
    advisories.push(REMEDY_ADVISORIES[readiness.remedy.kind]);
  }
  return advisories;
}

/**
 * What an unpinned axis is owed where resolution reached no account it can show.
 *
 * THE COMPLEMENT OF {@link advisoryChoiceIn}'S DERIVED ARM, and written as one so the
 * pair is total: an axis that pins nothing is asking the daemon for the provider's
 * registered default, and where the readiness entry names no account there is no row
 * whose {@link accountAdvisoriesFor} could carry the remedy. That state renders
 * nothing at all without this — the form goes on asking for a default that does not
 * exist, and the daemon's refusal is the first thing that says so.
 *
 * SILENT WHERE SOMETHING IS PINNED. A pinned axis is not asking for a default, so the
 * default's condition is not this field's subject and saying it beside a pinned
 * account's readings would invite exactly the confusion the leading sentence exists to
 * prevent.
 *
 * @param accountId The account this form PINS, or `undefined` where it pins none.
 */
export function unresolvedDefaultAdvisoryIn(
  reading: AttachAccountAxisReading,
  accountId: string | undefined,
): string | undefined {
  if (accountId !== undefined || advisoryChoiceIn(reading, undefined) !== undefined) {
    return undefined;
  }
  const remedy = reading.kind === "served" ? reading.providerReadiness?.remedy : undefined;
  return remedy === undefined ? undefined : REMEDY_ADVISORIES[remedy.kind];
}
