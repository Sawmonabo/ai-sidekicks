// The agent console's DECK body, as the registry loads it.
//
// A LOADER-BACKED BODY, so the machines column, the cards, and the two forms that move
// a binding are not on the initial import graph. The pane opens from the sidebar's
// agents section; nothing paints it before a person asks for one.
//
// BOTH MOUNTS ARE BEHIND A BOUNDARY. `agent-console-mounts.ts` also claims a surface
// slot for the auxiliary window, and that registration is a loader too — no main window
// routes to the slot at all, so a static one would put the whole binding surface on
// every window's initial graph to spare one window a frame.
//
// THE FAMILY'S FIVE CONSOLE SHEETS ENTER HERE AND AT THE SURFACE ROOT BESIDE THIS ONE.
// Either mount can be the first to render `AgentConsoleBody`, and neither may render it
// undressed, so both roots name the sheets and the bundler emits one shared asset for
// the pair. The sixth sheet — the sidekicks page's — stays at the family door, whose
// header states why. The move is admitted by the collision census
// (`test/console/architecture/stylesheet-selector-owners.test.ts`): no other family
// declares a class any of these five declares, so deferring them changes no surface but
// this family's own.
//
// The attach dialog's sheet is named AFTER the family's, which is the order its own
// rules already had inside `agents.css` and the order that sheet's grouped controls
// are written to win ties in.
import "./agent-console.css";
import "../agents.css";
import "../attach/attach.css";
import "../provider-switch/provider-switch.css";
import "../run-console/run-console.css";

import { createElement } from "react";

import { AgentConsoleBody } from "./AgentConsoleBody.js";
import { settingsRoute } from "../../routing/index.js";
import { ConsolePaneChrome, paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { SIDEKICK_DEFINITIONS_SECTION } from "../sidekick-definitions-section.js";

/**
 * The agent console, wearing the console's chrome, at an address the deck resolved.
 *
 * THE CHROME IS COMPOSED HERE RATHER THAN INSIDE THE BODY, because the body is also the
 * window's and the window draws its own frame. Everything the chrome is handed is read
 * off the pane's address: the session the pane's store is open on, the agent reference
 * the address carries, and the hue the deck attributed the pane with. It is handed no
 * `actions` — this kind has no head control of its own today, and an empty strip is what
 * that honestly renders as — and neither host control, because closing a pane and
 * tearing one off are the DECK's acts and reach the chrome through the context the deck
 * provides around every pane it lays out.
 *
 * `children` is passed as a PROP rather than as `createElement`'s third argument: the
 * chrome declares it required, and the variadic overload does not satisfy a required
 * `children` — it type-checks the props object on its own.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "agent-console",
  (context) =>
    createElement(ConsolePaneChrome, {
      kind: "agent-console",
      sessionId: context.sessionStore?.sessionId,
      entity: context.entity,
      focusHue: context.focusHue,
      children: createElement(AgentConsoleBody, {
        sessionId: context.sessionStore?.sessionId,
        agentId: context.entity?.id,
        bridge: context.bridge,
        sessionStore: context.sessionStore,
        // THE ONE MOUNT THAT CAN NAVIGATE. The deck lays this pane out inside the
        // main window's frame, so the settings rail is reachable from it and the
        // attach form's picker may offer the way to where definitions are kept. The
        // route is composed through the routing family's own constructor — the one
        // place the omit-versus-set-to-`undefined` rule that keeps an address
        // round-tripping is decided — and the section comes from the agents family's
        // own leaf constant, so this link and the registration that files the claim
        // read one string. The auxiliary window's root beside this one composes
        // none: it has no rail to reach.
        onOpenDefinitions: () => {
          context.frameStore.navigate(settingsRoute(SIDEKICK_DEFINITIONS_SECTION, undefined));
        },
      }),
    }),
);
