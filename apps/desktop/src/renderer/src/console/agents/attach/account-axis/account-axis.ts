// Which provider accounts the attach form may pin, and what the registry stored
// about each one.
//
// THE ACCOUNT AXIS IS A REGISTRY AXIS, NOT A TEXT FIELD. It was one — an untyped
// input beside a standing sentence — and an untyped input is the one shape that
// cannot be wrong in the renderer and always wrong at the daemon: a typo composes a
// request naming an account the registry has never held, which is refused in the
// account plane's own namespace after the attach has been submitted. The registry is
// read once per window already (`bridge/quotas/`), so the choices exist and this
// module is what turns them into an axis.
//
// AND IT IS PROVIDER-SCOPED, WHICH IS WHY THE DRIVER DECIDES IT. An account belongs
// to exactly one provider and a run is admitted against exactly one account, so the
// accounts a form may offer are the ones belonging to the provider the chosen driver
// speaks for. That is why `../attach-model.ts` drops a pinned account on a driver change
// unconditionally, and it is why an unchosen driver here answers with no choices at
// all rather than with every account on the node.
//
// THE DRIVER NAME IS MATCHED AGAINST THE PROVIDER SET AND NEVER ASSUMED TO BE ONE.
// `driverName` arrives from `driver.listModels` as a bare string — the daemon's own
// registry key — while an account's `provider` is a closed union, and the corpus says
// the two vocabularies are the same set without giving the wire a type that says so.
// A driver this build cannot match to a provider therefore answers
// {@link AttachAccountAxisReading}'s own arm rather than falling through to "no
// accounts": offering another provider's accounts under it would pin a run to an
// account nobody chose for it, and rendering an empty picker would say the registry
// holds none when what happened is that nothing here could tell.
//
// READINESS IS ADVISORY AND IS READ PER ACCOUNT, NEVER PER PROVIDER. The projection
// the registry read carries is keyed by PROVIDER and names the one account resolution
// reached, so it says something about a given account only when it resolved to that
// account. Every other account carries its own STORED health reading and nothing
// else, and this module keeps those apart rather than attributing a provider's
// verdict to a row it was not computed for.
//
// NOTHING HERE GATES. The spawn probe settles authentication, and a form that refused
// on a stored observation would refuse an account that is about to work. What this
// produces is a sentence beside a field.
//
// AND THE SENTENCE SAYS ONLY WHAT THE WEAKEST PRODUCER OF THAT STATE ESTABLISHED.
// Four things write the stored health pair — the deliberate probe verb, validation at
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

import {
  PROVIDER_NAMES,
  type ProviderAccount,
  type ProviderName,
  type ProviderReadiness,
  type ProviderRemedy,
} from "@ai-sidekicks/contracts";

import { readRefusalOf, type WireReadState } from "../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { formatDateTime } from "../../../primitives/index.js";

/**
 * What this axis asks of the window's one account-plane reading.
 *
 * A NARROWING declared here rather than the whole readout, so this model depends on
 * the three members it reads and not on every fold that reading publishes — and so a
 * test drives it with an object rather than by standing up a bridge. The readout
 * satisfies it structurally, which is what keeps this a narrowing and not a copy.
 */
export interface AttachAccountRegistryReading extends WireReadState {
  /** Every account the registry carries, in the order the daemon sent them. */
  readonly accounts: readonly ProviderAccount[];
  /** What run admission would answer per provider, as the last READ computed it. */
  readonly readiness: readonly ProviderReadiness[];
}

/** One account the axis may take, with the stored reading that renders beside it. */
export interface AttachAccountChoice {
  readonly accountId: string;
  /** Operator-chosen. What a person recognises the account by. */
  readonly displayLabel: string;
  readonly isProviderDefault: boolean;
  readonly healthState: ProviderAccount["healthState"];
  /** `null` where no observation has ever been recorded for this account. */
  readonly healthObservedAt: string | null;
  /**
   * The readiness entry that RESOLVED to this account, where the read carried one.
   *
   * Absent on every account resolution did not reach, which is most of them: the
   * projection is per provider and names one account, so attaching a provider's
   * verdict to a row it was not computed for would report a state nobody derived.
   */
  readonly readiness: ProviderReadiness | undefined;
}

/**
 * What the account axis can offer right now.
 *
 * FIVE ARMS AND NOT A LIST PLUS A FLAG. "No driver chosen", "the read has not
 * landed", "the read was refused", "this driver names no provider this build knows",
 * and "the registry holds these" are five different facts, and the four that are not
 * a list are exactly the ones a picker rendered as empty would report as "no accounts
 * exist" — the conflation the console's kinds of nothing exist to refuse.
 */
export type AttachAccountAxisReading =
  | { readonly kind: "driver-unchosen" }
  | { readonly kind: "reading" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly kind: "unknown-provider"; readonly driverName: string }
  | {
      readonly kind: "served";
      readonly provider: ProviderName;
      readonly choices: readonly AttachAccountChoice[];
    };

/**
 * The provider a driver name speaks for, or `undefined` where it names none.
 *
 * Narrowed against the contract's own closed set rather than cast: an account's
 * provider is that set and a driver name is a bare wire string, so this is the one
 * place the two vocabularies are reconciled and the one place a mismatch is visible.
 */
function providerForDriver(driverName: string | undefined): ProviderName | undefined {
  return driverName === undefined
    ? undefined
    : PROVIDER_NAMES.find((provider) => provider === driverName);
}

/**
 * The accounts this driver's provider carries, folded with what the registry stored.
 *
 * The registry's OWN ORDER is preserved and nothing is sorted here. The daemon sends
 * the accounts in an order this console has no better answer than, and hoisting the
 * default to the top would be this module deciding a precedence the registry did not
 * state — the default is marked on its row instead, which says the same thing without
 * moving anything.
 */
export function attachAccountAxisReadingFor(
  registry: AttachAccountRegistryReading,
  driverName: string | undefined,
): AttachAccountAxisReading {
  if (driverName === undefined || driverName === "") {
    return { kind: "driver-unchosen" };
  }
  // ASKED BEFORE THE REGISTRY IS CONSULTED AT ALL, because it is decidable without
  // it: whether a driver name is one of the closed provider set is a fact about this
  // build, and reporting a refused read over it would name the read as the reason a
  // picker is missing when the read was never the obstacle.
  const provider = providerForDriver(driverName);
  if (provider === undefined) {
    return { kind: "unknown-provider", driverName };
  }
  // THE REFUSAL IS ASKED FOR THROUGH THE PHASE-AWARE ACCESSOR, never read off the
  // member: a reading whose newest read served carries no refusal even where an
  // earlier one failed, and the member alone would render a healed reading's last
  // failure for the life of the window.
  const refusal = readRefusalOf(registry);
  if (refusal !== undefined) {
    return { kind: "refused", refusal };
  }
  if (registry.phase === "reading") {
    return { kind: "reading" };
  }
  const choices = registry.accounts
    .filter((account) => account.provider === provider)
    .map((account) => accountChoiceFor(account, registry.readiness));
  return { kind: "served", provider, choices };
}

/** One registry row, with the readiness entry that resolved to it where there is one. */
function accountChoiceFor(
  account: ProviderAccount,
  readiness: readonly ProviderReadiness[],
): AttachAccountChoice {
  return {
    accountId: account.accountId,
    displayLabel: account.displayLabel,
    isProviderDefault: account.isDefault,
    healthState: account.healthState,
    healthObservedAt: account.healthObservedAt,
    readiness: readiness.find((entry) => entry.resolvedAccountId === account.accountId),
  };
}

/** The choice this axis is currently on, or `undefined` where the value names none. */
export function chosenAccountIn(
  reading: AttachAccountAxisReading,
  accountId: string | undefined,
): AttachAccountChoice | undefined {
  if (reading.kind !== "served" || accountId === undefined) {
    return undefined;
  }
  return reading.choices.find((choice) => choice.accountId === accountId);
}

/**
 * Whether a pinned account is one this driver's provider carries.
 *
 * `false` for a value the SERVED registry does not hold, and `true` in every state
 * where nothing could tell — an unread registry, a refused read, a driver naming no
 * known provider. The axis renders a caveat over those, and treating "not read" as
 * "not a member" would let a form call a caller's own pinned account unknown on the
 * strength of a read that never landed.
 */
export function registryCarriesAccount(
  reading: AttachAccountAxisReading,
  accountId: string,
): boolean {
  return (
    reading.kind !== "served" || reading.choices.some((choice) => choice.accountId === accountId)
  );
}

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
