// Which provider accounts the attach form may pin, which one its advisories speak
// for, and what the registry stored about each one.
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
// WHICH IS ALSO WHY THE ENTRY IS WHAT AN UNPINNED AXIS IS ABOUT. An attach that pins
// nothing is asking the daemon for the provider's registered default, and the entry
// is that resolution's own answer — so {@link advisoryChoiceIn} reads the entry where
// nothing is pinned rather than leaving a form silent about the account it is going
// to use. The sentences themselves are `account-advisories.ts`'s.
//
// NOTHING HERE GATES. The spawn probe settles authentication, and a form that refused
// on a stored observation would refuse an account that is about to work. What this
// produces is a sentence beside a field.

import {
  PROVIDER_NAMES,
  type ProviderAccount,
  type ProviderName,
  type ProviderReadiness,
} from "@ai-sidekicks/contracts";

import { readRefusalOf, type WireReadState } from "../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";

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
      /**
       * This provider's own readiness entry, where the read carried one.
       *
       * DERIVED ONCE, IN {@link attachAccountAxisReadingFor}. The projection is keyed
       * by provider and this arm is the one place the provider is settled, so a
       * component that re-found the entry would be a second answer to which entry
       * this axis is about — and the two would disagree the moment either match
       * changed. Absent where the read carried no entry for this provider, which is
       * not the same fact as an entry that resolved no account.
       */
      readonly providerReadiness: ProviderReadiness | undefined;
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
  const providerReadiness = registry.readiness.find((entry) => entry.provider === provider);
  const choices = registry.accounts
    .filter((account) => account.provider === provider)
    .map((account) => accountChoiceFor(account, providerReadiness));
  return { kind: "served", provider, providerReadiness, choices };
}

/**
 * One registry row, carrying this provider's entry only where it resolved to that row.
 *
 * Matched against the ONE entry this provider carries rather than against every entry
 * the read holds: a projection that named an account of another provider would
 * otherwise attach itself here, which is the cross-provider attribution the per-account
 * rule exists to refuse.
 */
function accountChoiceFor(
  account: ProviderAccount,
  providerReadiness: ProviderReadiness | undefined,
): AttachAccountChoice {
  return {
    accountId: account.accountId,
    displayLabel: account.displayLabel,
    isProviderDefault: account.isDefault,
    healthState: account.healthState,
    healthObservedAt: account.healthObservedAt,
    readiness:
      providerReadiness?.resolvedAccountId === account.accountId ? providerReadiness : undefined,
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
 * The choice the advisories speak for: the pinned one, else the resolved default.
 *
 * A SECOND RULE BESIDE {@link chosenAccountIn} rather than a widening of it. That one
 * answers what the form PINS, and its other readers need exactly that — the sentence
 * naming a value the picker cannot show and the registry-membership caveat are both
 * about the caller's own entry, and a default nobody typed would make each of them
 * false. This one answers which account the readings beside the field are ABOUT, which
 * is a different question the moment nothing is pinned: an unpinned attach asks the
 * daemon for the provider's registered default, so the readings that bear on it are
 * that account's.
 *
 * THE READINESS ENTRY DECIDES, NEVER THE REGISTRY'S `isProviderDefault` FLAG. The flag
 * is what the registry MARKS default; the entry is what resolution REACHED, computed
 * by the same resolution the spawn path performs. Where the two disagree the entry is
 * the spawn path's answer, so a field keyed on the flag would report the health of an
 * account this attach is not going to use.
 *
 * A PINNED VALUE THE REGISTRY DOES NOT CARRY ANSWERS NOTHING, deliberately, rather
 * than falling through to the default: the readings would then be about an account the
 * caller did not ask for, rendered under a value they did.
 *
 * @param accountId The account this form PINS, or `undefined` where it pins none.
 */
export function advisoryChoiceIn(
  reading: AttachAccountAxisReading,
  accountId: string | undefined,
): AttachAccountChoice | undefined {
  if (accountId !== undefined) {
    return chosenAccountIn(reading, accountId);
  }
  const resolvedAccountId =
    reading.kind === "served" ? reading.providerReadiness?.resolvedAccountId : undefined;
  return chosenAccountIn(reading, resolvedAccountId);
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
