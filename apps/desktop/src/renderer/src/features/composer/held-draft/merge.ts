// How a newer held draft meets typing this composer has not saved yet. Nothing either side wrote is
// lost: words one side already holds are kept once, and two different texts are both kept, the held
// one first. Of what rides with the words, every file and skill pick from both sides is kept, and
// the held draft's speed and repository stand, this composer's filling in only where it named none.

import type { SessionDraft, SessionDraftExtras } from "@ai-sidekicks/contracts/session/draft";

/** The draft that keeps both the held draft and this composer's unsaved one. */
export function mergeDrafts(held: SessionDraft, own: SessionDraft): SessionDraft {
  return { text: mergeTexts(held.text, own.text), extras: mergeExtras(held.extras, own.extras) };
}

/** Both texts, each kept once: one that holds the other stands for both. */
function mergeTexts(held: string, own: string): string {
  if (own.includes(held)) {
    return own;
  }
  if (held.includes(own)) {
    return held;
  }
  return `${held}\n\n${own}`;
}

/** Every file and pick of both, the held speed and repository first. */
function mergeExtras(held: SessionDraftExtras, own: SessionDraftExtras): SessionDraftExtras {
  const attachments = [...new Set([...(held.attachments ?? []), ...(own.attachments ?? [])])];
  const skills = [...(held.skills ?? [])];
  for (const pick of own.skills ?? []) {
    if (!skills.some((kept) => kept.folderPath === pick.folderPath)) {
      skills.push(pick);
    }
  }
  const outputSpeedForTurn = held.outputSpeedForTurn ?? own.outputSpeedForTurn;
  const workspaceId = held.workspaceId ?? own.workspaceId;
  return {
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(outputSpeedForTurn === undefined ? {} : { outputSpeedForTurn }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}
