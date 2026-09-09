// The composed refusal, driven against a pane body that never arrives.
//
// WHAT THIS ADDS TO THE TWO CONTROLS THAT ALREADY EXIST. `settled-capture.test.ts`
// drives the pure half — a list of kinds in, a throw out — and
// `seats/pane/pending-pane-body.test.ts` drives the DOM read against a planted marker.
// Neither one mounts anything, so between them they prove every link of the chain
// except the one that failed in practice: a REAL pane, mounted from a real
// registration whose module has not landed, handed to the real `captureSettled`.
//
// AND THE FAILURE IT PLANTS IS THE ONE THIS TIER ACTUALLY TOOK. A workflows capture
// came back 1440x1172 against a 1440x1751 image taken earlier, and the first
// hypothesis was
// exactly this: the pane's lazily imported body had not loaded and the tier had
// photographed the reserved region. It had not — the shortfall was a stylesheet that
// had moved out of the initial graph, which `apps/desktop/AGENTS.md` §Module shape now
// rules on — but the hypothesis was only cheap to rule out because the marker exists,
// and nothing was proving the marker reached the capture through a real mount.
//
// BOTH DIRECTIONS, BECAUSE ONE OF THEM IS VACUOUS ALONE. A refusal that fired on
// everything would satisfy the pending case perfectly, so the loaded case asserts the
// capture is REACHED: it settles, which only a call that got past the refusal can do.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";
import { captureSettled } from "./settled-capture.js";

import { ConsolePaneRegistry } from "../../../src/renderer/src/console/seats/index.js";
import type { ConsolePaneContext } from "../../../src/renderer/src/console/seats/index.js";
// The LEAF: `LazyBodyModule` is the loader's own return type and has no production
// reader through the seats door, which is the shape that door's header refuses a line
// for. `seats/lazy-body/lazy-body.test.tsx` reaches it the same way.
import type { LazyBodyModule } from "../../../src/renderer/src/console/seats/lazy-body/lazy-body.js";

/** The kind the planted registration claims. Any real kind; the body is synthetic. */
const PLANTED_KIND = "browser";

/** The owner a planted registration declares, which no family uses. */
const PLANTED_OWNER = "pending-body-refusal-control";

/**
 * A pane context carrying only what the reserved region reads.
 *
 * The same shape and the same reasoning as `seats/lazy-body/lazy-body.test.tsx`'s: the fallback
 * reads `kind`, `focusHue`, `sessionStore`, and whether an `entity` is present, and
 * standing up a bridge and three stores to prove a refusal would be a fixture testing
 * the fixture. The cast says so rather than hiding behind a builder.
 */
function plantedPaneContext(): ConsolePaneContext {
  return {
    kind: PLANTED_KIND,
    sessionStore: undefined,
    focusHue: undefined,
  } as unknown as ConsolePaneContext;
}

/** A registry holding one kind whose module is still in flight, forever. */
function registryWithPendingBody(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  registry.register({
    kind: PLANTED_KIND,
    owner: PLANTED_OWNER,
    body: () => new Promise<LazyBodyModule<ConsolePaneContext>>(() => undefined),
  });
  return registry;
}

/** The same, with a body that lands — preloaded, as every mount helper preloads. */
async function registryWithLoadedBody(): Promise<ConsolePaneRegistry> {
  const registry = new ConsolePaneRegistry();
  registry.register({
    kind: PLANTED_KIND,
    owner: PLANTED_OWNER,
    body: () => Promise.resolve({ Body: () => <p>the body that arrived</p> }),
  });
  await registry.preload(PLANTED_KIND);
  return registry;
}

async function mountPane(registry: ConsolePaneRegistry): Promise<HTMLElement> {
  const { container } = await renderSettled(
    <>{registry.descriptorFor(PLANTED_KIND)?.render(plantedPaneContext())}</>,
  );
  return container;
}

describe("the capture refusal, over a real mount", () => {
  // The planted failure. Without the refusal this capture SUCCEEDS — it photographs a
  // pane that is its own chrome and nothing else, and the image it writes is stable.
  it("refuses a capture whose pane body has not arrived, and names the kind", async () => {
    const container = await mountPane(registryWithPendingBody());

    await expect(captureSettled(container, "planted-pending-body-control")).rejects.toThrowError(
      new RegExp(`Refusing to capture[\\s\\S]*${PLANTED_KIND}`, "u"),
    );
  });

  // The other direction: the refusal lets a settled tree through, and the capture is
  // written. Under a tier that compares nothing this is the whole positive control —
  // a settled tree reaches the capture and the capture completes.
  //
  // The name carries a `probe-` prefix because this one DOES write, and what it writes
  // is a planted registry fixture rather than a console surface. The directory is the
  // one a person opens to look at the console, so a picture that is not of the console
  // says so in its own file name rather than only in the spec directory above it.
  it("takes the capture once the body has landed", async () => {
    const container = await mountPane(await registryWithLoadedBody());

    await expect(captureSettled(container, "probe-planted-loaded-body")).resolves.toBeUndefined();
  });
});
