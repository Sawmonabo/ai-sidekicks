// The two axes a mount card reads on, and the capability axis beside them.
//
// THIS CONSOLE'S OWN RULE: mount LIFECYCLE and mount HEALTH never collapse into one
// chip. Each surface's composition — what it renders, offers, refuses, and folds —
// lives in the console's code, so a repos-surface rule is written where it is obeyed
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
// `unreachable`, and does not decide precedence between two failing verdicts — all
// three verdicts are the daemon's, and each is a Never of this module's own.
//
// THE THIRD VERDICT, AND WHY ITS COPY IS DIFFERENT IN KIND. `identity_mismatch` is a
// root that is still THERE and is no longer the repository it was attached as: the
// common directory re-derived from it no longer equals the identity anchor the attach
// persisted. That is not a degraded reading of `unreachable` and it is not a softer
// one — a probe answered, and what it answered is that this is a different repository.
// The daemon's binds and runs are already refusing on the persisted-identity match, so
// the console's obligation here is simple: a projection still answering `healthy` for
// a mount that can never bind again
// is a lying read model. The recovery is NAMED rather than implied — re-attach, which
// mints a new mount row — because the alternative reading of this verdict is that a
// participant waits for a root to come back that has not gone anywhere.

import type {
  ExecutionMode,
  RepoMountHealth,
  RepoMountReadResponse,
  VcsType,
} from "@ai-sidekicks/contracts";
import type { RepoMountState } from "@ai-sidekicks/contracts";
import type { ChipTone } from "../../primitives/index.js";
import type { ShellMutationBlock } from "../../store/index.js";
import { selectionInFlightCopy } from "./execution-mode-selection.js";

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
  identity_mismatch: {
    tone: "failure",
    label: "identity_mismatch",
    // WAITING IS THE WRONG MOVE HERE, which is what separates this sentence from the
    // one above it. `unreachable` can resolve on its own — a volume remounts, a network
    // path answers again — and this cannot: the path resolves fine and holds a different
    // repository, so no amount of waiting turns it back into the one that was attached.
    // The sentence therefore says the refusal is permanent for THIS row and names the
    // recovery, and the new-mount consequence is said here rather than left to the
    // confirm dialog, because a participant reads the card before they press anything.
    sentence:
      "The root is reachable but is no longer the repository this mount was attached as. Binds and runs on this mount refuse permanently; re-attaching the path mints a new mount and leaves this row as history.",
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
    // Terminal: there is no `detached -> attached` transition, so this row is history
    // and says so.
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
    // A non-git path binds as a plain directory with git-specific features disabled,
    // and such a workspace stays usable without pretending to support them.
    sentence:
      "A plain directory, bound with git-specific features off. It stays usable; the git-only modes are unavailable rather than hidden.",
  },
};

/**
 * Whether a card offers its bind controls, and what it says when it does not.
 *
 * This is a FAIL-CLOSED PROJECTION of daemon-reported state, not a renderer
 * eligibility rule. The daemon remains the only authority on whether a bind is
 * admissible and answers a refused one with its own typed code, which the card
 * renders; what this function decides is whether the console offers a control it
 * has already been told cannot succeed. Both cases are this module's: an `unreachable`
 * mount's bind controls are disabled with the reason said, and a `detached` row renders
 * as history. Neither is a pre-denial — eligibility stays off the renderer, and what
 * is read here is the daemon's own reported state.
 *
 * The withheld arm carries its own sentence so no call site invents one, and so the
 * card never disables a control without saying why.
 */
export type BindControlPosture =
  | { readonly offered: true }
  | { readonly offered: false; readonly withheldBecause: string };

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

const BIND_CONTROLS_OFFERED: BindControlPosture = { offered: true };

/**
 * Whether ONE workspace's binding controls are live, and what is holding them.
 *
 * THE SAME QUESTION AS `bindControlPosture`, ONE LEVEL DOWN, and it exists because two
 * controls on a workspace row ask it: the execution-mode picker and the root
 * preparation beneath it. They are two halves of one act — the picker names the mode a
 * run binds in, and the preparation puts that mode's root on disk — so a posture read
 * twice would be two rules, and the pair that drifted apart is exactly the pair that
 * shipped: the picker held itself for a pending switch and the preparation did not, so
 * a writable workspace could submit a prepare read off the `executionMode` the switch
 * was in the middle of replacing.
 *
 * TWO THINGS CLOSE THESE CONTROLS AND THE MOUNT'S IS FIRST, on `bindControlPosture`'s
 * own precedence: a mount that will refuse every bind is a fact about the row, and a
 * switch on the wire is a fact about this moment — so a detached row never reads as
 * something to wait out.
 *
 * FAIL-CLOSED PROJECTION AND NOT ELIGIBILITY, in every clause `bindControlPosture`
 * states it in: the daemon decides what it accepts and answers a refusal with its own
 * typed code. What is decided here is only whether the console offers a control it has
 * been told cannot succeed, and the held arm carries the sentence so no call site
 * invents one.
 */
export type WorkspaceControlPosture =
  | { readonly live: true }
  | { readonly live: false; readonly heldBecause: string };

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

const WORKSPACE_CONTROLS_LIVE: WorkspaceControlPosture = { live: true };

export function workspaceControlPosture(
  bindControls: BindControlPosture,
  pendingMode: ExecutionMode | undefined,
): WorkspaceControlPosture {
  if (!bindControls.offered) {
    return { live: false, heldBecause: bindControls.withheldBecause };
  }
  if (pendingMode !== undefined) {
    // The sentence the selection act already refuses a second press with — one
    // in-flight switch, one wording, wherever the participant meets it.
    return { live: false, heldBecause: selectionInFlightCopy(pendingMode) };
  }
  return WORKSPACE_CONTROLS_LIVE;
}

/**
 * The one sentence a workspace's binding controls are closed with, or `undefined`
 * while nothing closes them.
 *
 * TWO FACTS MEET HERE AND THE MOUNT'S GOES FIRST, which is `workspaceControlPosture`'s
 * own precedence carried one step further. A withheld posture is a fact about the ROW —
 * a detached mount, an unreachable root, a switch already on the wire — and a shell
 * block is a fact about this WINDOW's runtime. Reporting the transient one over the
 * permanent one would tell somebody to wait out a mount that has finished its life,
 * which is exactly what `bindControlPosture` refuses to do.
 *
 * A FUNCTION AND NOT A LINE AT EACH CONTROL, because the two controls this serves are
 * the pair `workspaceControlPosture` exists to keep in step: the picker names the mode
 * a run binds in and the preparation puts that mode's root on disk, and a fold written
 * twice is the shape that drifted the last time. The BLOCK is still read per control,
 * off the method that control dispatches — this folds the two readings, it does not
 * take one control's reading and spend it on another's.
 */
export function controlHoldSentence(
  posture: WorkspaceControlPosture,
  shellBlock: ShellMutationBlock | undefined,
): string | undefined {
  if (!posture.live) {
    return posture.heldBecause;
  }
  return shellBlock?.detail;
}
