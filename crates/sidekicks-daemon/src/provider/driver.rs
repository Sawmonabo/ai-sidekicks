//! The driver every provider implements, the table of providers, their registry and the shared turn
//! machinery. A provider's code stays in its own folder below; this file is the one other place
//! that names one, in its table entry.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::provider::id::is_provider_id;
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::Spawner;

use crate::provider::driver::contract::ProviderDriver;

pub(crate) mod attachments;
pub(crate) mod callback_tool;
pub(crate) mod capabilities;
mod claude;
mod codex;
pub(crate) mod contract;
pub(crate) mod diagnostics;
pub(crate) mod mcp_server_status;
pub(crate) mod plan_record;
pub(crate) mod question_answers;
pub(crate) mod registry;
pub(crate) mod reorder_buffer;
pub(crate) mod rewind;
pub(crate) mod run_control;
pub(crate) mod session_control;
pub(crate) mod streamed_text;
pub(crate) mod unified_diff;

/// The fixed facts a provider's driver declares about itself, the same for every installed build,
/// account, model and session; what depends on those comes from the driver's methods.
#[expect(
    dead_code,
    reason = "the provider list and the daemon's start read each descriptor's facts"
)]
pub(crate) struct ProviderDescriptor {
    /// The provider's id: a lowercase letter, then up to 31 lowercase letters, digits or hyphens.
    pub(crate) id: &'static str,
    /// The provider's name as a person reads it.
    pub(crate) name: &'static str,
    /// Each plan id the provider sends and the word a person reads it as.
    pub(crate) plan_words: &'static [(&'static str, &'static str)],
    /// The provider's built-in tools in its own spelling, each with the words the picker draws.
    pub(crate) built_in_tools: &'static [(&'static str, &'static str)],
    /// The environment names the app sets on the provider's processes.
    pub(crate) app_set_environment_names: &'static [&'static str],
    /// The environment name a Terminal pane's shell is given while `Simplify for a screen reader`
    /// is on, where the provider reads one; the section's app-set names list it beside the others.
    pub(crate) screen_reader_environment_name: Option<&'static str>,
    /// The voice kinds the provider offers, each at most once.
    pub(crate) voice_kinds: &'static [VoiceKind],
    /// The transports its tool servers are reached over.
    pub(crate) mcp_transports: &'static [McpTransport],
    /// The tool-server declaration members it reads beyond the shared ones.
    pub(crate) mcp_config_members: &'static [McpDeclaredConfigMember],
    /// The most characters it takes in a skill's name, where it sets a limit of its own.
    pub(crate) skill_name_max_length: Option<u64>,
}

/// Every provider's descriptor, in the order the providers are listed and their drivers registered.
pub(crate) const PROVIDERS: &[&ProviderDescriptor] = &[&claude::DESCRIPTOR, &codex::DESCRIPTOR];

const _: () = assert!(
    has_valid_ids(PROVIDERS),
    "a provider id breaks the id pattern"
);
const _: () = assert!(has_unique_ids(PROVIDERS), "two providers share an id");

/// The shared services every driver's build takes, one bundle, so adding a provider never edits the
/// daemon's start. Each field is a handle a driver reads; a provider's own folders stay in its
/// driver.
#[expect(
    dead_code,
    reason = "each driver's build reads it at the daemon's start"
)]
pub(crate) struct DriverServices {
    /// The one thread every child process is spawned from.
    pub(crate) spawner: Spawner,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
}

/// One registered provider: its descriptor and the function that builds its driver from the shared
/// services, storing its handles without I/O.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start registers each provider's driver through it"
    )
)]
pub(crate) struct ProviderRegistration {
    /// The provider's fixed facts.
    pub(crate) descriptor: &'static ProviderDescriptor,
    /// Builds the driver.
    pub(crate) build: fn(&DriverServices) -> Arc<dyn ProviderDriver>,
}

/// Whether every id in `table` matches the provider id pattern.
const fn has_valid_ids(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        if !is_provider_id(table[i].id) {
            return false;
        }
        i += 1;
    }
    true
}

/// Whether no two entries of `table` share an id.
const fn has_unique_ids(table: &[&ProviderDescriptor]) -> bool {
    let mut i = 0;
    while i < table.len() {
        let mut j = i + 1;
        while j < table.len() {
            if is_same_text(table[i].id, table[j].id) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}

/// Whether two texts hold the same bytes, in a form a constant can call.
const fn is_same_text(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut i = 0;
    while i < left.len() {
        if left[i] != right[i] {
            return false;
        }
        i += 1;
    }
    true
}
