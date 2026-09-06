// The two axes a mount card reads on, and the capability axis beside them.
//
// THIS CONSOLE'S OWN RULE, stated here because no committed document states it: mount
// LIFECYCLE and mount HEALTH never collapse into one chip. `Spec-023 §Console Design
// (Meridian)` puts each surface's composition — what it renders, offers, refuses, and
// folds — in the console's code, so a repos-surface rule is written where it is obeyed
// rather than cited from somewhere it is not.
// A `detached` mount and an `unreachable` mount are different facts — the first is
// a row that has finished its life, the second is a row nobody can currently ask a
// question of — and a console that rendered one chip for both would be asserting a
// fact the daemon never sent.
//
// So there are three tables here, one per axis, and each is TOTAL over its wire
// union by construction. A member added to `RepoMountState`, to
// `RepoMountHealth["status"]`, or to `VcsType` in `packages/contracts` fails to
// compile here before it can reach a card that renders a nameless chip.
//
// HEALTH IS READ, NEVER COMPUTED. Every verdict below is keyed on a status string
// the daemon sent. The console does not probe a path, does not soften
// `unreachable`, and does not decide precedence between two failing verdicts —
// `Spec-009 §Repo Mount Health (V1 Definition)` puts all three with the daemon, and
// each is a Never of this module's own rather than a rule read off a citation.
//
// WHAT THE HEALTH AXIS DOES NOT CARRY, AND WHY IT IS NOT HERE. The console's repos
// design describes a third verdict on this axis for a root that is no longer the
// repository it was attached as. `RepoMountHealth` in
// `packages/contracts/src/repo.ts` is a CLOSED two-member union today — that
// module's own note says a third state would let a read answer "we did not check"
// on a surface obliged to check — so scripting or rendering a third verdict here
// would be the console inventing a value no daemon can send. The table is written
// over the union the contract ships, so the day a third member lands this file is
// a compile error and the copy is written then rather than guessed now.

import type { RepoMountHealth, RepoMountReadResponse, VcsType } from "@ai-sidekicks/contracts";
import type { RepoMountState } from "@ai-sidekicks/contracts";
import type { ChipTone } from "../../primitives/index.js";

/**
 * One axis reading, as a card renders it.
 *
 * `label` is the WIRE word and is rendered verbatim in mono — a reader who sees
 * `unreachable` on the screen can search the daemon's own vocabulary for it.
 * `sentence` is the console's prose: what this reading means for the next move.
 * They are separate fields because rule 4 governs the first and rule 9's
 * never-paraphrase discipline governs neither — the sentence is the console's to
 * write, the label is not.
 */
export interface MountAxisReading {
  readonly tone: ChipTone;
  readonly label: string;
  readonly sentence: string;
}

/**
 * The health axis. Total over `RepoMountHealth["status"]`, keyed off the contract's
 * own union rather than a tuple restated here.
 */
const HEALTH_READINGS: Readonly<Record<RepoMountHealth["status"], MountAxisReading>> = {
  healthy: {
    tone: "neutral",
    label: "healthy",
    sentence: "The root was reachable when it was last probed.",
  },
  unreachable: {
    tone: "failure",
    label: "unreachable",
    // The card's own copy for the state: no further question can be put
    // to a root that cannot be probed. Deliberately not softened to "temporarily
    // unavailable" — precedence between failing verdicts is the daemon's.
    sentence:
      "The root could not be probed, so nothing further can be asked of it. Binds and runs on this mount refuse until it is reachable again.",
  },
};

/** The lifecycle axis. Total over `RepoMountState`. */
const LIFECYCLE_READINGS: Readonly<Record<RepoMountState, MountAxisReading>> = {
  attached: {
    tone: "neutral",
    label: "attached",
    sentence: "This mount is live in the session.",
  },
  detached: {
    tone: "neutral",
    label: "detached",
    // Terminal per `Spec-009 §Detach Semantics (V1 Definition)`: there is no
    // `detached -> attached` transition, so this row is history and says so.
    sentence:
      "Detached is where a mount ends. Attaching the same path again mints a new mount; this row stays as history.",
  },
  archived: {
    tone: "neutral",
    label: "archived",
    sentence: "This mount was archived and is kept as history.",
  },
};

/** The capability axis — what a mount's version-control kind admits. */
const VCS_READINGS: Readonly<Record<VcsType, MountAxisReading>> = {
  git: {
    tone: "neutral",
    label: "git",
    sentence: "A git checkout: every execution mode the daemon offers is on the table.",
  },
  none: {
    tone: "attention",
    label: "none",
    // `Spec-009 §Fallback Behavior` binds a non-git path as a plain directory with
    // git-specific features disabled, and `Spec-009 §Acceptance Criteria` requires
    // such a workspace to stay usable without pretending to support them.
    sentence:
      "A plain directory, bound with git-specific features off. It stays usable; the git-only modes are unavailable rather than hidden.",
  },
};

/** How this mount's health reads. */
export function mountHealthReading(health: RepoMountHealth): MountAxisReading {
  return HEALTH_READINGS[health.status];
}

/** How this mount's lifecycle position reads. */
export function mountLifecycleReading(state: RepoMountState): MountAxisReading {
  return LIFECYCLE_READINGS[state];
}

/** How this mount's version-control kind reads. */
export function mountVcsReading(vcsType: VcsType): MountAxisReading {
  return VCS_READINGS[vcsType];
}

/**
 * Whether a card offers its bind controls, and what it says when it does not.
 *
 * This is a FAIL-CLOSED PROJECTION of daemon-reported state, not a renderer
 * eligibility rule. The daemon remains the only authority on whether a bind is
 * admissible and answers a refused one with its own typed code, which the card
 * renders; what this function decides is whether the console offers a control it
 * has already been told cannot succeed. Both cases are this module's: an `unreachable`
 * mount's bind controls are disabled with the reason said, and a `detached` row renders
 * as history. Neither is a pre-denial — `Spec-023 §Rules every console surface obeys`
 * keeps eligibility off the renderer, and what is read here is the daemon's own
 * reported state.
 *
 * The withheld arm carries its own sentence so no call site invents one, and so the
 * card never disables a control without saying why.
 */
export type BindControlPosture =
  | { readonly offered: true }
  | { readonly offered: false; readonly withheldBecause: string };

const BIND_CONTROLS_OFFERED: BindControlPosture = { offered: true };

export function bindControlPosture(mount: RepoMountReadResponse): BindControlPosture {
  if (mount.state !== "attached") {
    return {
      offered: false,
      withheldBecause: LIFECYCLE_READINGS[mount.state].sentence,
    };
  }
  if (mount.health.status !== "healthy") {
    return {
      offered: false,
      withheldBecause: HEALTH_READINGS[mount.health.status].sentence,
    };
  }
  return BIND_CONTROLS_OFFERED;
}
