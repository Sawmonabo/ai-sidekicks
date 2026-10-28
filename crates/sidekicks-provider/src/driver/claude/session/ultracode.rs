//! Claude Code's Ultracode, the one session option the driver declares: a switch under the effort
//! levels, set for the session alone with `apply_flag_settings {ultracode}`, and read back from
//! `get_settings`' `applied`, which says whether it is in effect and whether the session can run
//! it, after each spawn and each change.

use sidekicks_contracts::provider::declaration::{
    ObservedProviderOption, ObservedProviderOptions, ProviderDeclarationId,
    ProviderDeclarationText, ProviderOptionSetting, ProviderSessionOption,
    ProviderSessionOptionControl, ProviderSessionOptionPlacement, ProviderValue,
};

use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings, ClaudeSettingsReply,
};

/// The option's id, as the agent's binding carries it.
const CLAUDE_ULTRACODE_OPTION_ID: &str = "ultracode";

/// Whether Ultracode is in effect for the session and whether the session can run it, as a
/// `get_settings` reply's `applied` reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeUltracodeReading {
    /// Whether it is in effect.
    pub(crate) is_on: bool,
    /// Whether the session can run it: workflows are on and the model supports it.
    pub(crate) is_available: bool,
}

/// Reads Ultracode's state from a `get_settings` reply's `applied`; `None` from a build that
/// reports either member other than as a boolean.
pub(crate) fn read_claude_ultracode(reply: &ClaudeSettingsReply) -> Option<ClaudeUltracodeReading> {
    let applied = reply.applied.as_ref()?;
    Some(ClaudeUltracodeReading {
        is_on: applied.get("ultracode")?.as_bool()?,
        is_available: applied.get("ultracodeAvailable")?.as_bool()?,
    })
}

/// The Ultracode value `options` sets, `None` where they leave it out.
pub(crate) fn requested_claude_ultracode(options: &[ProviderOptionSetting]) -> Option<bool> {
    options
        .iter()
        .find(|option| option.id.as_str() == CLAUDE_ULTRACODE_OPTION_ID)
        .and_then(|option| match option.value {
            ProviderValue::Switch(is_on) => Some(is_on),
            ProviderValue::Text(_) => None,
        })
}

/// Sets Ultracode on the live process for the session alone, then reads back what took effect.
/// Fails as Claude Code refuses either request, a session that cannot have it among them.
pub(crate) async fn apply_claude_ultracode(
    channel: &dyn ClaudeProcessChannel,
    is_on: bool,
) -> Result<Option<ClaudeUltracodeReading>, ClaudeSessionError> {
    channel
        .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
            settings: ClaudeFlagSettings {
                ultracode: Some(is_on),
                ..ClaudeFlagSettings::default()
            },
        })
        .await?;
    let settings = channel
        .send_control_request(ClaudeControlRequest::GetSettings {})
        .await?;
    Ok(read_claude_ultracode(&ClaudeSettingsReply::read(
        settings.response.as_deref(),
    )))
}

/// The session options Claude Code's driver declares: the Ultracode switch in the effort menu.
pub(crate) fn claude_session_options() -> Vec<ProviderSessionOption> {
    vec![ProviderSessionOption {
        id: ultracode_option_id(),
        label: ProviderDeclarationText::new("Ultracode".to_owned())
            .expect("the option's label fits"),
        placement: ProviderSessionOptionPlacement::EffortMenu,
        control: ProviderSessionOptionControl::Switch {},
    }]
}

/// The options a live session reports from `reading`.
pub(crate) fn observe_claude_options(reading: ClaudeUltracodeReading) -> ObservedProviderOptions {
    ObservedProviderOptions::new(vec![ObservedProviderOption {
        id: ultracode_option_id(),
        value: ProviderValue::Switch(reading.is_on),
        is_available: reading.is_available,
    }])
    .expect("one option is within the bounds")
}

/// The options a relaunch starts with: the Ultracode value the agent asked for, where it asked.
pub(crate) fn relaunch_claude_options(requested: Option<bool>) -> Vec<ProviderOptionSetting> {
    requested
        .map(|is_on| ProviderOptionSetting {
            id: ultracode_option_id(),
            value: ProviderValue::Switch(is_on),
        })
        .into_iter()
        .collect()
}

fn ultracode_option_id() -> ProviderDeclarationId {
    ProviderDeclarationId::new(CLAUDE_ULTRACODE_OPTION_ID.to_owned())
        .expect("the option's id fits the id pattern")
}
