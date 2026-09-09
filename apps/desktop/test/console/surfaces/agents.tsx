// The agents family's surfaces, mounted once for the tiers that look at them.
//
// Not a test file — no `include` glob reaches it as one. It sits beside the other
// family mount modules for their reason: `console-harness.tsx` owns HOW the console is
// mounted, and a module named for a family owns WHAT of that family is mounted into it.
//
// THREE MOUNTS OVER TWO DIFFERENT KINDS OF FIXTURE, AND THE SPLIT IS THE WIRE'S RATHER
// THAN A PREFERENCE. `bridge/scenario/agents/agents.ts` scripts the roster and both driver
// catalogs and deliberately scripts nothing else — it is a fixture about the two switch
// states, and a fixture that answered every wire a console reaches would be authoring
// wire shapes rather than describing a session. So:
//
//   • the CONSOLE PANE and the PROVIDER SWITCH are mounted over that scenario, which is
//     the richest settled state the family ships: an agent whose effective binding and
//     whose pending switch are two different lines, with the supersession the wire
//     carries no cancel for;
//   • the ATTACH DIALOG is mounted over the binding column's own held-call fixtures,
//     because the definition arm is DISABLED while the definition read has failed and
//     that scenario scripts no definition list — a dialog captured over it would pin the
//     arm a person cannot press and the link that arm is the only way to reach;
//   • the SIDEKICKS PAGE is mounted over the page's own registry stub, for the reason
//     its suites already mount it that way: the page reads a node-local registry that no
//     session scenario carries.
//
// Nothing here re-authors a fixture. Every roster row, definition record, registry reply
// and driver catalog below comes from the module the family already keeps it in, so a
// capture cannot drift from what the family's own suites are driven with.
//
// EVERY SESSION STORE OPENS WITH THE WINDOW'S OWN FOLD — {@link COMPOSED_CONSOLE_PROJECTORS}
// and never a registrar this file picked — so a partition a column reads is the one a
// window would have projected.
//
// AND EVERY MOUNT SETTLES ITS OWN READS. `renderSettled` flushes promises and moves no
// clock; each composition here arms a `RefreshScheduler` on the fixture's frozen one, so
// the advance is the second half of what settling MEANS for a surface that reads. Each
// mount then WAITS ON THE THING IT EXISTS TO SHOW rather than returning on the settle
// alone, because a capture of a skeleton is a green case in every tier that takes one.

import { waitFor } from "@testing-library/react";
import type { FunctionComponent, ReactNode } from "react";

import { renderSettled } from "../console-harness.js";

import {
  PROJECTION_SESSION_ID,
  settleReads,
} from "../../../src/renderer/src/console/agents/agent-console/agent-console.test-support.js";
import {
  HeldBindingMoveDaemon,
  bridgeCalling,
  editProviderAccount,
  openReadyAttachForm,
  type ScriptedDaemon,
} from "../../../src/renderer/src/console/agents/agent-console/agent-binding-column.test-support.js";
import { registryListReply } from "../../../src/renderer/src/console/agents/attach/account-axis/account-registry.test-support.js";
import {
  RegistryStub,
  definition,
  served,
  settle as settleRegistryRead,
} from "../../../src/renderer/src/console/agents/definitions/sidekick-definitions-page.test-support.js";
import { registerAgentConsolePane } from "../../../src/renderer/src/console/agents/index.js";
import { SwitchSettlementLine } from "../../../src/renderer/src/console/agents/provider-switch/SwitchSettlementLine.js";
import { SIDEKICK_DEFINITIONS_SECTION } from "../../../src/renderer/src/console/agents/sidekick-definitions-section.js";
import {
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../src/renderer/src/console/bridge/index.js";
import { AGENTS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenario/agents/agents.js";
import {
  AGENT_ARCHITECT,
  APPLIED_SWITCH_SETTLEMENT,
  ATTACHED_AGENTS,
  PROVIDER_ACCOUNT_PERSONAL,
  SESSION_ID,
} from "../../../src/renderer/src/console/bridge/scenario/agents/cast.js";
import {
  MAXIMUM_LIVE_DRAFT_COUNT,
  ManualClock,
} from "../../../src/renderer/src/console/core/index.js";
import { settle as settleReactWork } from "../../../src/renderer/src/console/core/settle.test-support.js";
import { DraftStore, UiStateStore } from "../../../src/renderer/src/console/persistence/index.js";
import { LiveAnnouncerProvider } from "../../../src/renderer/src/console/primitives/index.js";
import { type ConsolePaneContext } from "../../../src/renderer/src/console/seats/index.js";
import { consoleTestUiStateStore } from "../../../src/renderer/src/console/settings/settings-page-mount.test-support.js";
import {
  SettingsPageRegistry,
  type SettingsPageContext,
} from "../../../src/renderer/src/console/settings/settings-page-registry.js";
import { registerSidekicksPage } from "../../../src/renderer/src/console/sidekicks-settings-page.js";
import {
  FrameStore,
  SessionStore,
  UNREPORTED_SHELL_STATE,
  type ConsoleSessionEvent,
} from "../../../src/renderer/src/console/store/index.js";
import { resolvedPaneBody } from "./pane-body-resolution.js";
import { COMPOSED_CONSOLE_PROJECTORS } from "./projector-composition.js";

/**
 * The one element a mount hands back, or a throw naming what was missing.
 *
 * A throw rather than an optional return, so a surface that stopped rendering its root
 * fails here — where the message names the selector — instead of handing a tier an
 * absent element to compare a reference against.
 */
function requireRendered(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`the agents family rendered no ${selector}, so there is nothing to mount`);
  }
  return element;
}

/**
 * The agent console's DECK body, loaded, with its seven stylesheets in hand.
 *
 * Through the registry rather than by importing `AgentConsoleBody` directly, and that is
 * load-bearing twice: the pane body is the chunk root that names this family's sheets, so
 * a component mounted around it would render undressed; and it is the ONE mount that
 * composes `onOpenDefinitions`, which is what makes the attach form's link to the saved
 * definitions reachable at all.
 */
async function paneBodyComponent(): Promise<FunctionComponent<{ context: ConsolePaneContext }>> {
  const render = await resolvedPaneBody("agent-console", registerAgentConsolePane);
  return ({ context }) => render(context);
}

/**
 * The deck context a pane is mounted with, minus the two parts each caller decides.
 *
 * The agent is an argument because the pane's address union admits both: named, the
 * console is about one agent and draws that agent's card and its switch form; bare, it
 * draws the whole roster, which is the shape the attach mount below needs.
 */
function paneContext(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
  agentId: string | undefined,
): ConsolePaneContext {
  return {
    kind: "agent-console",
    paneId: "pane-agent-console-surface",
    entity: agentId === undefined ? undefined : { kind: "agent", id: agentId },
    frameStore: new FrameStore(),
    uiStateStore: UiStateStore.opening(),
    draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
    // Nothing opened this pane from another: every tier mounts one body directly.
    linkedSourcePaneId: undefined,
    focusHue: undefined,
    bridge,
    sessionStore,
  };
}

/**
 * A store holding the agents scenario's whole log, folded the way a window folds one.
 *
 * The beats rather than an empty store, because the columns beside the binding read
 * PROJECTED partitions — the peer-invocation grant and the child-run linkage — and a
 * store nothing was applied to answers every one of them with the empty map a session
 * with no history answers, which is a different picture wearing the same absence.
 */
function agentsSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: SESSION_ID,
    projectors: COMPOSED_CONSOLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  store.applyBatch(AGENTS_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent));
  return store;
}

/**
 * The pane mounted over the agents scenario at the agent that holds a pending switch.
 *
 * The ARCHITECT and not either row at random: it is the one carrying
 * `pendingSwitch` with a `replacedSwitchId`, which is the case the card exists for —
 * the effective binding on one line and an intent that has not applied on another.
 *
 * Returns the container so the callers below can reach past the pane region into the
 * switch form; each of them narrows to the element it captures.
 */
async function mountAgentsScenarioPane(): Promise<{
  readonly container: HTMLElement;
  readonly bridge: ConsoleBridge;
}> {
  const bridge = createFixtureBridge({ scenario: AGENTS_SCENARIO });
  const AgentConsolePaneBody = await paneBodyComponent();
  const { container } = await renderSettled(
    <AgentConsolePaneBody context={paneContext(bridge, agentsSessionStore(), AGENT_ARCHITECT)} />,
  );
  await settleReads(bridge);
  // Deliberately NOT inside `act`: the roster read resolves in a promise React knows
  // nothing about, and an `act` scope holds the resulting commit back until it exits,
  // so a wait placed inside one waits for a render its own scope prevents.
  await waitFor(() => {
    if (container.querySelector(".meridian-agent-card") === null) {
      throw new Error("the roster read has not landed yet");
    }
  });
  return { container, bridge };
}

/** The whole agent console pane, chrome and four columns, over the agents scenario. */
export async function mountAgentConsolePane(): Promise<HTMLElement> {
  const { container } = await mountAgentsScenarioPane();
  return requireRendered(container, ".meridian-pane");
}

/**
 * The provider-axis switch with one axis edited, which is where it states the
 * supersession.
 *
 * AN EDIT IS WHAT MAKES THE FORM SAY ANYTHING. Its cache note, its supersedes line —
 * "submitting supersedes the switch already pending" — and both of its apply actions
 * render only once the draft differs from the effective binding, so the form as it opens
 * is five axis controls and nothing else. The edit is the account axis, which is a plain
 * text input needing no popup to open, and the value is the account the scenario's own
 * pending switch proposes rather than a string invented here.
 */
export async function mountProviderSwitchPendingSupersession(): Promise<HTMLElement> {
  const { container } = await mountAgentsScenarioPane();
  editProviderAccount(container, PROVIDER_ACCOUNT_PERSONAL);
  await settleReactWork();
  return requireRendered(container, ".meridian-switch");
}

/**
 * One settled switch, as the line a person reads after a binding move lands.
 *
 * MOUNTED DIRECTLY RATHER THAN DRIVEN: reaching this state through the form costs an
 * edit, a submit, and an advance of the frozen clock past the settlement latency —
 * three moving parts to photograph a component whose whole input is one reply value,
 * and that value is the scenario's own, so the picture is of the settlement the
 * fixture serves rather than of a shape written for a picture. The pane body is
 * resolved first FOR ITS STYLESHEETS: this family imports no sheet through its door,
 * so a component mounted without that resolution pins a layout nobody ships.
 */
export async function mountProviderSwitchSettlement(): Promise<HTMLElement> {
  await paneBodyComponent();
  const { container } = await renderSettled(
    <SwitchSettlementLine
      settlement={APPLIED_SWITCH_SETTLEMENT}
      agentLabel={ATTACHED_AGENTS[1].name}
    />,
  );
  return requireRendered(container, ".meridian-settlement");
}

/**
 * A daemon answering every read the attach dialog opens, from the family's own fixtures.
 *
 * TWO SHIPPED FIXTURES RATHER THAN A THIRD SCRIPT. `HeldBindingMoveDaemon` already
 * answers the roster, both driver catalogs and the definition list; the account axis
 * opens the node's registry reading, which only the attach support module answers, and
 * `registryListReply` is where that reply lives. Composed here, nothing about either is
 * restated — and an unanswered registry would have captured the axis's "not read yet"
 * absence under a name claiming to show the field.
 *
 * The roster is EMPTY on purpose. A dialog is what this mount is about, and an empty
 * roster is the state whose one control opens it; a populated one would put a card and a
 * switch form behind a popup nothing photographs.
 */
function attachDialogDaemon(): ScriptedDaemon {
  const bindingDaemon = new HeldBindingMoveDaemon([]);
  return {
    // Narrower than the port's own `(method, params)`, and assignable for it: the
    // binding daemon answers on the method alone, so a `params` this composition
    // accepted and then dropped would read as a request shape it had decided to ignore.
    answer: async (method: string): Promise<unknown> =>
      method === "providerAccount.list"
        ? await Promise.resolve(registryListReply())
        : await bindingDaemon.answer(method),
  };
}

/**
 * The attach dialog, open on the definition arm, with the account axis and the link.
 *
 * THE ARM HAS TO BE PRESSED. `inline` is the form's opening arm, and the definition
 * picker — with it the "manage saved sidekicks" control that is the only route from a
 * session to where definitions are kept — renders on the other one. The press sequence is
 * the family's own `openReadyAttachForm`, so this mount holds no copy of what a ready
 * attach form is.
 *
 * The popup is queried off the DOCUMENT rather than the container: the dialog portals
 * into the window's airspace, which is a sibling of the tree the pane was rendered into.
 */
export async function mountAttachDialogOnDefinitionArm(): Promise<HTMLElement> {
  const bridge = bridgeCalling(attachDialogDaemon());
  const AgentConsolePaneBody = await paneBodyComponent();
  const sessionStore = new SessionStore({
    sessionId: PROJECTION_SESSION_ID,
    projectors: COMPOSED_CONSOLE_PROJECTORS,
  });
  const { container } = await renderSettled(
    // Bare rather than addressed, so the column draws the roster it was handed and the
    // empty state's one control is the whole of what stands behind the dialog.
    <AgentConsolePaneBody context={paneContext(bridge, sessionStore, undefined)} />,
  );
  await settleReads(bridge);
  await openReadyAttachForm(container);
  // A SECOND SETTLE, BECAUSE THE DIALOG OPENS A READ OF ITS OWN. The account axis holds
  // the node's account-plane reading and is mounted only while the dialog is, so the
  // registry read is armed by the press above and by nothing before it — a mount that
  // settled once would be photographing whichever of that read's arms the click's own
  // flushes happened to reach.
  await settleReads(bridge);
  const popup = requireRendered(document, ".meridian-attach__popup");
  // The account axis is the one field in this dialog whose root is a `div`; every other
  // is a `<label>`. So its trigger is the picker's rather than a sibling axis's, and its
  // presence is the served arm — the four absences that field can render draw a message
  // instead, so a capture taken over one of them would show no picker at all.
  await waitFor(() => {
    if (popup.querySelector("div.meridian-axis-field .meridian-axis-field__trigger") === null) {
      throw new Error("the provider-account registry read has not landed yet");
    }
  });
  return popup;
}

/**
 * The rows the sidekicks page is captured over.
 *
 * TWO, AND THE SECOND INHERITS. A definition stores `null` where it means "inherit", and
 * the row renders an inherited axis differently from a pinned one — so a page captured
 * over a single fully-pinned record would pin one of the two shapes the registry can
 * hold and report it as the page.
 */
const SAVED_DEFINITIONS = [
  definition(),
  definition({
    definitionId: "definition-2",
    name: "Prover",
    description: "Runs the suite and says what it found.",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    providerAccountId: null,
    effort: null,
    toolAllowlist: ["read", "bash"],
  }),
];

/** The settings context the sidekicks page is handed, with a session to attach into. */
function settingsPageContext(bridge: ConsoleBridge): SettingsPageContext {
  return {
    bridge,
    openSection: () => undefined,
    // With a session, because the per-row attach control is meaningless without one and
    // a page mounted with none renders no such control at all.
    retainedSessionId: PROJECTION_SESSION_ID,
    retainedSessionStore: undefined,
    selection: undefined,
    shellState: UNREPORTED_SHELL_STATE,
    uiStateStore: consoleTestUiStateStore(),
  };
}

/**
 * The sidekicks settings page, as the settings board loads it, over a served registry.
 *
 * THROUGH THE BOARD RATHER THAN AROUND IT. The page's stylesheet enters at its own chunk
 * root and the registration names that root through a loader, so resolving the section is
 * both how the sheet arrives and a check that the registration still resolves — a page
 * imported directly would render unstyled and prove nothing about the section.
 *
 * The announcer is mounted around it because the page announces what it settled on, and
 * `useAnnounce` throws outside its provider. Its clock is frozen: a live one would let a
 * held announcement expire mid-capture, which is a pixel difference no scenario decides.
 */
export async function mountSidekickDefinitionsPage(): Promise<HTMLElement> {
  const pages = new SettingsPageRegistry();
  registerSidekicksPage(pages);
  await pages.preload(SIDEKICK_DEFINITIONS_SECTION);
  const descriptor = pages.descriptorFor(SIDEKICK_DEFINITIONS_SECTION);
  if (descriptor === undefined) {
    throw new Error("no settings page is registered for the sidekick-definitions section");
  }
  const renderPage: (context: SettingsPageContext) => ReactNode = descriptor.render;
  const bridge = new RegistryStub({ lists: [served(SAVED_DEFINITIONS)] }).bridge();
  const { container } = await renderSettled(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      {renderPage(settingsPageContext(bridge))}
    </LiveAnnouncerProvider>,
  );
  await settleRegistryRead();
  await waitFor(() => {
    if (container.querySelector(".meridian-sidekick-row") === null) {
      throw new Error("the definition registry read has not landed yet");
    }
  });
  return requireRendered(container, ".meridian-sidekicks");
}
