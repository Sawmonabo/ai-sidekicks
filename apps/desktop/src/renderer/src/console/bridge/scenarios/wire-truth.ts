// Does a scenario script events the daemon can actually emit?
//
// NOT a family scenario, despite living beside them. `scenarios/index.ts` is the
// seat board six family branches each add one line to; this is the predicate that
// reads whatever ends up on it. It sits here rather than in the test tier because
// a test that reimplemented the rule would be checking its own copy of it, and
// because the rule has to be one function for every family's scenario file to be
// held to it — a family that lands `bridge/scenarios/<family>.ts` with the same
// defects the substrate's own two scenarios shipped with must fail, and it does,
// without that family or its reviewer having to know this module exists.
//
// WHAT WIRE TRUTH IS, AND WHERE EACH LEG LIVES. `packages/contracts/src/event.ts`
// ships three schemas a scenario is measured against, and every beat meets all three
// — then the rules those schemas do not carry, because the run state machine is prose
// in `docs/domain/` and the run-lifecycle payloads have no registered variant at all.
// Not one of the latter is restated anywhere below: each is read off the single module
// in this tree that already owns it, so a beat this predicate admits is a beat the
// consumer of that rule admits too.
//
// One axis per module, each carrying the reasoning for its own:
//
//   • `wire-truth/beat-shape.ts` — the census, the canonical envelope, and the strict
//     layer, in that order, for every beat.
//   • `wire-truth/run-and-queue-semantics.ts` — the run state machine's transition
//     table, the queue payload's required member, the registered payloads of the four
//     run kinds no narrowed stream projects, and the registered projection
//     `run.subscribeState` delivers for the nine it does.
//   • `wire-truth/beat-order.ts` — the tick a beat is due at and the log position it
//     occupies.
//   • `wire-truth/reply-walk.ts` — one scripted answer per call, and one spendable
//     latency on that answer.
//   • `wire-truth/membership.ts` — the viewer a scenario states and the roles it
//     declares.
//   • `wire-truth/defect.ts` — what a defect is.
//
// WHERE A BEAT'S MEMBERS COME FROM WHEN THE STRICT LAYER REGISTERS NO VARIANT. This is
// the one rule every scenario on the board is written against, and it is stated here
// because this is the module that holds them all to it. The census and the strict layer
// are the CODE leg: they are what this predicate can execute, and they are not the whole
// registry. The per-family and per-type payload rows of
// `docs/specs/006-session-event-taxonomy-and-audit-log.md` are the TAXONOMY leg — the
// registry those strict variants are implemented from — and they name a registered
// type's members whether or not the variant for it has landed in code yet.
//
// So "`packages/contracts` names no members for this type" is never a reason for a
// scenario to decline a beat. A scenario that scripts such a type carries every member
// that spec's row makes REQUIRED of a post-amendment emitter, because a partial row
// teaches a surface to read a shape no daemon produces — the same class of defect as an
// invented member, and one nothing here can catch. A scenario that declines the beat
// declines it for a reason about the SESSION it is scripting, and says which.
//
// This file stays the aggregate entry and the one importable name. The predicate has
// to be one function for every family's scenario file to be held to it, and the
// specifier every consumer already carries is this one.

import { describeBeatDefect } from "./wire-truth/beat-shape.js";
import { findBeatOrderDefects } from "./wire-truth/beat-order.js";
import type { ScenarioWireTruthDefect } from "./wire-truth/defect.js";
import { describeViewerDefect, findMembershipRoleDefects } from "./wire-truth/membership.js";
import { findReplyDefects } from "./wire-truth/reply-walk.js";
import type { ConsoleScenario } from "../scenario.js";

export type { ScenarioWireTruthDefect };

/** Every wire-truth defect across the given scenarios. Empty is the passing state. */
export function findScenarioWireTruthDefects(
  scenarios: readonly ConsoleScenario[],
): readonly ScenarioWireTruthDefect[] {
  const defects: ScenarioWireTruthDefect[] = [];
  for (const scenario of scenarios) {
    for (const [beatIndex, beat] of scenario.beats.entries()) {
      const reason = describeBeatDefect(beat);
      if (reason !== undefined) {
        defects.push({
          scenarioId: scenario.id,
          subject: `beat ${String(beatIndex)} (${beat.event.kind})`,
          reason,
        });
      }
    }
    defects.push(...findBeatOrderDefects(scenario));
    defects.push(...findReplyDefects(scenario));
    const viewerDefect = describeViewerDefect(scenario);
    if (viewerDefect !== undefined) {
      defects.push(viewerDefect);
    }
    defects.push(...findMembershipRoleDefects(scenario));
  }
  return defects;
}
