// The composed refusal, driven against a pane body that never arrives. `settled-capture.test.ts`
// drives the pure half (kinds in, a throw out) and
// `components/LazyBody/pending-body-marker.test.ts` drives the DOM read against a planted
// marker. Neither mounts anything, so the link that could fail in practice was unproven: a real
// pane, mounted from a real registration whose module has not landed, handed to the real
// `captureSettled`. The planted failure is the tier photographing the reserved region because
// the lazily imported body has not loaded. Both directions run, because a refusal that fired on
// everything would satisfy the pending case; the loaded case asserts the capture is reached.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";
import { captureSettled } from "./settled-capture.js";

import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import type { PaneContext } from "@renderer/registries/panes/pane-context.js";
// The module that declares it: `LazyBodyModule` is the loader's own return type.
import type { LazyBodyModule } from "@renderer/components/LazyBody/lazy-body.js";

/** The kind the planted registration claims. Any real kind; the body is synthetic. */
const PLANTED_KIND = "browser";

/** The owner a planted registration declares, which no feature uses. */
const PLANTED_OWNER = "pending-body-refusal-control";

/**
 * A pane context carrying only what the reserved region reads (`kind`, `sessionStore`, whether an
 * `entity` is present), like `syntheticPaneContextAt` in `tests/helpers/lazy-body-contexts.ts`.
 * Standing up a bridge and three stores to prove a refusal would be a fixture testing the
 * fixture; the cast says so.
 */
function plantedPaneContext(): PaneContext {
  return {
    kind: PLANTED_KIND,
    sessionStore: undefined,
  } as unknown as PaneContext;
}

/** A registry holding one kind whose module is still in flight, forever. */
function registryWithPendingBody(): PaneRegistry {
  const registry = new PaneRegistry();
  registry.register({
    kind: PLANTED_KIND,
    owner: PLANTED_OWNER,
    body: () => new Promise<LazyBodyModule<PaneContext>>(() => undefined),
  });
  return registry;
}

/** The same, with a body that lands — preloaded, as every mount helper preloads. */
async function registryWithLoadedBody(): Promise<PaneRegistry> {
  const registry = new PaneRegistry();
  registry.register({
    kind: PLANTED_KIND,
    owner: PLANTED_OWNER,
    body: () => Promise.resolve({ Body: () => <p>the body that arrived</p> }),
  });
  await registry.preload(PLANTED_KIND);
  return registry;
}

async function mountPane(registry: PaneRegistry): Promise<HTMLElement> {
  const { container } = await renderSettled(
    <>{registry.descriptorFor(PLANTED_KIND)?.render(plantedPaneContext())}</>,
  );
  return container;
}

describe("the capture refusal, over a real mount", () => {
  // The planted failure. Without the refusal this capture succeeds and writes a stable image of
  // the pane's chrome alone.
  it("refuses a capture whose pane body has not arrived, and names the kind", async () => {
    const container = await mountPane(registryWithPendingBody());

    await expect(captureSettled(container, "planted-pending-body-control")).rejects.toThrowError(
      new RegExp(`Refusing to capture[\\s\\S]*${PLANTED_KIND}`, "u"),
    );
  });

  // The other direction: the refusal lets a settled tree through and the capture is written. The
  // `probe-` prefix marks that this writes a planted registry fixture, not a console view, in the
  // directory a person opens to look at the console.
  it("takes the capture once the body has landed", async () => {
    const container = await mountPane(await registryWithLoadedBody());

    await expect(captureSettled(container, "probe-planted-loaded-body")).resolves.toBeUndefined();
  });
});
