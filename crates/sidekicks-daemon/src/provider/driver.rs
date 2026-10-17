//! The driver every provider implements, the table of providers, their registry and the shared turn
//! machinery. A provider's code stays in its own folder below; this file is the one other place
//! that names one, in its table entry.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the provider list and the start-time table read it"
    )
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
    /// The transports its tool servers are reached over.
    pub(crate) mcp_transports: &'static [McpTransport],
    /// The tool-server declaration members it reads beyond the shared ones.
    pub(crate) mcp_config_members: &'static [McpDeclaredConfigMember],
    /// The most characters it takes in a skill's name, where it sets a limit of its own.
    pub(crate) skill_name_max_length: Option<u64>,
}

/// The shared services every driver's build takes, one bundle, so adding a provider never edits the
/// daemon's start. Each field is a handle a driver reads; a provider's own folders stay in its
/// driver.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the drivers' build functions read it at the daemon's start"
    )
)]
pub(crate) struct DriverServices {
    /// The one thread every child process is spawned from.
    pub(crate) spawner: Spawner,
    /// The daemon's data folder.
    pub(crate) data_folder: PathBuf,
}

/// One table entry: a provider's descriptor and the function that builds its driver from the
/// shared services, storing its handles without I/O.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the start-time table holds one per provider")
)]
pub(crate) struct ProviderRegistration {
    /// The provider's fixed facts.
    pub(crate) descriptor: &'static ProviderDescriptor,
    /// Builds the driver.
    pub(crate) build: fn(&DriverServices) -> Arc<dyn ProviderDriver>,
}

/// Whether no two entries of `table` share an id, checked when the table compiles.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start-time table's compile-time check calls it"
    )
)]
pub(crate) const fn has_unique_ids(table: &[ProviderRegistration]) -> bool {
    let mut i = 0;
    while i < table.len() {
        let mut j = i + 1;
        while j < table.len() {
            if is_same_text(table[i].descriptor.id, table[j].descriptor.id) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}

/// Whether two texts hold the same bytes, in a form a constant can call.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the start-time table's compile-time check calls it"
    )
)]
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
