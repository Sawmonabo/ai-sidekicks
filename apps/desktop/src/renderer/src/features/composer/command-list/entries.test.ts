// Only the addressed run's binding reaches the command list: one binding's commands are never
// listed under another binding's address, and where the binding cannot be named nothing is. A
// skill is listed once, from the daemon's own skill list, never again as a provider row, and only
// where the addressed provider can run it.
import { describe, expect, it } from "vitest";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type {
  ProviderCommandBinding,
  ProviderCommandBindingGroup,
} from "@ai-sidekicks/contracts/provider/driver/commands";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { SkillId, SkillListEntry } from "@ai-sidekicks/contracts/skill";

import { composeCommandList, selectAddressedBindingGroup } from "./entries.js";

const CLAUDE = "claude" as ProviderId;
const CODEX = "codex" as ProviderId;

/** One binding on `providerName`, on an account of its own. */
function bindingOn(providerName: ProviderId, accountId: string): ProviderCommandBinding {
  return { providerName, providerAccountId: accountId as ProviderAccountId };
}

const CLAUDE_BINDING = bindingOn(CLAUDE, "account-claude");
const CODEX_BINDING = bindingOn(CODEX, "account-codex");

const GROUPS: readonly ProviderCommandBindingGroup[] = [
  {
    runId: null,
    binding: CLAUDE_BINDING,
    entries: [
      {
        name: "compact",
        kind: "command",
        description: "Compact the conversation context.",
        binding: CLAUDE_BINDING,
      },
    ],
  },
  {
    runId: null,
    binding: CODEX_BINDING,
    entries: [{ name: "compact", kind: "command", binding: CODEX_BINDING }],
  },
];

describe("selectAddressedBindingGroup", () => {
  const CLAUDE_RUN = "019b7a11-1100-740e-8110-d1a4c1150311";
  const CODEX_RUN = "019b7a11-1100-740e-8120-d1a4c1150312";

  /** The same two bindings, each now naming the run it was read under. */
  const RUN_ATTRIBUTED: readonly ProviderCommandBindingGroup[] = [
    { ...GROUPS[0]!, runId: CLAUDE_RUN as ProviderCommandBindingGroup["runId"] },
    { ...GROUPS[1]!, runId: CODEX_RUN as ProviderCommandBindingGroup["runId"] },
  ];

  it("selects the group naming the addressed run", () => {
    // An older Claude run beside a newer Codex one: only the addressed run's binding may reach
    // the list.
    const selected = selectAddressedBindingGroup(RUN_ATTRIBUTED, {
      runId: CODEX_RUN,
      providerName: CODEX,
    });

    expect(selected?.binding.providerName).toBe(CODEX);
  });

  it("falls back to the addressed provider where no group names the run", () => {
    // `runId` is `null` both when no run is live and when several are; the composer's address
    // still names its provider.
    const selected = selectAddressedBindingGroup(GROUPS, {
      runId: CLAUDE_RUN,
      providerName: CLAUDE,
    });

    expect(selected?.binding.providerName).toBe(CLAUDE);
  });

  it("selects nothing where two groups share the addressed provider and name no run", () => {
    // A coin flip presented as routing is worse than an absence.
    const sameProvider: readonly ProviderCommandBindingGroup[] = [
      GROUPS[0]!,
      { ...GROUPS[1]!, binding: bindingOn(CLAUDE, "account-other") },
    ];

    expect(
      selectAddressedBindingGroup(sameProvider, { runId: CLAUDE_RUN, providerName: CLAUDE }),
    ).toBeUndefined();
  });

  it("selects nothing where the composer names neither a run nor a provider", () => {
    expect(
      selectAddressedBindingGroup(GROUPS, { runId: undefined, providerName: undefined }),
    ).toBeUndefined();
  });
});

describe("composeCommandList", () => {
  // Mutation: keeping a provider row the provider marks as a skill lists that skill twice once
  // the daemon's skill list is beside it.
  it("drops a provider row marked as a skill and keeps its commands and prompts", () => {
    const group: ProviderCommandBindingGroup = {
      runId: null,
      binding: CLAUDE_BINDING,
      entries: [
        { name: "review", kind: "command", binding: CLAUDE_BINDING },
        { name: "deploy", kind: "skill", binding: CLAUDE_BINDING },
        { name: "list_prs", kind: "prompt", server: "github", binding: CLAUDE_BINDING },
      ],
    };

    const names = composeCommandList({
      runnableCommands: [],
      providerGroups: [group],
      skills: [],
      providerName: CLAUDE,
    }).map((entry) => entry.name);

    expect(names).toStrictEqual(["review", "list_prs"]);
  });

  it("lists the skills the addressed provider runs after its words, each picked by its folder", () => {
    // Mutation: dropping the availability filter lists `release-notes`, which only Codex runs;
    // dropping `folderPath` from the pick sends a skill the daemon cannot tell from a namesake.
    const codemod = skillOn("codemod", [CLAUDE, CODEX]);
    const releaseNotes = skillOn("release-notes", [CODEX]);
    const gone = { ...skillOn("old-skill", [CLAUDE]), orphaned: true };

    const entries = composeCommandList({
      runnableCommands: [],
      providerGroups: [GROUPS[0]!],
      skills: [codemod, releaseNotes, gone],
      providerName: CLAUDE,
    });

    expect(entries.map((entry) => entry.name)).toStrictEqual(["compact", "codemod"]);
    expect(entries.at(-1)).toMatchObject({
      source: "skill",
      callForm: "/codemod",
      pick: { name: "codemod", folderPath: "/repo/.ai-sidekicks/skills/codemod" },
    });
  });
});

/** A skill of ours in the project, available on `providers` and callable there by its name. */
function skillOn(name: string, providers: readonly ProviderId[]): SkillListEntry {
  return {
    skillId: `skill-${name}` as SkillId,
    name,
    description: null,
    icon: null,
    origin: "ours",
    scope: "project",
    folderPath: `/repo/.ai-sidekicks/skills/${name}`,
    files: [],
    availability: [CLAUDE, CODEX].map((provider) => ({
      provider,
      available: providers.includes(provider),
    })),
    callForms: [
      { provider: CLAUDE, callForm: `/${name}` },
      { provider: CODEX, callForm: `$${name}` },
    ],
    orphaned: false,
    disabledInProvider: [],
    loadError: null,
  };
}
