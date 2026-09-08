// One start per session, held for as long as it is running rather than for as long as
// the picker is on screen.
//
// WHY THIS IS NOT IN THE PICKER'S BODY. The composer's `+` menu renders its panel only
// while the disclosure is open, so closing and reopening it UNMOUNTS and recreates the
// picker. A guard held in that body — a latch built by `useGenerationLatch`, a value
// held by `useSubjectScopedState` — is minted fresh on every open and starts idle, so a
// person who pressed a row, closed the menu and reopened it found every row offered
// again and pressed one, and the daemon took a second non-idempotent `workflowRunStart`
// while the first was still running. The disclosure is not the subject; the SESSION is.
//
// SO THE SUBJECT HOLDS THE STATE AND THE MOUNT SUBSCRIBES TO IT. One flight per
// `(growth port, session)`, minted when the first watcher arrives, and the picker reads
// it through `useSyncExternalStore` — so a picker remounted mid-flight reads `starting`
// from the same object, renders its rows closed, and names the definition that is
// starting, exactly as the picker that dispatched it did.
//
// THE PORT IS HELD WEAKLY AND THE ENTRY IS FORGOTTEN, which is what keeps a register
// that outlives every mount from being a leak. A closed window takes its flights with
// it, and within a live port an entry is dropped the moment nobody is watching it and
// nothing is running — the shape `bridge/queue/queue-feed.ts` already uses for a reading
// that must outlive one surface and no longer.
//
// WHAT OUTLIVES THE DISCLOSURE IS THE FLIGHT AND NOT THE RECEIPT. A settled act — a run
// that started, a refusal the daemon gave — is the answer to a press somebody is still
// looking at, so it survives for as long as a picker is watching and no longer. Kept
// past the close, a reopened menu would present a run id from some earlier visit as
// though it were news.
//
// AND ONE START REACHES THE DAEMON PER INTENDED ACT, WHICH THE HELD `act` CANNOT DECIDE.
// Publishing `starting` is what a LATER render reads; the value a press handler reads is
// the one from the render that produced it, so a double-click — or a press on one row
// followed by a press on another before the first answers — finds the picker idle twice
// and starts two runs, of which the shared `act` then shows whichever reply lands last.
// The guard is therefore taken at dispatch, from `store/generation-latch.ts`, which is
// the console's one register for exactly this and the mechanism every other act in this
// family already takes. The key is released on every settlement — served, refused, and a
// call that threw instead of answering — because a key held for the life of the flight
// would leave the picker permanently unable to start anything.
//
// ONE KEY FOR THE WHOLE MENU. The picker holds ONE act, so a second start in flight
// would be a second answer arriving into one line of chrome with nothing saying which is
// which — the rule is one start at a time across every row, and a caller whose rule is
// that states it by claiming one key. The session is not IN that key any more and does
// not need to be: the flight itself is the session's, so the latch's subject already
// carries what the key used to spell out, and one session's outstanding start cannot
// reach another session's register at all.
//
// A REFUSED SECOND PRESS PUBLISHES NOTHING, AND THAT IS THE HONEST ANSWER RATHER THAN A
// SWALLOWED ONE. The act is one value: a refusal written into it would erase the only
// true thing on screen — that a run is starting, and which one — and, because the rows
// are disabled on exactly that reading, would offer them again while the first start was
// still outstanding. What the second press asked for is already happening and already
// named; the surface says so, once, beside controls it has closed.
//
// EVERY REFUSAL IS CARRIED WHOLE, AND THE DAEMON'S OWN WORD IS THE ONE CARRIED. A port
// refusal has two arms and they put the readable code in two different places: the port
// answering for itself puts its own vocabulary on `code`, and a CALL that rejected puts
// `call-rejected` there and the daemon's envelope on `cause`. `workflow.start_denied` is
// the daemon's word, so a surface reading `code` alone would render `call-rejected` for
// exactly the refusal this path exists to surface — the defect `growth-outcome.ts`
// records, where one surface said `call-rejected` and its sibling said the daemon's code
// for the same failure. So the reading is resolved once, here, and the render is handed
// the pair rather than the union.

import {
  settleGrowthRead,
  type GrowthPort,
  type GrowthUnavailable,
  type SettledReadRefusal,
} from "../../bridge/index.js";
import { GenerationLatch, type GenerationClaim } from "../../store/index.js";
import type { WorkflowDefinitionRow } from "../definitions/definition-rows.js";

/** What the picker knows about the start it last asked for. */
export type WorkflowStartAct =
  | { readonly status: "idle" }
  | {
      readonly status: "starting";
      readonly definitionId: string;
      /** Named, because the rows are closed while this is true and one of them is why. */
      readonly definitionName: string;
    }
  | {
      readonly status: "started";
      readonly definitionId: string;
      readonly definitionName: string;
      readonly workflowRunId: string;
    }
  | {
      readonly status: "refused";
      readonly definitionId: string;
      /** The refusing wire's own code — the daemon's where the seam recovered one. */
      readonly code: string;
      /** That refusal's sentence, verbatim and never paraphrased. */
      readonly detail: string;
    };

/**
 * Nobody has pressed anything yet, which is where every session's menu opens.
 *
 * One frozen value rather than a fresh object per read, because it is what the hook's
 * snapshot answers with while no flight is held: a new object each call would tell
 * `useSyncExternalStore` the value had changed on every render.
 */
const WORKFLOW_START_IDLE: WorkflowStartAct = { status: "idle" };

/**
 * The one key a start is held under, on a subject that is already one session's.
 *
 * A constant and not a composed string: the flight IS the `(port, session)` pair, so a
 * key repeating the session would be the addressing stated twice in two places.
 */
const START_KEY = "workflow-start";

/** One session's start: what it last did, and whether another may be dispatched. */
class WorkflowStartFlight {
  readonly #growth: GrowthPort;
  readonly #sessionId: string;
  /** Called when this flight has nothing left to remember and nobody watching. */
  readonly #retire: () => void;
  readonly #dispatches = new GenerationLatch();
  readonly #watchers = new Set<() => void>();
  #act: WorkflowStartAct = WORKFLOW_START_IDLE;

  public constructor(growth: GrowthPort, sessionId: string, retire: () => void) {
    this.#growth = growth;
    this.#sessionId = sessionId;
    this.#retire = retire;
  }

  /** What the picker renders. A stored reference, so a re-read compares equal. */
  public get act(): WorkflowStartAct {
    return this.#act;
  }

  /**
   * Watch this flight, and stop.
   *
   * Stopping is what may retire the entry, so a picker closed while nothing is running
   * leaves the register as empty as it found it.
   */
  public watch(listener: () => void): () => void {
    this.#watchers.add(listener);
    return () => {
      this.#watchers.delete(listener);
      this.#retireIfSpent();
    };
  }

  /**
   * Start one run, unless one is already running for this session.
   *
   * The claim both decides and takes, in the same tick as the press, so no second press
   * can pass between the two.
   */
  public start(definition: WorkflowDefinitionRow, channelId: string | undefined): void {
    const claim = this.#dispatches.claim(this, START_KEY);
    if (claim === undefined) {
      return;
    }
    this.#publish({
      status: "starting",
      definitionId: definition.id,
      definitionName: definition.name,
    });
    void this.#dispatch(definition, channelId, claim);
  }

  /**
   * Put the start and settle whatever comes back.
   *
   * The call is INSIDE the `try`, so the key goes back on every exit a dispatch has: an
   * answer, a refusal the seam normalized, a rejection, and a publish that threw on the
   * way out. A `.finally` hung off the settlement would not cover a call that threw
   * before there was a promise to hang it on.
   */
  async #dispatch(
    definition: WorkflowDefinitionRow,
    channelId: string | undefined,
    claim: GenerationClaim,
  ): Promise<void> {
    try {
      const outcome = await settleGrowthRead(
        this.#growth.workflowRunStart({
          workflowVersionId: definition.latestWorkflowVersionId,
          sessionId: this.#sessionId,
          ...(channelId === undefined ? {} : { channelId }),
        }),
      );
      // The claim's own `settle` is the guard: it asks whether this round is still the
      // live one, which a teardown retires. The addressing needs no second guard — this
      // flight is one session's, so an answer can only ever be published under the
      // session it was asked of.
      claim.settle(() => {
        this.#publish(
          outcome.status === "served"
            ? {
                status: "started",
                definitionId: definition.id,
                definitionName: definition.name,
                workflowRunId: outcome.value.workflowRunId,
              }
            : { status: "refused", definitionId: definition.id, ...refusalReading(outcome) },
        );
      });
    } finally {
      claim.release();
      // A settlement that nobody was watching for is a settlement nobody will read, so
      // the entry goes rather than holding a receipt for a picker that has closed.
      this.#retireIfSpent();
    }
  }

  #publish(act: WorkflowStartAct): void {
    this.#act = act;
    for (const watcher of this.#watchers) {
      watcher();
    }
  }

  /**
   * Drop this entry when it holds nothing anybody could still want.
   *
   * Nothing running and nobody watching: a later picker mints a fresh flight and opens
   * idle, which is what it would have shown anyway. A start still outstanding keeps the
   * entry however long the disclosure stays closed — that is the whole point of it.
   */
  #retireIfSpent(): void {
    if (this.#watchers.size === 0 && this.#act.status !== "starting") {
      this.#retire();
    }
  }
}

/**
 * Every live start flight in this window, keyed by the growth port and the session.
 *
 * A `WeakMap` on the port so a closed window takes its flights with it, and the entry
 * itself is dropped once nobody is watching and nothing is running.
 */
class WorkflowStartFlights {
  readonly #bySession = new WeakMap<GrowthPort, Map<string, WorkflowStartFlight>>();

  /**
   * The act held for this pair, without minting anything.
   *
   * What the picker's snapshot reads: a render must not create the entry, because a
   * pass React discards would leave one behind that nothing will ever unwatch.
   */
  public heldAct(growth: GrowthPort, sessionId: string): WorkflowStartAct {
    return this.#bySession.get(growth)?.get(sessionId)?.act ?? WORKFLOW_START_IDLE;
  }

  /** Watch this pair's flight, minting it where the entry is free. */
  public watch(growth: GrowthPort, sessionId: string, listener: () => void): () => void {
    return this.#flight(growth, sessionId).watch(listener);
  }

  /** Start one run for this pair, unless one is already running for it. */
  public start(
    growth: GrowthPort,
    sessionId: string,
    definition: WorkflowDefinitionRow,
    channelId: string | undefined,
  ): void {
    this.#flight(growth, sessionId).start(definition, channelId);
  }

  /** The live flight for this pair, minting one where the entry is free. */
  #flight(growth: GrowthPort, sessionId: string): WorkflowStartFlight {
    let forPort = this.#bySession.get(growth);
    if (forPort === undefined) {
      forPort = new Map<string, WorkflowStartFlight>();
      this.#bySession.set(growth, forPort);
    }
    const held = forPort.get(sessionId);
    if (held !== undefined) {
      return held;
    }
    const forThisPort = forPort;
    // IDENTITY-CHECKED, not `delete(sessionId)`. A retiring flight may only remove
    // ITSELF: the entry under that key may already be a successor with watchers of its
    // own, and an unconditional delete would evict it — leaving a live flight nothing
    // can reach and a third one minted beside it.
    const created = new WorkflowStartFlight(growth, sessionId, () => {
      if (forThisPort.get(sessionId) === created) {
        forThisPort.delete(sessionId);
      }
    });
    forPort.set(sessionId, created);
    return created;
  }
}

/**
 * Which code and sentence a refusal actually says, across the port's two refusal arms.
 *
 * `cause` is present on exactly one of them — the arm for a call that rejected — and it
 * is where the daemon's envelope lands. Read through `in` rather than off the member,
 * because the settlement seam's own refusal shape declares none at all: it normalizes a
 * rejection into the console's one refusal directly, so its `code` IS the daemon's word
 * already and there is nothing nested to prefer.
 */
function refusalReading(refusal: GrowthUnavailable | SettledReadRefusal): {
  readonly code: string;
  readonly detail: string;
} {
  const cause = "cause" in refusal ? refusal.cause : undefined;
  return cause === undefined
    ? { code: refusal.code, detail: refusal.detail }
    : { code: cause.code, detail: cause.detail };
}

/**
 * The window's one register of start flights.
 *
 * A `const` holding an instance rather than a mutable binding — the shape the package
 * standard admits and `seats/composer-seat.ts` already takes. It is at module scope
 * because what it holds is a fact about this renderer and its ports rather than about
 * any one mount, which is exactly the property the picker's body could not supply, and
 * it is reached through the three named functions below rather than exported: the
 * register is this module's, exactly as `bridge/queue/queue-feed.ts` keeps its own.
 */
const workflowStartFlights = new WorkflowStartFlights();

/**
 * The act held for this address, minting nothing.
 *
 * `undefined` for the session — a picker the composer has not addressed at one — reads
 * idle rather than being an error: there is no question to put, so there is nothing a
 * start could have done.
 */
export function heldWorkflowStartAct(
  growth: GrowthPort,
  sessionId: string | undefined,
): WorkflowStartAct {
  return sessionId === undefined
    ? WORKFLOW_START_IDLE
    : workflowStartFlights.heldAct(growth, sessionId);
}

/** Watch this address's flight, and stop. A picker with no session watches nothing. */
export function watchWorkflowStartFlight(
  growth: GrowthPort,
  sessionId: string | undefined,
  listener: () => void,
): () => void {
  if (sessionId === undefined) {
    return stopWatchingNothing;
  }
  return workflowStartFlights.watch(growth, sessionId, listener);
}

/**
 * Start one run at this address, unless one is already running for it.
 *
 * A picker with no session has nothing to start rather than a narrower thing to start:
 * the request carries a required session id, so there is no call to put.
 */
export function startWorkflowRun(
  growth: GrowthPort,
  sessionId: string | undefined,
  definition: WorkflowDefinitionRow,
  channelId: string | undefined,
): void {
  if (sessionId === undefined) {
    return;
  }
  workflowStartFlights.start(growth, sessionId, definition, channelId);
}

/** Giving back a watch on a picker that had no session to start anything in. */
function stopWatchingNothing(): void {
  // Nothing was held, so nothing is given back.
}
