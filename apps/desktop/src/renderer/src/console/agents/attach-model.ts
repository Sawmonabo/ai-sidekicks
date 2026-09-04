// The attach form's state: two arms of one form, and a per-field override mark.
//
// `Spec-023 §Console Design (Meridian)` §Attaching a sidekick makes this a FORM and
// not a wizard, and the shape of the request is what forces that: the union refuses
// exactly one thing, a request naming neither a definition nor a driver-and-model
// pair. Everything else is a field.
//
// TWO MEMBERS ARE REQUIRED ON BOTH ARMS — the session the agent joins and the name it
// is called by — because the registered request base requires them of every arm. They
// are not axes and neither is definition-resolved, so neither joins the override
// machinery below: the session is bound by the caller and the name is typed.
//
// THE OVERRIDE MARK IS THE POINT OF THE DEFINITION ARM. An explicitly present member
// wins FOR THAT FIELD ONLY, so the form pre-fills from the definition and sends only
// what the caller actually edited. That is why this class tracks presence rather
// than value equality: a caller who retypes the definition's own value has still
// explicitly said it, and a form that compared strings would silently drop that from
// the request and change what the daemon resolves.
//
// THE FIELDS ARE A CHAIN, BECAUSE THE VOCABULARIES ARE. A model belongs to one
// driver and an effort vocabulary is published per MODEL, so a driver chosen after a
// model does not merely change one field — it retires the vocabulary the other
// fields were chosen from. Left standing, those entries compose a request naming one
// driver and another driver's model, which the daemon can only refuse; a form that
// enabled Attach over it would be offering an act it knows will not be taken. So a
// driver change drops the entries the new driver's catalog does not carry, a model
// change drops an effort the new model does not publish, and readiness tests
// MEMBERSHIP rather than presence — because a catalog read can also move under a
// form nobody touched.
//
// AND THE CHAIN IS THE RESOLVED ONE, NEVER THE ENTERED HALF. On the definition arm
// most of the chain is INHERITED, and an override lands in the middle of it: a caller
// who overrides only the driver leaves the definition's own model and effort standing
// under a provider that publishes neither. Validating what was entered sees nothing
// wrong there, because nothing entered IS wrong — the request is well formed and the
// merge the daemon performs is not. So readiness resolves the whole chain the way the
// fields display it, entry over definition per field, and hands that to the rule
// `dependent-axis-chain.ts` holds for both forms that keep it. An inherited axis the
// entered driver retires cannot be dropped — it is the definition's, not the form's —
// so it is NAMED as still needed, which is what an override is for.
//
// THE PROVIDER ACCOUNT IS DROPPED ON A DRIVER CHANGE, UNCONDITIONALLY. An account is
// provider-scoped and no read this console has says which provider an account
// belongs to, so there is no vocabulary to check it against and carrying it forward
// would pin the new driver to an account nobody chose for it. Dropping it is visible
// — the field empties where a person can see it — while carrying it is a refusal at
// the daemon or, worse, a bill nobody agreed to.
//
// WHAT IT DOES NOT DO. It never substitutes a default for a pinned account that has
// gone missing — that would convert a legible refusal into a silent change of who
// pays — and it carries no `outputSpeed` field at all, because an agent is not born
// with a speed mode.
//
// THE CATALOG IS AN ARGUMENT AND NEVER A FIELD, for the reason the session is one:
// it is a read the models own, and a copy held here would be a second answer to a
// question already asked. It is REQUIRED rather than optional at both seams that
// need it, so no caller reaches them having quietly forgotten it — and `undefined`
// is a real state the caller passes deliberately, meaning the catalog has not been
// read, which fails closed: an entry no vocabulary can vouch for is not ready.
//
// A CLASS WITH PRIVATE FIELDS, not a hook body: it holds edited state and an
// emitter, and `apps/desktop/AGENTS.md` puts stateful logic here rather than in a
// render.

import { Emitter, type Unsubscribe } from "../core/index.js";
import type { SidekickDefinitionSummary } from "./agent-wire.js";
import {
  unvouchedAxesOf,
  DEPENDENT_AXES,
  type DependentAxis,
  type ResolvedAxisChain,
} from "./dependent-axis-chain.js";
import type { DriverCatalogReading } from "./driver-catalog.js";

/** Which arm the caller is filling. The definition arm needs only an id. */
export const ATTACH_ARMS = ["definition", "inline"] as const;
export type AttachArm = (typeof ATTACH_ARMS)[number];

/** The four fields either arm may carry. `outputSpeed` is deliberately not one. */
export const ATTACH_FIELDS = ["driverName", "modelId", "providerAccountId", "effort"] as const;
export type AttachField = (typeof ATTACH_FIELDS)[number];

/**
 * What each chain axis is called where the form says what is still needed.
 *
 * Words rather than field names, because this is read by a person: the chain rule
 * answers which axis no vocabulary carries and this says what to call it. The keys
 * are the chain's own, so an axis added there is a compile error here rather than an
 * axis that silently reports nothing.
 */
const UNVOUCHED_AXIS_WORDS: Record<DependentAxis, string> = {
  driverName: "a driver this catalog carries",
  modelId: "a model this driver carries",
  effort: "an effort this model carries",
};

/**
 * What the form would send, once it is complete.
 *
 * `sessionId` and `name` are required on BOTH arms because the registered request
 * base requires them, and a request missing either is refused by any conforming
 * daemon whatever else it carries. The session is not the form's to know — it is
 * bound by the caller at {@link AttachSidekickForm.readiness} — and the name is the
 * AGENT's rather than the definition's, which is why no arm ever fills it in.
 */
export interface AttachRequest {
  readonly sessionId: string;
  readonly name: string;
  readonly definitionId?: string | undefined;
  readonly driverName?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerAccountId?: string | undefined;
  readonly effort?: string | undefined;
}

export type AttachReadiness =
  | { readonly status: "ready"; readonly request: AttachRequest }
  | { readonly status: "incomplete"; readonly missing: readonly string[] };

export class AttachSidekickForm {
  readonly #changes = new Emitter<void>("attach form");
  #arm: AttachArm = "inline";
  #definition: SidekickDefinitionSummary | undefined;
  #entered = new Map<AttachField, string>();
  #name = "";

  /** Subscribe to edits. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  public get arm(): AttachArm {
    return this.#arm;
  }

  public get definition(): SidekickDefinitionSummary | undefined {
    return this.#definition;
  }

  /** What the agent will be called. Its own field, on neither arm's merge path. */
  public get name(): string {
    return this.#name;
  }

  /**
   * Name the agent.
   *
   * Never pre-filled from the chosen definition. The daemon resolves nothing for
   * this member — a definition's name is the DEFINITION's — so a value put here by
   * the form would be the console asserting a choice nobody made.
   */
  public setName(value: string): void {
    if (this.#name === value) {
      return;
    }
    this.#name = value;
    this.#changes.emit();
  }

  /**
   * Move to an arm.
   *
   * Entered values survive the move on purpose: a caller who typed a model and then
   * discovered a definition should not lose it, and the readiness check below is
   * what decides which of them the request carries.
   */
  public selectArm(arm: AttachArm): void {
    if (this.#arm === arm) {
      return;
    }
    this.#arm = arm;
    this.#changes.emit();
  }

  /**
   * Choose the definition the definition arm resolves through.
   *
   * Choosing a different one drops every override, because an override is a claim
   * about a specific definition's field and carrying it across would silently apply
   * it to a value the caller never saw.
   */
  public selectDefinition(definition: SidekickDefinitionSummary | undefined): void {
    this.#definition = definition;
    this.#entered = new Map();
    this.#arm = definition === undefined ? this.#arm : "definition";
    this.#changes.emit();
  }

  /**
   * Type into one field. An empty string clears the entry rather than sending one.
   *
   * Editing a field the others depend on drops whichever of them the new value's
   * vocabulary no longer carries — see the header. The catalog is passed rather than
   * held, and an absent one drops every dependent entry: an entry nothing can vouch
   * for is not one this form may keep on the caller's behalf.
   */
  public setField(
    field: AttachField,
    value: string,
    catalog: DriverCatalogReading | undefined,
  ): void {
    if (value === "") {
      this.#entered.delete(field);
    } else {
      this.#entered.set(field, value);
    }
    this.#dropEntriesTheNewVocabularyDoesNotCarry(field, catalog);
    this.#changes.emit();
  }

  /** Drop an override, returning the field to whatever the definition supplies. */
  public clearOverride(field: AttachField): void {
    if (!this.#entered.has(field)) {
      return;
    }
    this.#entered.delete(field);
    this.#changes.emit();
  }

  /**
   * Whether the caller edited this field.
   *
   * Presence, never value equality — see the header. On the inline arm every entered
   * field is simply the value, so nothing is marked as overriding anything.
   */
  public isOverridden(field: AttachField): boolean {
    return this.#arm === "definition" && this.#entered.has(field);
  }

  /** What the field shows: the entry where there is one, else the definition's value. */
  public effectiveValue(field: AttachField): string | undefined {
    const entered = this.#entered.get(field);
    if (entered !== undefined) {
      return entered;
    }
    if (this.#arm !== "definition") {
      return undefined;
    }
    return this.#definition?.[field];
  }

  /**
   * The request, or what is still missing.
   *
   * The definition arm sends the id plus ONLY the fields the caller entered, which is
   * what makes the merge per-field at the daemon rather than a whole-record replace
   * composed here.
   *
   * Presence is not enough, and neither is the entered half. Every axis of the
   * RESOLVED chain has to be a member of the vocabulary its parent publishes,
   * because {@link setField}'s chain cannot be the only guard: a catalog refresh can
   * retire a model or an effort level under a form nobody touched, and an override
   * lands in the middle of a chain whose other axes came from the definition. So
   * this is a second reading of the same rule rather than a repetition of one act.
   *
   * The session and the catalog are ARGUMENTS rather than fields: this form is opened
   * over whatever session the surface is showing and against whatever the catalog
   * read currently answers, and a copy of either held here would be a second answer
   * to a question the models already own.
   */
  public readiness(sessionId: string, catalog: DriverCatalogReading | undefined): AttachReadiness {
    const name = this.#name.trim();
    const missing: string[] = [];
    if (name === "") {
      missing.push("a name");
    }
    const unvouched = this.#axesNoVocabularyCarries(catalog);
    if (this.#arm === "definition") {
      const definitionId = this.#definition?.definitionId;
      if (definitionId === undefined) {
        missing.push("a definition");
      }
      missing.push(...unvouched);
      if (name === "" || definitionId === undefined || unvouched.length > 0) {
        return { status: "incomplete", missing };
      }
      return {
        status: "ready",
        request: {
          sessionId,
          name,
          definitionId,
          driverName: this.#entered.get("driverName"),
          modelId: this.#entered.get("modelId"),
          providerAccountId: this.#entered.get("providerAccountId"),
          effort: this.#entered.get("effort"),
        },
      };
    }
    const driverName = this.#entered.get("driverName");
    const modelId = this.#entered.get("modelId");
    if (driverName === undefined) {
      missing.push("a driver");
    }
    if (modelId === undefined) {
      missing.push("a model");
    }
    missing.push(...unvouched);
    if (name === "" || driverName === undefined || modelId === undefined || unvouched.length > 0) {
      return { status: "incomplete", missing };
    }
    return {
      status: "ready",
      request: {
        sessionId,
        name,
        driverName,
        modelId,
        providerAccountId: this.#entered.get("providerAccountId"),
        effort: this.#entered.get("effort"),
      },
    };
  }

  /**
   * Drop the ENTERED entries the field just edited no longer vouches for.
   *
   * Ordered: the model is settled against the new driver first, because the effort
   * vocabulary is published by the MODEL and reading it against a model that has just
   * been dropped would test an entry against a vocabulary that no longer exists.
   * Neither `providerAccountId` nor `name` has a parent, which is why only two of the
   * four fields reach here at all.
   *
   * Only entries are dropped. An INHERITED axis the new vocabulary retires belongs to
   * the definition and clearing it here would edit a row the caller did not choose to
   * edit; {@link readiness} names it instead, so the caller overrides it in the field
   * where they can see what it becomes.
   */
  #dropEntriesTheNewVocabularyDoesNotCarry(
    edited: AttachField,
    catalog: DriverCatalogReading | undefined,
  ): void {
    if (edited !== "driverName" && edited !== "modelId") {
      return;
    }
    if (edited === "driverName") {
      // Unconditional: no read tells this console which provider an account belongs
      // to, so there is no vocabulary that could vouch for it under a new driver.
      this.#entered.delete("providerAccountId");
      if (this.#entered.has("modelId") && this.#unvouchedAxes(catalog).includes("modelId")) {
        this.#entered.delete("modelId");
      }
    }
    // Re-read rather than reused: dropping the model above moved the chain, and the
    // effort has to be judged against the chain that survives it.
    if (this.#entered.has("effort") && this.#unvouchedAxes(catalog).includes("effort")) {
      this.#entered.delete("effort");
    }
  }

  /**
   * Which axes of the resolved chain no published vocabulary vouches for, as words.
   *
   * A form carrying no ENTRY among the three needs no catalog at all — which is what
   * keeps the definition arm submittable while the catalog read is still in flight,
   * since the daemon resolves a definition's own driver and model itself and a
   * definition is internally coherent by construction. The moment one IS entered the
   * whole chain is in question, because an entry can retire the vocabulary an
   * inherited axis was published under; an unread catalog is then named as the thing
   * still missing rather than treated as permission.
   */
  #axesNoVocabularyCarries(catalog: DriverCatalogReading | undefined): readonly string[] {
    if (!DEPENDENT_AXES.some((axis) => this.#entered.has(axis))) {
      return [];
    }
    if (catalog === undefined) {
      return ["the model catalog"];
    }
    return this.#unvouchedAxes(catalog).map((axis) => UNVOUCHED_AXIS_WORDS[axis]);
  }

  /** The chain rule over this form's own resolved reading. */
  #unvouchedAxes(catalog: DriverCatalogReading | undefined): readonly DependentAxis[] {
    return unvouchedAxesOf(this.#resolvedChain(), catalog);
  }

  /**
   * The chain as the form displays it: entry over definition, per field.
   *
   * The same resolution {@link effectiveValue} performs, because what is validated has
   * to be what a person is looking at — a second resolution here would be a second
   * answer to which value this form is actually about.
   */
  #resolvedChain(): ResolvedAxisChain {
    const chain: ResolvedAxisChain = {};
    for (const axis of DEPENDENT_AXES) {
      const value = this.effectiveValue(axis);
      if (value !== undefined) {
        chain[axis] = value;
      }
    }
    return chain;
  }
}
