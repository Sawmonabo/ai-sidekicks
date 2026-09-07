// The terminal scenario's reply table: what the fixture answers when a surface calls.
//
// Split out of `terminal.ts` so that file is the SCRIPT and this one is the answers,
// on the reason `terminal-cast.ts` was split for. The beats are read as a whole and in
// order, by the engine; a reply is looked up one at a time, by the method name a
// surface happened to call. Two audiences, two files — and the script's header keeps
// the argument about which beat follows which, while the argument about what is
// answered and why is here, beside the answers.
//
// THE REFUSALS ARE SCRIPTED, AND ONE OF THEM IS WHY. The three refusals
// (`pty.permission_denied` before any lease comparison, `pty.control_held_by_other`
// carrying the holder, `pty.control_not_held` on a release by a non-holder) are
// rejections of a CALL rather than transitions, so no beat can carry one. What carries
// one is `ScenarioRejectingReply`, and this scenario scripts the contested take: the
// collaborator holds the shell for most of the script, so a take issued while they
// hold it is refused `pty.control_held_by_other` naming them, which is the only
// refusal in the vocabulary that names anybody and therefore the only one that reaches
// the holder line beside the inline refusal.
//
// IT ANSWERS EVERY TAKE IN THIS SCENARIO, AND THAT IS STATED RATHER THAN HIDDEN. The
// reply table matches on the method NAME, so there is no beat-position arm to script
// one answer before the collaborator takes the shell and another after. That costs
// nothing here, because a SERVED take changes nothing a person can see: the pane's
// holder comes from the `pty.control_changed` beat and never from this reply
// (`lease-claim.ts`'s served arm sets no holder), so a scripted success would be an
// invisible no-op where the scripted refusal is the whole of what the surface draws.
//
// THE RELEASE IS SCRIPTED SERVED, and it is the one lease call that has an honest
// served form: the registered response frees the lease, so `controlHolder` is null and
// there is nothing to invent. It is scripted so the handback the owner is offered in
// the final held frame settles rather than refusing under a wire this fixture serves.

import type { ScenarioReply } from "../scenario-runtime/index.js";
import { TERMINAL_SCENARIO_CAST } from "./terminal-cast.js";

const COLLABORATOR = TERMINAL_SCENARIO_CAST.collaborator;

/**
 * The one read the scenario answers, and the two lease calls it settles.
 *
 * Everything the terminal family itself needs arrives as beats: the holder is a field
 * on `pty.control_changed`, and the host's presence is the `runtime_node.*` pair the
 * script carries — so no roster read is scripted, and a scripted reply nothing calls
 * would be a promise the wire has not made.
 */
export const TERMINAL_REPLIES: readonly ScenarioReply[] = [
  { call: "agent.list", result: { agents: [{ agentId: TERMINAL_SCENARIO_CAST.agent }] } },
  {
    // The contested take. `details` is the FLAT envelope's registered position for a
    // refusal's structured context — `core/wire-rejection.ts` reads it there, and
    // `core/refusal-extensions.ts` is the closed registry of what may be read out of
    // it — so the holder reaches `ClaimRefusalHolder` through exactly the reader a
    // live rejection reaches it through, with nothing in the surface knowing which
    // bridge produced it.
    call: "session.takeControl",
    refusal: {
      code: "pty.control_held_by_other",
      message: "Somebody else holds this session's shell. Ask them to release it, then try again.",
      details: { holderParticipantId: COLLABORATOR },
    },
  },
  {
    // The one lease call with an honest served form: the registered response frees
    // the lease, so the holder is null and nothing is invented.
    call: "session.releaseControl",
    result: { controlHolder: null },
  },
];
