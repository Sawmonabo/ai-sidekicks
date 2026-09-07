// Whether the centre still tells the truth after the person has answered the OS
// prompt.
//
// The fold maps `not-determined` to `permitted` on purpose — a machine nobody has
// asked yet is a machine whose first emission raises the system's own consent flow,
// and reporting that as a denial would put "this is the only surface" in front of
// somebody whose notifications work. What makes that mapping honest is that it is
// PROVISIONAL: the person answers the prompt, and this window has to notice.
//
// So both cases here assert on two things at once — how many times the machine was
// asked, and what the centre says — because a re-read that changes no sentence and a
// sentence that changed without a re-read are the same defect from opposite sides.
//
// The centre is rendered rather than the fold inspected, because the arm under test is
// the one arm of this reading that a person can see. Which of two overlapping probes
// decides the answer is `bridge/os-notification-permission.test.ts`', where the read
// itself lives; what is claimed here is that the centre reads THAT reading and that a
// window trigger reaches it.

import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../../bridge/readings/scheduled-read.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { settle } from "../../core/settle.test-support.js";
import { type AttentionReading } from "./attention-plane.js";
import { NotificationCenter } from "./NotificationCenter.js";
import {
  useOsNotificationDelivery,
  type OsNotificationDelivery,
} from "./os-notification-delivery.js";

/** What this machine reports, and how many times the console has asked it. */
type ShellPermissionState = "granted" | "denied" | "not-determined";

const SCENARIO = unscriptedScenario("os-notification-delivery-test");

/**
 * One machine's notification permission, as a bridge whose answer a case can move.
 *
 * A class holding one bridge rather than a builder handing back a fresh one: the
 * reading is addressed BY the bridge, so a stub re-minted per render would look like a
 * bridge swapped underneath and re-read for a reason no case asked for. The real
 * fixture bridge with one operation overridden, so the frozen clock the console's
 * schedulers arm on is the one these cases advance.
 */
class ShellPermissionMachine {
  readonly bridge: ConsoleBridge;
  #state: ShellPermissionState;
  #reads = 0;

  public constructor(state: ShellPermissionState) {
    this.#state = state;
    this.bridge = fixtureBridgeWithGrowth(SCENARIO, {
      shellNotificationPermissionRead: async () => {
        this.#reads += 1;
        return await Promise.resolve({ status: "served", value: { state: this.#state } });
      },
    });
  }

  /** How many times the console has put the question. */
  public get reads(): number {
    return this.#reads;
  }

  /** The person answers the system prompt. */
  public decide(state: ShellPermissionState): void {
    this.#state = state;
  }
}

/** The projection arm every case here holds still, so only the delivery arm moves. */
const READING_IN_FLIGHT: AttentionReading = { phase: "reading" };

/**
 * The fold, mounted under the surface that renders its one visible arm.
 *
 * `answers` collects the value at each commit that re-identified it, which is the
 * only way to see the difference between a re-read that published a new answer and
 * one that published the same object twice.
 */
function DeliveryProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly answers?: OsNotificationDelivery[];
}): React.JSX.Element {
  const delivery = useOsNotificationDelivery(props.bridge);
  const { answers } = props;
  useEffect(() => {
    answers?.push(delivery);
  }, [answers, delivery]);
  return <NotificationCenter reading={READING_IN_FLIGHT} delivery={delivery} />;
}

/** The sentence the centre shows when it is the only surface these items reach. */
function onlySurfaceSentence(container: HTMLElement): string | undefined {
  return container.querySelector(".meridian-attention__only-surface")?.textContent ?? undefined;
}

/** Mount, and let the probe the subscribe trigger scheduled reach the centre. */
async function mountSettled(
  machine: ShellPermissionMachine,
  answers?: OsNotificationDelivery[],
): Promise<HTMLElement> {
  const { container } = render(
    <DeliveryProbe bridge={machine.bridge} {...(answers === undefined ? {} : { answers })} />,
  );
  await settleScheduledRead(machine.bridge);
  await settle();
  return container;
}

/** The window coming back to the person who just answered a system prompt. */
async function refocusWindow(machine: ShellPermissionMachine): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await settleScheduledRead(machine.bridge);
  await settle();
}

describe("this machine's notification permission", () => {
  it("is read again on focus, so a denial answered in the prompt reaches the centre", async () => {
    // The defect, end to end. Read once and never again, this window went on
    // suppressing the only-surface sentence and treating every later undelivered
    // notification as delivered, for the life of the bridge.
    const machine = new ShellPermissionMachine("not-determined");
    const container = await mountSettled(machine);

    expect(machine.reads).toBe(1);
    expect(onlySurfaceSentence(container)).toBeUndefined();

    machine.decide("denied");
    await refocusWindow(machine);

    expect(machine.reads).toBe(2);
    expect(onlySurfaceSentence(container)).toContain("the only place these items reach you");
  });

  it("negative control: a permission that did not move says nothing on the way back", async () => {
    // Without this the case above would pass over a centre that showed the sentence
    // on every focus, which is the same window lying in the other direction.
    const machine = new ShellPermissionMachine("granted");
    const container = await mountSettled(machine);
    await refocusWindow(machine);

    expect(machine.reads).toBe(2);
    expect(onlySurfaceSentence(container)).toBeUndefined();
  });

  it("publishes one value per answer, so an unchanged permission re-renders nothing", async () => {
    // The re-read is on a focus, which a person performs freely. A fresh object per
    // settlement would re-render the centre and re-mint the window attention
    // binding's context value every time somebody came back to the window.
    const machine = new ShellPermissionMachine("granted");
    const answers: OsNotificationDelivery[] = [];
    await mountSettled(machine, answers);
    await refocusWindow(machine);

    expect(machine.reads).toBe(2);
    expect(answers.map((answer) => answer.status)).toStrictEqual(["unread", "permitted"]);
  });
});
