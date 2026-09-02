// What a test of the sidekicks page needs before it can assert anything.
//
// Extracted rather than repeated, and extracted rather than left in one file: the
// page has six properties worth asserting and the scaffolding for them — a registry
// that answers and counts, an announcer on a clock that only runs when a test runs
// it, and the presses that reach a row's delete — is longer than any one of them.
// Kept in a `.test-support` module beside the page, on the `bridge/` precedent, so
// the file that holds the cases holds only cases.
//
// THE CLOCK IS HANDED BACK because the announcer HOLDS one message and queues the
// rest behind a deadline: on a frozen clock a second announcement is invisible in
// the live region, so a test that only read that region could not tell one
// announcement from two. Advancing past the hold is what makes the difference
// observable.

import { act, render } from "@testing-library/react";
import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SidekickDefinitionsPage } from "./DefinitionsPage.js";
import type { SidekickDefinitionRecord } from "./definition-rows.js";

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];
type ListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["sidekickDefinitionList"]>>;
type DeleteOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["sidekickDefinitionDelete"]>>;

const EMPTY_SCENARIO: FixtureScenario = {
  id: "agents-definitions-test",
  label: "Sidekick definitions, with nothing scripted",
  purpose: "Drives the sidekicks page against a registry whose replies this file supplies.",
  sessionId: "session-agents",
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

export function definition(
  overrides: Partial<SidekickDefinitionRecord> = {},
): SidekickDefinitionRecord {
  return {
    definitionId: "definition-1",
    name: "Reviewer",
    description: "Reads a diff and says what it would change.",
    driverName: "claude",
    modelId: "claude-opus-4-6",
    providerAccountId: "account-work",
    effort: "high",
    executionPostureMode: "workspace-sandboxed",
    instructions: "Be exact.",
    goal: "Ship a clean diff.",
    toolAllowlist: ["read", "grep"],
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-02T11:30:00.000Z",
    ...overrides,
  };
}

/**
 * A registry that answers, and counts what it was asked.
 *
 * The list replies are consumed in order and the last one repeats, so a test can
 * say what the registry looked like BEFORE a delete and what it looks like after
 * without scripting a whole engine. The counts are what let the re-read be
 * asserted at all: "the row is gone" is also true of a page that removed it itself.
 */
export class RegistryStub {
  readonly #lists: readonly ListOutcome[];
  readonly #deleteOutcome: DeleteOutcome;
  #listCallCount = 0;
  #deletedIds: string[] = [];

  public constructor(options: {
    readonly lists: readonly ListOutcome[];
    readonly deleteOutcome?: DeleteOutcome;
  }) {
    this.#lists = options.lists;
    this.#deleteOutcome = options.deleteOutcome ?? { status: "served", value: { deleted: true } };
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  public get deletedIds(): readonly string[] {
    return this.#deletedIds;
  }

  public bridge(): ConsoleBridge {
    const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    return {
      ...fixture,
      growth: {
        ...fixture.growth,
        sidekickDefinitionList: async () => {
          const index = Math.min(this.#listCallCount, this.#lists.length - 1);
          this.#listCallCount += 1;
          return await Promise.resolve(this.#lists[index] as ListOutcome);
        },
        sidekickDefinitionDelete: async (request: { readonly definitionId: string }) => {
          this.#deletedIds = [...this.#deletedIds, request.definitionId];
          return await Promise.resolve(this.#deleteOutcome);
        },
      },
    };
  }
}

export function served(definitions: readonly SidekickDefinitionRecord[]): ListOutcome {
  return { status: "served", value: definitions };
}

/**
 * Mount inside the announcer the page speaks through, on a clock that never runs
 * unless a test runs it.
 *
 * The clock is handed back because the announcer HOLDS one message and queues the
 * rest behind a deadline: on a frozen clock a second announcement is invisible in
 * the live region, so a test that only read that region could not tell one
 * announcement from two. Advancing past the hold is what makes the difference
 * observable.
 */
export function renderPage(bridge: ConsoleBridge): {
  readonly container: HTMLElement;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const { container } = render(
    <LiveAnnouncerProvider clock={clock}>
      <SidekickDefinitionsPage bridge={bridge} />
    </LiveAnnouncerProvider>,
  );
  return { container, clock };
}

/** Run the announcer's hold out, so anything queued behind the standing message shows. */
export async function releaseAnnouncementHold(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
    await Promise.resolve();
  });
}

/** Let the read, the delete, and the re-read the delete schedules all land. */
export async function settle(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

export function savedRegionOf(container: HTMLElement): Element {
  const region = container.querySelector('[aria-label="Saved sidekicks"]');
  if (region === null) {
    throw new Error("the page rendered no saved-sidekicks region");
  }
  return region;
}

export function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (control === null) {
    throw new Error(`no control named ${label}`);
  }
  return control;
}

export async function press(control: HTMLButtonElement | null | undefined): Promise<void> {
  await pressWithoutSettling(control);
  await settle();
}

/** Press and stop, so the frame while a call is in flight can be looked at. */
export async function pressWithoutSettling(
  control: HTMLButtonElement | null | undefined,
): Promise<void> {
  await act(async () => {
    control?.click();
    await Promise.resolve();
  });
}

/** The row's own confirm — the `Delete` that is not one of the per-row openers. */
export function confirmDeleteIn(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (control) => control.textContent === "Delete" && control.getAttribute("aria-label") === null,
  );
}
