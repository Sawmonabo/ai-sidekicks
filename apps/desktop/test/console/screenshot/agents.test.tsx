// The screenshot tier for the agents family: the console pane, the two forms that move
// a binding, and the page where saved definitions are kept.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.
//
// WHAT IS PINNED, AND WHY EACH OF IT IS A PICTURE RATHER THAN AN ASSERTION.
//
//   • THE CONSOLE PANE. Four columns whose contents are four different KINDS of answer
//     at once — a served roster, a refused node roster, a seat another plan fills, and
//     two session-scoped projections — and the family's hardest rule is a layout claim:
//     the effective binding and a pending switch are two lines, and the effective one
//     does not move until a terminal settlement lands. A DOM assertion reading two nodes
//     cannot see that they read as one line; an image can.
//   • THE PROVIDER SWITCH, once an axis is edited. That is the only state in which the
//     form says what submitting would COST — the cache note, the supersedes line naming
//     the intent this one would displace, and the two apply actions — and all four
//     appear together or not at all.
//   • THE ATTACH DIALOG on its definition arm, which is the family's one overlay: a
//     popup in the window's airspace carrying the account axis, whose picker, per-account
//     advisories and clear control are four compositions stacked in one field.
//   • THE SIDEKICKS PAGE with rows served, which is a settings section rather than a
//     surface of a session — the one place a person meets these records at all.
//   • THE SWITCH SETTLEMENT on its applied arm with losses declared, which is four
//     clauses composed into one line — headline, continuity, the loss clause, and the
//     intent this one displaced. Which of them wraps, and whether the line still reads
//     as one sentence when they all appear, is a layout claim no DOM assertion makes.
//     WHICH of them appear is not: the fixture carried no displaced intent, so three
//     clauses were photographed under a claim about four, and the case below is what
//     holds the subject to the question the picture is taken to answer.
//
// TWO SCHEMES FOR THE TWO SURFACES A PERSON LIVES IN, ONE FOR THE TWO THEY VISIT. The
// pane and the page carry this family's whole palette — cards, chips, refusals, rules,
// rows — and are worth pinning in both. The switch form and the dialog are drawn from the
// same tokens on the same ground, so a second image of each would pin the token layer
// twice and the composition no further, and every capture costs a photograph on every
// run of the tier.
//
// PEER INVOCATION EARNS NO CAPTURE OF ITS OWN, deliberately. It is a session-scoped
// grant with no second settled state to distinguish — it is inside the pane capture's
// fourth column already, and a capture of its own would photograph the same pixels
// under a second name.
//
// HOW MANY CAPTURES THERE ARE IS DERIVED AND NEVER WRITTEN DOWN — the cross product is
// taken once, below, so the count the uniqueness case asserts is the same value the loop
// runs rather than a second figure that goes stale when a surface joins the table.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountAgentConsolePane,
  mountAttachDialogOnDefinitionArm,
  mountProviderSwitchPendingSupersession,
  mountProviderSwitchSettlement,
  mountSidekickDefinitionsPage,
} from "../surfaces/agents.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { type ConsoleScheme } from "../../../src/renderer/src/console/tokens/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * The schemes a surface is pinned in where one is enough.
 *
 * Named rather than spelled as a slice of {@link CONSOLE_SCHEMES}, because a slice would
 * silently become a different set the day a third scheme is registered — and which
 * scheme these two are captured in is a decision rather than a position in a list.
 */
const LIGHT_ONLY: readonly ConsoleScheme[] = ["light"];

/**
 * The surfaces this tier pins, each with the name it is committed under.
 *
 * A table rather than one case per surface: the cases differ only in what is mounted and
 * which schemes it is worth mounting in, and a copy of the same six lines per surface is
 * one more place for the scheme emulation or the skip guard to be forgotten.
 */
const PINNED_SURFACES: readonly {
  readonly captureName: string;
  readonly schemes: readonly ConsoleScheme[];
  readonly mount: () => Promise<HTMLElement>;
}[] = [
  {
    captureName: "agents-console-pane",
    schemes: CONSOLE_SCHEMES,
    mount: mountAgentConsolePane,
  },
  {
    captureName: "agents-sidekick-definitions",
    schemes: CONSOLE_SCHEMES,
    mount: mountSidekickDefinitionsPage,
  },
  {
    captureName: "agents-attach-dialog",
    schemes: LIGHT_ONLY,
    mount: mountAttachDialogOnDefinitionArm,
  },
  {
    captureName: "agents-provider-switch-pending",
    schemes: LIGHT_ONLY,
    mount: mountProviderSwitchPendingSupersession,
  },
  {
    captureName: "agents-switch-settlement",
    schemes: LIGHT_ONLY,
    mount: mountProviderSwitchSettlement,
  },
];

/**
 * Every capture this file writes, one per surface per scheme it declared.
 *
 * The cross product is taken ONCE and named, so the count the case below asserts is the
 * same value the loop runs and cannot be a second, hand-kept figure that drifts from it.
 */
const PINNED_CAPTURES: readonly {
  readonly captureName: string;
  readonly scheme: ConsoleScheme;
  readonly mount: () => Promise<HTMLElement>;
}[] = PINNED_SURFACES.flatMap((surface) =>
  surface.schemes.map((scheme) => ({
    captureName: `${surface.captureName}-${scheme}`,
    scheme,
    mount: surface.mount,
  })),
);

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under whichever
  // scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the agents family's surfaces", () => {
  // This one runs everywhere, including off the pinned platform: it reads the table
  // rather than the renderer. A duplicate capture name is silent on the machine that
  // mints — the second capture overwrites the first and both cases go green against one
  // image — so the uniqueness claim is asserted where it can be seen.
  it("writes one distinctly-named capture per surface per declared scheme", () => {
    expect(PINNED_CAPTURES).toHaveLength(
      PINNED_SURFACES.reduce((total, surface) => total + surface.schemes.length, 0),
    );
    expect(new Set(PINNED_CAPTURES.map((capture) => capture.captureName)).size).toBe(
      PINNED_CAPTURES.length,
    );
  });

  // This one runs everywhere too, and for the same reason: it reads what the subject
  // IS rather than how it looks, and a picture of a narrower state than the one the
  // header claims is a tidy picture that answers a question nobody asked.
  it("pins the settlement in the widest shape that line can render", async () => {
    const settlement = await mountProviderSwitchSettlement();

    for (const clause of ["headline", "continuity", "losses", "superseded"]) {
      expect(settlement.querySelector(`.meridian-settlement__${clause}`), clause).not.toBeNull();
    }
  });

  for (const capture of PINNED_CAPTURES) {
    it(`renders ${capture.captureName}`, async () => {
      // Through the system preference rather than a stamped attribute: the token
      // sheet's dark layer is a `prefers-color-scheme` block, and driving it is what a
      // default install actually resolves.
      await emulateSystemScheme(capture.scheme);
      const element = await capture.mount();

      await captureSettled(element, capture.captureName);
    });
  }
});
