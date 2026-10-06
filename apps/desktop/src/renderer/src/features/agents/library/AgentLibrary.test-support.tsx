// What a test of the agent library needs before it can assert anything: a registry stub that
// answers and counts, an announcer on a frozen clock, and the presses that reach a row's
// delete. Kept beside the page so the case files hold only cases.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, render } from "@testing-library/react";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import type {
  AgentDefinition,
  AgentDefinitionId,
  AgentProviderBinding,
} from "@ai-sidekicks/contracts/agent/definition";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { unscriptedScenario } from "#test/helpers/fixture/bridge.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { ManualClock, type Clock } from "#renderer/lib/clock.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { settle as settleReactWork } from "#test/helpers/settle.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { AgentLibrary } from "./AgentLibrary.js";
import type { AgentRegistryCalls } from "./view.js";

/**
 * A registry that answers, and counts what it was asked. List replies are consumed in order
 * and the last repeats; the counts let a re-read be asserted, since "the row is gone" is also
 * true of a page that removed it itself.
 */
export class RegistryStub {
  public readonly bridge: PlatformBridge;
  /** The clock the page's window runs on: the scenario's frozen one. */
  public readonly clock: Clock;
  public readonly calls: AgentRegistryCalls;
  readonly #lists: readonly (readonly AgentDefinition[])[];
  readonly #holdsDeletes: boolean;
  #listCallCount = 0;
  #deletedIds: string[] = [];
  #heldDeletes: (() => void)[] = [];

  public constructor(options: {
    readonly lists: readonly (readonly AgentDefinition[])[];
    /**
     * Hold every delete open until {@link releaseDeletes} is called, so two deletes can be in
     * flight at once (an immediate reply never has two).
     */
    readonly holdsDeletes?: boolean;
  }) {
    this.#lists = options.lists;
    this.#holdsDeletes = options.holdsDeletes ?? false;
    const { bridge, scenarioEngine } = createFixtureBridge({
      scenario: unscriptedScenario("agents-definitions-test"),
    });
    this.bridge = bridge;
    this.clock = scenarioEngine.clock;
    this.calls = {
      listDefinitions: async () => {
        const index = Math.min(this.#listCallCount, this.#lists.length - 1);
        this.#listCallCount += 1;
        return await Promise.resolve(this.#lists[index] as readonly AgentDefinition[]);
      },
      deleteDefinition: async (request) => {
        this.#deletedIds = [...this.#deletedIds, request.definitionId];
        if (!this.#holdsDeletes) {
          return;
        }
        await new Promise<void>((resolve) => {
          this.#heldDeletes = [...this.#heldDeletes, resolve];
        });
      },
    };
  }

  /**
   * Lets the read, the delete, and the re-read the delete schedules all land. Two waits: the
   * opening read goes through the view's `RefreshScheduler`, so this stub's frozen clock must
   * reach its deadline first, while the delete's re-read only needs its own chain to settle.
   */
  public async settle(): Promise<void> {
    await settleScheduledRead(this.clock);
    await settleReactWork();
  }

  /** Let every held delete answer. Safe with none held. */
  public async releaseDeletes(): Promise<void> {
    const held = this.#heldDeletes;
    this.#heldDeletes = [];
    for (const release of held) {
      release();
    }
    await this.settle();
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  public get deletedIds(): readonly string[] {
    return this.#deletedIds;
  }
}

/** One saved definition with every member filled, pinned on Claude. */
export function definition(overrides: DefinitionOverrides = {}): AgentDefinition {
  const { definitionId = "definition-1", defaultBinding = {}, ...members } = overrides;
  return {
    definitionId: definitionId as AgentDefinitionId,
    name: "Reviewer",
    description: "Reads a diff and says what it would change.",
    icon: null,
    accentHue: null,
    bindings: {
      default: {
        driverName: "claude",
        modelId: "claude-opus-4-6",
        providerAccountId: "account-work" as ProviderAccountId,
        effort: "high",
        ...defaultBinding,
      },
      overrides: [],
    },
    instructions: "Be exact.",
    goal: "Ship a clean diff.",
    toolAllowlist: ["read", "grep"],
    turnCap: null,
    hooks: null,
    memoryScope: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-02T11:30:00.000Z",
    ...members,
  };
}

/** Mounts inside the announcer the page speaks through, on a clock that never runs. */
export function renderAgentLibrary(stub: RegistryStub): { readonly container: HTMLElement } {
  const { container } = render(
    <PlatformBridgeProvider bridge={stub.bridge} clock={stub.clock}>
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <AgentLibrary bridge={stub.bridge} calls={stub.calls} />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>,
  );
  return { container };
}

/** The saved agents region; throws where the page rendered none. */
export function savedRegionOf(container: HTMLElement): Element {
  const region = container.querySelector('[aria-label="Saved sidekicks"]');
  if (region === null) {
    throw new Error("the page rendered no saved agents region");
  }
  return region;
}

/** The button with this aria-label; throws where none exists. */
export function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (control === null) {
    throw new Error(`no control named ${label}`);
  }
  return control;
}

/** Presses a control and lets the page over this stub settle. */
export async function press(
  stub: RegistryStub,
  control: HTMLButtonElement | null | undefined,
): Promise<void> {
  await act(async () => {
    control?.click();
    await crossMacrotaskBoundary();
  });
  await stub.settle();
}

/** The row's own confirm — the `Delete` that is not one of the per-row openers. */
export function confirmDeleteIn(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (control) => control.textContent === "Delete" && control.getAttribute("aria-label") === null,
  );
}

/**
 * What a case changes on {@link definition}: any member, the id as plain text, and the
 * default binding's members.
 */
interface DefinitionOverrides extends Partial<Omit<AgentDefinition, "definitionId">> {
  readonly definitionId?: string;
  readonly defaultBinding?: Partial<AgentProviderBinding>;
}
