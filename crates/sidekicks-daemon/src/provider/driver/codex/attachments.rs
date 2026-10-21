//! A message as Codex's turn input takes it: its words as a text item, each skill picked for it as
//! a `skill` item naming the file Codex listed it from, and its staged files, a picture as a
//! `localImage` item naming its stored copy and any other file as a text item in its own place
//! naming its stored copy, which the agent opens itself, or saying why it could not be delivered.
//! Codex leaves a `mention` item out of what the model reads, so a file never goes as one.

use std::error::Error;

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::run::queue::MessageContent;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::attachments::{
    AttachmentResolver, ProviderAttachment, compose_attachment_text, resolve_message_attachments,
};
use crate::provider::driver::codex::app_server_protocol::{
    LocalImageUserInputType, SkillUserInputType, TextUserInputType, UserInput,
};
use crate::provider::driver::codex::session::state::CodexTurnMessage;
use crate::provider::driver::run_control::PickedSkill;

/// The picture formats Codex is handed as an image rather than as a file to open.
const CODEX_PICTURE_MEDIA_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/// One of the person's messages with its staged files bound to their stored copies, in staging
/// order, as a run's opening or a steer carries it. Fails with the resolver's own error when the
/// stored copies could not be read at all.
#[expect(
    dead_code,
    reason = "the Codex run start and steer read a message's words, skills and files through it"
)]
pub(crate) async fn resolve_codex_turn_message(
    resolver: &dyn AttachmentResolver,
    session_id: &SessionId,
    content: &MessageContent,
    attachments: &[ArtifactId],
    skills: &[PickedSkill],
) -> Result<CodexTurnMessage, Box<dyn Error + Send + Sync>> {
    Ok(CodexTurnMessage {
        text: content.as_str().to_owned(),
        skills: skills.to_vec(),
        attachments: resolve_message_attachments(resolver, session_id, attachments).await?,
    })
}

/// The input items of the person's messages, in send order: each message's words as a text item,
/// then an item per picked skill in the order picked, then an item per staged file in staging
/// order.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex run start, steer and faster-model retry send a turn's input with it"
    )
)]
pub(crate) fn compose_codex_message_input(messages: &[CodexTurnMessage]) -> Vec<UserInput> {
    messages
        .iter()
        .flat_map(|message| {
            std::iter::once(compose_codex_text_input(message.text.clone()))
                .chain(
                    message
                        .skills
                        .iter()
                        .map(|skill| UserInput::SkillUserInput {
                            name: skill.name.as_str().to_owned(),
                            path: skill.path.as_str().to_owned(),
                            type_: SkillUserInputType::Skill,
                        }),
                )
                .chain(message.attachments.iter().map(compose_attachment_input))
        })
        .collect()
}

/// One text item carrying `text` as typed, with no marked spans.
pub(crate) fn compose_codex_text_input(text: String) -> UserInput {
    UserInput::TextUserInput {
        text,
        text_elements: Vec::new(),
        type_: TextUserInputType::Text,
    }
}

// A picture Codex reads as an image; any other file, or a file that could not be bound, as the
// line naming it in its own place.
fn compose_attachment_input(attachment: &ProviderAttachment) -> UserInput {
    match attachment {
        ProviderAttachment::Resolved(resolved)
            if CODEX_PICTURE_MEDIA_TYPES.contains(&resolved.media_type.as_str()) =>
        {
            UserInput::LocalImageUserInput {
                detail: None,
                path: resolved.path.to_string_lossy().into_owned(),
                type_: LocalImageUserInputType::LocalImage,
            }
        }
        ProviderAttachment::Resolved(_) | ProviderAttachment::Unresolved(_) => {
            compose_codex_text_input(compose_attachment_text(attachment))
        }
    }
}
