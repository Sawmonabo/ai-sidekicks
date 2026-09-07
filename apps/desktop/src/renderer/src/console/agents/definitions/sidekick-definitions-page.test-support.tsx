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

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { settleScheduledRead } from "../../bridge/readings/scheduled-read.test-support.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../../core/index.js";
import { settle as settleReactWork } from "../../core/settle.test-support.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SidekickDefinitionsPage } from "./SidekickDefinitionsPage.js";
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
  readonly #holdsDeletes: boolean;
  #listCallCount = 0;
  #deletedIds: string[] = [];
  #heldDeletes: (() => void)[] = [];

  public constructor(options: {
    readonly lists: readonly ListOutcome[];
    readonly deleteOutcome?: DeleteOutcome;
    /**
     * Hold every delete open until {@link releaseDeletes} is called.
     *
     * What a second press while the first is still running can only be driven
     * against: with an immediate reply there is no moment at which two deletes are
     * both in flight, so a page that ran them both would look identical to one that
     * ran them in turn.
     */
    readonly holdsDeletes?: boolean;
  }) {
    this.#lists = options.lists;
    this.#deleteOutcome = options.deleteOutcome ?? { status: "served", value: { deleted: true } };
    this.#holdsDeletes = options.holdsDeletes ?? false;
  }

  /** Let every held delete answer. Safe with none held. */
  public async releaseDeletes(): Promise<void> {
    const held = this.#heldDeletes;
    this.#heldDeletes = [];
    for (const release of held) {
      release();
    }
    await settle();
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  public get deletedIds(): readonly string[] {
    return this.#deletedIds;
  }

  public bridge(): ConsoleBridge {
    const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    const built: ConsoleBridge = {
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
          if (!this.#holdsDeletes) {
            return await Promise.resolve(this.#deleteOutcome);
          }
          return await new Promise<DeleteOutcome>((resolve) => {
            this.#heldDeletes = [
              ...this.#heldDeletes,
              () => {
                resolve(this.#deleteOutcome);
              },
            ];
          });
        },
      },
    };
    // Recorded so {@link settle} can reach the frozen clock this bridge's reads are
    // scheduled against — see that function.
    bridgeUnderTest = built;
    return built;
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
    await crossMacrotaskBoundary();
  });
}

/**
 * The bridge the page or the view under test is reading through.
 *
 * Module state rather than a parameter because {@link settle} is called from forty-odd
 * places across this page's three suites and from {@link RegistryStub} itself, and
 * threading a bridge through every one of them would state nothing a reader needs:
 * exactly one page is mounted at a time here, over the bridge the stub just minted.
 */
let bridgeUnderTest: ConsoleBridge | undefined;

/**
 * Let the read, the delete, and the re-read the delete schedules all land.
 *
 * TWO WAITS, BECAUSE THE PAGE HAS TWO KINDS OF READ. The opening read goes through
 * the registry view's `RefreshScheduler`, so the frozen clock has to reach the
 * window's deadline before anything is on the wire at all; the re-read a delete
 * performs is taken directly and only needs its own chain to settle. Doing the first
 * without the second leaves the reply uncommitted, and the second without the first
 * asserts against a page that was never given a chance to ask.
 *
 * No depth is stated, which is the point: this page's chain used to be counted at six
 * and the seventh link would have gone unwaited for. `core/`'s settle crosses a
 * boundary instead — see that module.
 */
export async function settle(): Promise<void> {
  if (bridgeUnderTest !== undefined) {
    await settleScheduledRead(bridgeUnderTest);
  }
  await settleReactWork();
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
    await crossMacrotaskBoundary();
  });
}

/** The row's own confirm — the `Delete` that is not one of the per-row openers. */
export function confirmDeleteIn(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (control) => control.textContent === "Delete" && control.getAttribute("aria-label") === null,
  );
}
