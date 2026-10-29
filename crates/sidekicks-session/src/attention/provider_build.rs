//! A provider's new build in the attention projection: one entry per build the record of each
//! provider's builds lists, composed when the whole projection is read and stored nowhere else. It
//! belongs to no session, never counts and is never decided, so no channel carries it.

use rusqlite::Connection;
use sidekicks_contracts::attention::provider_build::{
    AttentionProviderBuild, AttentionProviderBuildItem, ProviderBuildTrigger, WithheldBannerState,
};
use sidekicks_contracts::attention::{AttentionId, InformationalSeverity};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::settings::PROVIDER_VERSION_MAX_LEN;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_provider::build_record::{RecordedProviderBuild, listed_builds};
use sidekicks_provider::driver::descriptor_of;
use sidekicks_store::database::statement::WriteStatement;

use crate::attention::moment::hashed_moment_id;
use crate::attention::projection::{MACHINE_VERSION_BUMP_SQL, statement};
use crate::attention::read::AttentionReadError;

/// A printed version as the wire carries it.
type ProviderVersion = FreeFormText<PROVIDER_VERSION_MAX_LEN>;

/// The moment id of `provider`'s build `version`, which is also its entry's id: `providerBuild:`
/// and 32 hex digits of the BLAKE3 hash of the two. A provider id holds no `|`, so no two pairs
/// share a key.
pub(crate) fn provider_build_moment_id(provider: &ProviderId, version: &str) -> AttentionId {
    hashed_moment_id("providerBuild", &format!("{}|{version}", provider.as_str()))
}

/// The statements a write to the record of each provider's builds carries so the projection's
/// followers read it again: the bump of the machine's change count alone, since no session's
/// projection lists a build.
pub fn record_change_statements() -> Vec<WriteStatement> {
    vec![statement(&MACHINE_VERSION_BUMP_SQL, Vec::new())]
}

/// One entry per build the record lists, the newest recorded first, each named by its driver's
/// descriptor. Fails when the read fails, when a listed provider has no driver, or when a listed
/// version is one the wire cannot carry.
pub(crate) fn provider_build_items(
    reader: &Connection,
) -> Result<Vec<AttentionProviderBuildItem>, AttentionReadError> {
    listed_builds(reader)?
        .into_iter()
        .map(provider_build_item)
        .collect()
}

fn provider_build_item(
    build: RecordedProviderBuild,
) -> Result<AttentionProviderBuildItem, AttentionReadError> {
    let descriptor = descriptor_of(build.provider.as_str()).ok_or_else(|| {
        AttentionReadError::UndescribedProvider {
            provider: build.provider.as_str().to_owned(),
        }
    })?;
    let unreadable = |member| {
        let provider = build.provider.as_str().to_owned();
        move |source| AttentionReadError::UnreadableProviderBuild {
            provider,
            member,
            source,
        }
    };
    let to_version = ProviderVersion::new(build.version.clone()).map_err(unreadable("build"))?;
    let from_version = build
        .from_version
        .clone()
        .map(ProviderVersion::new)
        .transpose()
        .map_err(unreadable("earlier build"))?;
    let state_word = match &from_version {
        Some(from_version) => format!(
            "updated · {} → {}",
            from_version.as_str(),
            to_version.as_str()
        ),
        None => format!("{} available", to_version.as_str()),
    };
    // Only a build the command moved to has notes to open; the address is the new build's.
    let release_notes_address = from_version.as_ref().map(|_| {
        HttpsAddress::new(&(descriptor.release_notes_address)(to_version.as_str()))
            .expect("a driver's release notes are an https: address")
    });
    let id = provider_build_moment_id(&build.provider, &build.version);
    Ok(AttentionProviderBuildItem {
        id: id.clone(),
        moment_id: id,
        trigger: ProviderBuildTrigger::Value,
        severity: InformationalSeverity::Value,
        display_name: NonEmptyText::new(descriptor.name().to_owned())
            .expect("a provider's name is not empty"),
        state_word: NonEmptyText::new(state_word).expect("a build's state word is not empty"),
        provider_build: AttentionProviderBuild {
            provider: build.provider,
            from_version,
            to_version,
            release_notes_address,
        },
        created_at: build.recorded_at,
        banner_state: WithheldBannerState::Value,
    })
}

#[cfg(test)]
mod tests;
