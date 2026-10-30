//! The account read of Claude Code's claude.ai connectors and its organization's servers: one
//! process that keeps nothing, started under the account without `--strict-mcp-config` in an
//! empty folder under the account's home, so nothing of the person's loads, answers
//! `get_binary_version`, `mcp_status` and `get_settings`, and each `claudeai` row becomes a
//! read-only connector of the account, with the status and tools the row reports, while the
//! organization's rows and `managedMcpServers` become read-only managed servers, each connector
//! marked as its organization's connector list reads it. Budget: one such process of about 140 to
//! 150 MB per account at a time, run at the account's first read after the daemon starts and again
//! only on a refresh or a session's start after a failed or short read, never on a poll; while it
//! reports fewer connectors than the list holds, less those Claude Code suppresses as duplicates of
//! a configured server, or none where Claude Code fetches a list the daemon could not read, one
//! `mcp_status` a second on that process, until the count stops growing above none, or with none
//! until Claude Code's own fetch of the list can have ended, and never past the later of the
//! machine probe's ceiling and one ask after that fetch; where Claude Code fetches no list, one
//! `mcp_status`.

pub(crate) mod list_fetch;
pub(crate) mod organization_mark;

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::value::RawValue;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpServerStatus};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::time::Instant;

use crate::driver::ReportedVersionReading;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::mcp::config::{ClaudeMcpEndpoint, ClaudeMcpServer};
use crate::driver::claude::mcp::connectors::list_fetch::ClaudeConnectorFetchSettings;
use crate::driver::claude::mcp::connectors::organization_mark::{
    CLAUDE_CONNECTOR_FETCH_WINDOW, ClaudeConnectorListReading, ClaudeConnectorMarks,
};
use crate::driver::claude::mcp::organization::{
    is_organization_row, read_claude_organization_servers, read_organization_addresses,
    remote_server_view,
};
use crate::driver::claude::mcp::precedence::ClaudeMcpAccountServers;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeSettingsReply,
};
use crate::driver::claude::session::transport::mcp_status::{
    ClaudeMcpServerStatus, ClaudeMcpServerStatusRow, ClaudeMcpStatusReply,
};
use crate::driver::claude::tools::normalize_claude_mcp_status_reply;
use crate::driver::claude::version::read_reported_version;
use crate::driver::mcp_server::address::ServerAddressIdentity;
use crate::driver::mcp_server::read::McpProbeReading;
use crate::driver::mcp_server::status::{McpServerReading, McpServerStatusEmission};

/// Where one account's read runs: the account's process environment, the account, and the empty
/// folder under its home the process starts in.
pub(crate) struct ClaudeAccountServersReadRequest {
    /// The environment of a process on the account's home.
    pub(crate) environment: Vec<(String, String)>,
    /// The account.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The empty folder the process runs in, made where absent.
    pub(crate) working_folder: PathBuf,
}

/// What one account's process answered: its `mcp_status` reply, read once, and its
/// `get_settings` reply as it came, which can carry headers and whole addresses, so it lives only
/// until the account's servers are read from it.
pub(crate) struct ClaudeAccountServerAnswers {
    /// The `mcp_status` reply, read.
    pub(crate) mcp_status: ClaudeMcpStatusReply,
    /// The `get_settings` reply.
    pub(crate) settings: Option<Box<RawValue>>,
    /// Whether `mcp_status` still reported fewer connectors than the account's connector list
    /// holds when the read stopped asking, so Claude Code had not loaded them all yet.
    pub(crate) lacks_listed_connectors: bool,
}

/// How long the account read waits before asking `mcp_status` again while it reports fewer
/// connectors than the account's list holds.
const CONNECTOR_STATUS_INTERVAL: Duration = Duration::from_secs(1);

/// Reads one account's answers on `channel`, its process that keeps nothing already initialized:
/// the build's version and `get_settings`, then the connector list `read_connector_list` reads
/// for that version and those settings, then `mcp_status`, asked again on the same process once a
/// second until it reports as many connectors as the list holds less those at the address of a
/// server the account's process configures, or the later of `ceiling` and one ask after Claude
/// Code's own fetch can have ended passes, so a short `ceiling` never cuts that fetch's wait. A
/// count that stops growing
/// settles the read at once where it is above none; a count of none settles once Claude Code's
/// own fetch can have ended. Where Claude Code fetches no list, `mcp_status` is asked once, and
/// where the daemon could not read it, until a connector shows or that fetch can have ended. Only
/// a read that settles short of a list it read lacks listed connectors. Fails as a request does,
/// a refused request included.
pub(crate) async fn read_claude_account_answers<ListRead>(
    channel: &dyn ClaudeProcessChannel,
    read_connector_list: impl FnOnce(Option<String>, ClaudeConnectorFetchSettings) -> ListRead,
    ceiling: Duration,
) -> Result<(ClaudeAccountServerAnswers, Option<ClaudeConnectorMarks>), ClaudeSessionError>
where
    ListRead: Future<Output = ClaudeConnectorListReading>,
{
    let started = Instant::now();
    // One more ask after Claude Code's fetch can have ended, so its connectors are seen.
    let fetch_end = started + CLAUDE_CONNECTOR_FETCH_WINDOW + CONNECTOR_STATUS_INTERVAL;
    let deadline = (started + ceiling).max(fetch_end + CONNECTOR_STATUS_INTERVAL);
    let version = channel
        .send_control_request(ClaudeControlRequest::GetBinaryVersion {})
        .await?;
    let build_version = read_build_version(version.response.as_deref());
    let settings = channel
        .send_control_request(ClaudeControlRequest::GetSettings {})
        .await?;
    let settings_reply = ClaudeSettingsReply::read(settings.response.as_deref());
    let organization_addresses = read_organization_addresses(settings_reply.effective.as_ref());
    let list = read_connector_list(
        build_version,
        ClaudeConnectorFetchSettings::read(settings.response.as_deref()),
    )
    .await;
    let mut last_reported_rows = None;
    let (mcp_status, reported_rows, listed_rows) = loop {
        let answer = channel
            .send_control_request(ClaudeControlRequest::McpStatus {})
            .await?;
        let reply = ClaudeMcpStatusReply::read(answer.response.as_deref());
        let reported_rows = count_connector_rows(&reply);
        let listed_rows = match &list {
            ClaudeConnectorListReading::Read(marks) => Some(
                marks.listed_row_count(&read_configured_addresses(&reply, &organization_addresses)),
            ),
            ClaudeConnectorListReading::NotFetched | ClaudeConnectorListReading::Unread => None,
        };
        let now = Instant::now();
        // A count no longer growing settles the read, so a connector Claude Code never lists
        // costs one more ask rather than the whole ceiling; while it is none, Claude Code may
        // still be fetching the list, so it settles only once that fetch can have ended.
        let has_stopped_growing =
            last_reported_rows == Some(reported_rows) && (reported_rows > 0 || now >= fetch_end);
        let has_reached_list = match listed_rows {
            Some(listed_rows) => reported_rows >= listed_rows,
            None => matches!(list, ClaudeConnectorListReading::NotFetched),
        };
        if has_reached_list || has_stopped_growing || now >= deadline {
            break (reply, reported_rows, listed_rows);
        }
        last_reported_rows = Some(reported_rows);
        tokio::time::sleep_until((now + CONNECTOR_STATUS_INTERVAL).min(deadline)).await;
    };
    Ok((
        ClaudeAccountServerAnswers {
            mcp_status,
            settings: settings.response,
            lacks_listed_connectors: listed_rows
                .is_some_and(|listed_rows| reported_rows < listed_rows),
        },
        list.into_marks(),
    ))
}

/// The servers `provider_account_id` brings, read from its process's `answers`: each `claudeai`
/// row as a connector named by its display name, with the status, error text and tools the row
/// reports and its mark from `marks`, and the organization's servers, each with what its row
/// reports where that row is past `pending`. Every other row is the person's own config, which
/// the config read lists.
pub(crate) fn read_claude_account_servers(
    provider_account_id: &ProviderAccountId,
    answers: &ClaudeAccountServerAnswers,
    marks: Option<&ClaudeConnectorMarks>,
) -> ClaudeMcpAccountServers {
    let reply = &answers.mcp_status;
    let emissions = normalize_claude_mcp_status_reply(reply)
        .map(|read| read.emissions)
        .unwrap_or_default();
    let rows = reply
        .servers
        .as_ref()
        .map(|rows| rows.0.as_slice())
        .unwrap_or_default();
    let settings = ClaudeSettingsReply::read(answers.settings.as_deref());
    let organization = read_claude_organization_servers(rows, settings.effective.as_ref());
    let (connectors, connector_readings) = rows
        .iter()
        .filter(|row| is_connector_row(row))
        .filter_map(|row| {
            let connector = read_connector(provider_account_id, row, marks)?;
            let reading = read_row_reading(&connector.binding, row, &emissions)?;
            Some((connector, reading))
        })
        .unzip();
    // An organization server still `pending` here settles nothing, so the probe reads it.
    let organization_readings = organization
        .servers
        .iter()
        .filter_map(|server| {
            let name = server.binding.server_name().as_str();
            let row = rows
                .iter()
                .find(|row| is_organization_row(row) && row.name.as_deref() == Some(name))?;
            read_row_reading(&server.binding, row, &emissions)
        })
        .filter(|reading| reading.reading != McpServerReading::Observed(McpServerStatus::Starting))
        .collect();
    ClaudeMcpAccountServers {
        provider_account_id: provider_account_id.clone(),
        organization_servers: organization.servers,
        connectors,
        connector_readings,
        organization_readings,
        organization_entries: organization.entries,
        lacks_listed_connectors: answers.lacks_listed_connectors,
    }
}

// How many connectors an `mcp_status` reply reports.
fn count_connector_rows(reply: &ClaudeMcpStatusReply) -> usize {
    reply.servers.as_ref().map_or(0, |rows| {
        rows.0.iter().filter(|row| is_connector_row(row)).count()
    })
}

// The folded address of each server the account's process configures outside claude.ai and the
// plugins, which Claude Code matches its connectors against to suppress duplicates, as its print
// mode passes them: each row of an `mcp_status` reply, and each of `organization_addresses`, the
// organization's `managedMcpServers` at their whole addresses, which the reply's row cuts short.
// One switched off or waiting for a sign-in, as its row reads, suppresses none.
fn read_configured_addresses(
    reply: &ClaudeMcpStatusReply,
    organization_addresses: &[(String, ServerAddressIdentity)],
) -> Vec<ServerAddressIdentity> {
    let rows = reply
        .servers
        .as_ref()
        .map_or(&[][..], |rows| rows.0.as_slice());
    let is_inert = |row: &ClaudeMcpServerStatusRow| {
        matches!(
            row.status,
            Some(ClaudeMcpServerStatus::Disabled | ClaudeMcpServerStatus::NeedsAuth)
        )
    };
    let organization = organization_addresses
        .iter()
        .filter(|(name, _address)| {
            !rows
                .iter()
                .any(|row| row.name.as_deref() == Some(name.as_str()) && is_inert(row))
        })
        .map(|(_name, address)| address.clone());
    rows.iter()
        .filter(|row| {
            !is_connector_row(row)
                && !row
                    .name
                    .as_deref()
                    .is_some_and(|name| name.starts_with("plugin:"))
                && !is_inert(row)
        })
        .filter_map(|row| row.config.as_ref()?.address.as_ref()?.identity.clone())
        .chain(organization)
        .collect()
}

// Whether `row` is one of the account's claude.ai connectors.
fn is_connector_row(row: &ClaudeMcpServerStatusRow) -> bool {
    row.source.as_deref().or(row.scope.as_deref()) == Some("claudeai")
}

// The canonical version a `get_binary_version` `reply` reports; `None` where it reports none.
fn read_build_version(reply: Option<&RawValue>) -> Option<String> {
    let reply: serde_json::Value = serde_json::from_str(reply?.get()).ok()?;
    match read_reported_version(&reply) {
        ReportedVersionReading::Version(version) => Some(version),
        ReportedVersionReading::UnreadableReply(_) => None,
    }
}

// What the account's process reported of `binding` through `row`: the row's reading and error
// text through the one status mapping, and its tools; `None` for a row the mapping refused.
fn read_row_reading(
    binding: &McpServerBindingRef,
    row: &ClaudeMcpServerStatusRow,
    emissions: &[McpServerStatusEmission],
) -> Option<McpProbeReading> {
    let emission = emissions
        .iter()
        .find(|emission| Some(emission.server_name.as_str()) == row.name.as_deref())?;
    Some(McpProbeReading {
        binding: binding.clone(),
        reading: emission.reading,
        failure_text: emission.failure_text.clone(),
        tool_names: emission.tool_names.clone().unwrap_or_default(),
    })
}

// A `claudeai` row as the account's connector, reached at its own address and marked as `marks`
// reads its id; `None` for a row with no name the wire carries or no address.
fn read_connector(
    provider_account_id: &ProviderAccountId,
    row: &ClaudeMcpServerStatusRow,
    marks: Option<&ClaudeConnectorMarks>,
) -> Option<ClaudeMcpServer> {
    let server_name = McpServerName::new(row.name.clone()?).ok()?;
    let config = row.config.as_ref()?;
    let address = config.address.as_ref()?;
    let organization_managed = marks
        .zip(config.connector_id.as_deref())
        .and_then(|(marks, connector_id)| marks.mark(connector_id));
    let url_query_param_names =
        (!address.query_param_names.is_empty()).then(|| address.query_param_names.clone());
    Some(ClaudeMcpServer {
        binding: McpServerBindingRef::Connector {
            provider: DESCRIPTOR.provider_id(),
            scope_ref: provider_account_id.clone(),
            server_name,
        },
        config: remote_server_view("http", address.stripped_url.clone(), url_query_param_names)?,
        endpoint: address.identity.clone().map(ClaudeMcpEndpoint::Address),
        organization_managed,
    })
}

#[cfg(test)]
mod tests;
