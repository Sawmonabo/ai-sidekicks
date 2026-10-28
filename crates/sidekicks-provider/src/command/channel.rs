//! The sealed channel between the daemon and the parties a conversation's commands start, the
//! command wrapper and the askpass: one folder per conversation, the parties' records renamed into
//! it and the daemon's requests into its `requests` folder, each record sealed on its own with HPKE
//! in its authenticated mode and carrying a sequence number that only rises. A party is admitted
//! once, at its first record, by the public key its own arguments hold and its place under the
//! provider's process; the daemon's public key reaches it through its environment.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as _, OpModeR, OpModeS, Serializable};
use serde::{Deserialize, Serialize};
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::{
    FolderArrivalWatch, LeftoverSweep, ParentProcess, PinnedProcess, TerminalDevice,
    TerminalMasterReading, create_file_atomically, create_private_folder, pin_running_process,
    read_process_start,
};
use sidekicks_std::mutex_lock::lock;
use zeroize::Zeroizing;

pub(crate) mod party;
pub(crate) mod records;
#[cfg(test)]
pub(crate) mod test_support;

/// The variable naming a conversation's channel folder to the parties its commands start.
const COMMAND_CHANNEL_VARIABLE: &str = "SIDEKICKS_COMMAND_CHANNEL";

/// The variable holding the daemon's public key for a conversation's channel, in hexadecimal.
const COMMAND_CHANNEL_KEY_VARIABLE: &str = "SIDEKICKS_COMMAND_CHANNEL_KEY";

/// The variable naming the descriptor a restarted party reads its private key from, which the
/// party removes before it starts anything.
pub(crate) const PARTY_SECRET_VARIABLE: &str = "SIDEKICKS_COMMAND_PARTY_SECRET";

/// What opens a restarted party's first argument, followed by its public key in hexadecimal.
const PARTY_KEY_ARGUMENT_PREFIX: &str = "party-key=";

/// The folder inside a channel's folder that only the daemon writes.
pub(crate) const REQUESTS_FOLDER: &str = "requests";

/// The context string every seal and open binds, ahead of the record's own context.
const SEALING_INFO: &[u8] = b"sidekicks command channel";

/// The bytes the encapsulated key takes at the head of a sealed record.
const ENCAPSULATED_KEY_BYTES: usize = 32;

/// The mode a record is written with: the account's own processes alone read it.
const RECORD_MODE: u32 = 0o600;

type ChannelKem = X25519HkdfSha256;
type ChannelPrivateKey = <ChannelKem as hpke::Kem>::PrivateKey;
type ChannelPublicKey = <ChannelKem as hpke::Kem>::PublicKey;

/// The folder every conversation's command channel opens under, in the daemon's data folder.
pub(crate) fn command_channel_root(data_folder: &Path) -> PathBuf {
    data_folder.join("command-channels")
}

/// A party: the process id of the wrapper or askpass that writes records.
pub(crate) type PartyId = u32;

/// A record a party writes to the daemon.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum PartyRecord {
    /// The wrapper is about to start `command`, whose standard output is the file at
    /// `stdout_path` where it is one; `process` is the provider's process handle where it named
    /// one.
    Starting {
        /// The command line the provider gave the wrapper.
        command: String,
        /// The file the command's standard output writes to, where it is a file.
        stdout_path: Option<PathBuf>,
        /// The provider's handle on the command's process, where it gave one.
        process: Option<String>,
    },
    /// What the command's terminal shows, read by the wrapper on its master, and the last of the
    /// output it printed.
    Terminal {
        /// The device of the terminal's program side.
        device: TerminalDevice,
        /// What its master showed.
        master: TerminalMasterReading,
        /// The output's last bytes, read lossily, whose last line the waiting check reads.
        output_tail: String,
    },
    /// The command exited with `exit_code`, or ended by signal number `signal`.
    Exited {
        /// Its exit code, absent for a signal's end.
        exit_code: Option<i32>,
        /// The signal that ended it.
        signal: Option<i32>,
    },
    /// The wrapper ended the command's whole terminal session, as the daemon's stop asked.
    Stopped {},
    /// An askpass's prompt is open; its words are the askpass's own argument, which the daemon
    /// reads at its admission.
    Asking {},
    /// Something the party could not do that leaves its command running as it is, in its own
    /// words, for the daemon's log.
    Warning {
        /// What it could not do.
        message: String,
    },
}

/// A request the daemon writes to one party.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DaemonRequest {
    /// The wrapper may start its command.
    Go {},
    /// The askpass's answer.
    Answer {
        /// The text the person typed; empty for the end of input.
        text: String,
    },
    /// The wrapper ends its command's whole terminal session.
    Stop {},
}

/// Which way a record goes, bound into its seal so a record never opens as the other way's.
#[derive(Clone, Copy)]
enum Direction {
    ToDaemon = 1,
    ToParty = 2,
}

/// The context a record's seal binds as its setup's info, after [`SEALING_INFO`]: its direction,
/// its party and its sequence number.
fn record_context(direction: Direction, party: PartyId, sequence: u64) -> Vec<u8> {
    let mut context = SEALING_INFO.to_vec();
    context.push(direction as u8);
    context.extend_from_slice(&party.to_be_bytes());
    context.extend_from_slice(&sequence.to_be_bytes());
    context
}

/// Seals `plaintext` from the holder of `sender` to `recipient` under `context`: the encapsulated
/// key, then the ciphertext. Fails with the system's error when no random bytes can be read.
fn seal(
    sender: &(ChannelPrivateKey, ChannelPublicKey),
    recipient: &ChannelPublicKey,
    context: &[u8],
    plaintext: &[u8],
) -> io::Result<Vec<u8>> {
    let mode = OpModeS::Auth((sender.0.clone(), sender.1.clone()));
    let (encapsulated, ciphertext) = hpke::single_shot_seal::<
        ChaCha20Poly1305,
        HkdfSha256,
        ChannelKem,
    >(&mode, recipient, context, plaintext, &[])
    .map_err(io::Error::other)?;
    let mut sealed = encapsulated.to_bytes().to_vec();
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Opens what `sender` sealed to the holder of `recipient` under `context`; `None` when it does not
/// open, as a forged, cut or misdirected record does not.
fn open(
    recipient: &ChannelPrivateKey,
    sender: &ChannelPublicKey,
    context: &[u8],
    sealed: &[u8],
) -> Option<Zeroizing<Vec<u8>>> {
    let (encapsulated, ciphertext) = sealed.split_at_checked(ENCAPSULATED_KEY_BYTES)?;
    let encapsulated = <ChannelKem as hpke::Kem>::EncappedKey::from_bytes(encapsulated).ok()?;
    hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, ChannelKem>(
        &OpModeR::Auth(sender.clone()),
        recipient,
        &encapsulated,
        context,
        ciphertext,
        &[],
    )
    .ok()
    .map(Zeroizing::new)
}

/// A record file's name: its party and its sequence number, zero-padded so names sort in order.
fn record_name(party: PartyId, sequence: u64) -> String {
    format!("{party}-{sequence:020}")
}

/// The party and sequence number a record file's name holds; `None` for any other name.
fn parse_record_name(path: &Path) -> Option<(PartyId, u64)> {
    let (party, sequence) = path.file_name()?.to_str()?.split_once('-')?;
    Some((party.parse().ok()?, sequence.parse().ok()?))
}

/// Writes `sealed` to `folder` under `name` through a temporary name renamed into place, so a
/// watcher never reads half a record. Blocks.
fn write_record(folder: &Path, name: &str, sealed: &[u8]) -> io::Result<()> {
    create_file_atomically(
        &folder.join(name),
        sealed,
        RECORD_MODE,
        LeftoverSweep::Unswept,
    )
    .map_err(io::Error::other)
}

fn public_key_hex(key: &ChannelPublicKey) -> String {
    base16ct::lower::encode_string(&key.to_bytes())
}

// The public key in hexadecimal a restarted party's key argument holds; `None` for any other
// argument.
fn party_key_of(argument: &str) -> Option<&str> {
    argument.strip_prefix(PARTY_KEY_ARGUMENT_PREFIX)
}

fn parse_public_key(hex: &str) -> Option<ChannelPublicKey> {
    let bytes = base16ct::mixed::decode_vec(hex).ok()?;
    ChannelPublicKey::from_bytes(&bytes).ok()
}

/// A party the daemon admitted: the key its arguments hold and the last sequence number opened.
struct AdmittedParty {
    public_key: ChannelPublicKey,
    last_sequence: u64,
    next_request: u64,
    /// Whether the party is a wrapper that speaks for its command, as its `starting` record shows.
    is_wrapper: bool,
    /// Whether the party sits under another admitted party, so it speaks for no command: only its
    /// `starting`, which is answered `go` alone, and an askpass's `asking` are taken from it.
    is_nested: bool,
    /// The first of the party's own arguments, which is an askpass's prompt.
    first_argument: Option<String>,
    /// The nearest admitted wrapper above it that speaks for its command.
    wrapper: Option<PartyId>,
    /// The party's process, pinned at its admission, whose end releases what the daemon holds of
    /// it.
    process: PinnedProcess,
}

impl AdmittedParty {
    /// Opens the record `party` sealed under `sequence` to `daemon`; `None`, the record dropped,
    /// when it does not open under this party's context, opens but does not parse, which is logged,
    /// its number is not past the last one opened, or the party is nested and the record is neither
    /// `starting` nor `asking`. A number past the next one skips those between.
    fn open_record(
        &mut self,
        daemon: &ChannelPrivateKey,
        party: PartyId,
        sequence: u64,
        sealed: &[u8],
    ) -> Option<PartyRecord> {
        if sequence <= self.last_sequence {
            return None;
        }
        let context = record_context(Direction::ToDaemon, party, sequence);
        let plaintext = open(daemon, &self.public_key, &context, sealed)?;
        let record = match serde_json::from_slice(&plaintext) {
            Ok(record) => record,
            Err(error) => {
                tracing::warn!(
                    record = record_name(party, sequence),
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command channel's record opened but did not parse"
                );
                return None;
            }
        };
        self.last_sequence = sequence;
        if self.is_nested
            && !matches!(
                record,
                PartyRecord::Starting { .. } | PartyRecord::Asking {}
            )
        {
            tracing::debug!(party, "a nested command party's record was dropped");
            return None;
        }
        // A nested wrapper speaks for no command, so an askpass under it reaches the one above.
        if !self.is_nested && matches!(record, PartyRecord::Starting { .. }) {
            self.is_wrapper = true;
        }
        Some(record)
    }
}

/// What a party's first record makes of it: admitted, or refused with the key its arguments hold
/// where they hold one.
enum Admission {
    Admitted(AdmittedParty),
    Refused(Option<ChannelPublicKey>),
}

/// A record the daemon opened: its party, whether that party is nested, the wrapper an askpass sits
/// under, the record, and the party's first own argument, an askpass's prompt.
#[derive(Debug)]
pub(crate) struct ReceivedRecord {
    /// The party that wrote it.
    pub(crate) party: PartyId,
    /// Whether the party sits under another admitted party, so it speaks for no command.
    pub(crate) is_nested: bool,
    /// The nearest admitted wrapper above the party, for an askpass.
    pub(crate) wrapper: Option<PartyId>,
    /// The record.
    pub(crate) record: PartyRecord,
    /// The first argument the party was started with past its name, as git and ssh put an
    /// askpass's prompt there.
    pub(crate) first_argument: Option<String>,
}

/// A conversation's channel as the daemon holds it: its folder, its key pair, the provider process
/// every party must sit under once one is bound, and the parties admitted so far.
pub(crate) struct CommandChannel {
    folder: PathBuf,
    keys: (ChannelPrivateKey, ChannelPublicKey),
    /// The provider's process, bound once its spawn returns; `None` before, when no party is
    /// admitted.
    provider_process_id: Mutex<Option<u32>>,
    reader: Arc<dyn CallerProcessReader>,
    parties: Mutex<HashMap<PartyId, AdmittedParty>>,
}

impl CommandChannel {
    /// Opens the channel in `folder`, made private with its `requests` folder, for the parties
    /// read through `reader`; a new key pair each time. It admits no party until [`Self::bind`]
    /// names the provider's process, so it opens before the provider starts and its
    /// [`Self::environment`] goes into the provider's. Blocks; fails with the system's error when
    /// a folder cannot be made.
    pub(crate) fn open(folder: PathBuf, reader: Arc<dyn CallerProcessReader>) -> io::Result<Self> {
        create_private_folder(&folder.join(REQUESTS_FOLDER))?;
        Ok(Self {
            folder,
            keys: ChannelKem::gen_keypair(),
            provider_process_id: Mutex::new(None),
            reader,
            parties: Mutex::new(HashMap::new()),
        })
    }

    /// Binds the channel to the provider's process once its spawn returned, so the parties under
    /// it are admitted; a later process of the same conversation binds in its place.
    pub(crate) fn bind(&self, provider_process_id: u32) {
        *lock(&self.provider_process_id) = Some(provider_process_id);
    }

    /// The provider's process the channel is bound to; `None` before the first bind.
    #[cfg(test)]
    pub(crate) fn bound_process_id(&self) -> Option<u32> {
        *lock(&self.provider_process_id)
    }

    /// The channel's folder, which a provider's command sandbox lets commands write in.
    pub(crate) fn folder(&self) -> &Path {
        &self.folder
    }

    /// The folder inside the channel's folder that only the daemon writes, which a provider's
    /// command sandbox keeps commands from writing in.
    pub(crate) fn requests_folder(&self) -> PathBuf {
        self.folder.join(REQUESTS_FOLDER)
    }

    /// The variables a provider's commands carry so their parties reach this channel.
    pub(crate) fn environment(&self) -> [(&'static str, OsString); 2] {
        [
            (
                COMMAND_CHANNEL_VARIABLE,
                self.folder.clone().into_os_string(),
            ),
            (
                COMMAND_CHANNEL_KEY_VARIABLE,
                public_key_hex(&self.keys.1).into(),
            ),
        ]
    }

    /// A watch on the channel's records, made before the provider starts so no record lands
    /// before it, since the records already in the folder are no arrivals. Fails with the system's
    /// error when the folder cannot be watched.
    pub(crate) async fn watch(&self) -> io::Result<FolderArrivalWatch> {
        FolderArrivalWatch::watch(&self.folder).await
    }

    /// The records that arrived since the last call in name order, waiting on `watch` until one
    /// does. Fails only with the watch's error.
    #[cfg(test)]
    pub(crate) async fn next_records(
        &self,
        watch: &mut FolderArrivalWatch,
    ) -> io::Result<Vec<ReceivedRecord>> {
        loop {
            let received = self.take_records(watch.next_arrivals().await?).await;
            if !received.is_empty() {
                return Ok(received);
            }
        }
    }

    /// The records in `arrivals`, in their order; each file is removed once read, and a record
    /// that does not open, from a party outside the provider's process or out of order, is
    /// dropped, as is one whose read or whose party's admission read fails, which is logged.
    pub(crate) async fn take_records(&self, arrivals: Vec<PathBuf>) -> Vec<ReceivedRecord> {
        let mut received = Vec::new();
        for path in arrivals {
            let read = tokio::fs::read(&path).await;
            if let Err(error) = tokio::fs::remove_file(&path).await
                && error.kind() != ErrorKind::NotFound
            {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command channel's record could not be removed"
                );
            }
            let Some((party, sequence)) = parse_record_name(&path) else {
                continue;
            };
            let sealed = match read {
                Ok(sealed) => sealed,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!(
                        party,
                        error = &error as &(dyn std::error::Error + 'static),
                        "a command channel's record could not be read"
                    );
                    continue;
                }
            };
            match self.open_record(party, sequence, &sealed).await {
                Ok(Some(record)) => received.push(record),
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    party,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command channel's party could not be read for its admission"
                ),
            }
        }
        received
    }

    /// Writes `request` to `party`, sealed to its key. Fails with `NotFound` for a party not
    /// admitted, and with the write's error.
    pub(crate) async fn send_request(
        &self,
        party: PartyId,
        request: &DaemonRequest,
    ) -> io::Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(request).map_err(io::Error::other)?);
        let (public_key, sequence) = {
            let mut parties = lock(&self.parties);
            let admitted = parties.get_mut(&party).ok_or_else(|| {
                io::Error::new(ErrorKind::NotFound, "no such party on the command channel")
            })?;
            admitted.next_request += 1;
            (admitted.public_key.clone(), admitted.next_request)
        };
        let context = record_context(Direction::ToParty, party, sequence);
        let sealed = seal(&self.keys, &public_key, &context, &plaintext)?;
        let folder = self.folder.join(REQUESTS_FOLDER);
        tokio::task::spawn_blocking(move || {
            write_record(&folder, &record_name(party, sequence), &sealed)
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Forgets `party`, which has ended, so its key and numbers are not held and the requests it
    /// did not read are removed; a later record from its id is admitted afresh. A request that
    /// cannot be removed is logged.
    pub(crate) async fn forget_party(&self, party: PartyId) {
        lock(&self.parties).remove(&party);
        let requests = self.folder.join(REQUESTS_FOLDER);
        let removed =
            tokio::task::spawn_blocking(move || remove_party_requests(&requests, party)).await;
        if let Err(error) = removed
            .map_err(io::Error::other)
            .and_then(|removed| removed)
        {
            tracing::warn!(
                party,
                error = &error as &(dyn std::error::Error + 'static),
                "a command party's unread requests could not be removed"
            );
        }
    }

    /// The process of the admitted `party`, pinned at its admission; `None` for a party not
    /// admitted.
    pub(crate) fn party_process(&self, party: PartyId) -> Option<PinnedProcess> {
        lock(&self.parties)
            .get(&party)
            .map(|admitted| admitted.process.clone())
    }

    /// Closes the channel once its conversation ended, removing its folder and everything in it,
    /// while its follower and its open prompts still hold it. Fails with the system's error when
    /// the folder cannot be removed.
    pub(crate) async fn close(&self) -> io::Result<()> {
        tokio::fs::remove_dir_all(&self.folder).await
    }

    /// Opens one record, admitting its party first when it is new; `None` when it is dropped.
    async fn open_record(
        &self,
        party: PartyId,
        sequence: u64,
        sealed: &[u8],
    ) -> io::Result<Option<ReceivedRecord>> {
        let is_admitted = lock(&self.parties).contains_key(&party);
        if !is_admitted {
            let admitted = match self.admit(party).await? {
                Admission::Admitted(admitted) => admitted,
                Admission::Refused(key) => {
                    tracing::debug!(
                        party,
                        "a command channel refused a party outside its provider"
                    );
                    if let Some(key) = key {
                        self.answer_refused_askpass(party, &key, sequence, sealed)
                            .await?;
                    }
                    return Ok(None);
                }
            };
            lock(&self.parties).entry(party).or_insert(admitted);
        }
        let mut parties = lock(&self.parties);
        // A party forgotten meanwhile has ended, so its record is dropped.
        let Some(admitted) = parties.get_mut(&party) else {
            return Ok(None);
        };
        let (is_nested, wrapper) = (admitted.is_nested, admitted.wrapper);
        let first_argument = admitted.first_argument.clone();
        Ok(admitted
            .open_record(&self.keys.0, party, sequence, sealed)
            .map(|record| ReceivedRecord {
                party,
                is_nested,
                wrapper,
                record,
                first_argument,
            }))
    }

    /// Answers a refused party's `asking`, which it sealed under `sequence` with `key`, with the
    /// empty answer, so its git or ssh reads the prompt as canceled and never waits on it; any
    /// other record is left. Fails with the write's error.
    async fn answer_refused_askpass(
        &self,
        party: PartyId,
        key: &ChannelPublicKey,
        sequence: u64,
        sealed: &[u8],
    ) -> io::Result<()> {
        let context = record_context(Direction::ToDaemon, party, sequence);
        let is_asking = open(&self.keys.0, key, &context, sealed)
            .and_then(|plaintext| serde_json::from_slice::<PartyRecord>(&plaintext).ok())
            .is_some_and(|record| matches!(record, PartyRecord::Asking {}));
        if !is_asking {
            return Ok(());
        }
        let answer = DaemonRequest::Answer {
            text: String::new(),
        };
        let plaintext = Zeroizing::new(serde_json::to_vec(&answer).map_err(io::Error::other)?);
        let context = record_context(Direction::ToParty, party, 1);
        let sealed = seal(&self.keys, key, &context, &plaintext)?;
        let folder = self.folder.join(REQUESTS_FOLDER);
        tokio::task::spawn_blocking(move || write_record(&folder, &record_name(party, 1), &sealed))
            .await
            .map_err(io::Error::other)?
    }

    /// Admits `party` by the key its first argument holds when it sits under the provider's
    /// process, noting the nearest admitted wrapper above it and whether any party is, admitted or
    /// holding a party's key in its own arguments; refused, with the key where it holds one, when
    /// it does not, holds no key, has ended or no provider's process is bound yet. Fails when the
    /// system refuses a read.
    async fn admit(&self, party: PartyId) -> io::Result<Admission> {
        let read = tokio::task::spawn_blocking(move || {
            Ok::<_, io::Error>((read_process_start(party)?, pin_running_process(party)?))
        })
        .await
        .map_err(io::Error::other)??;
        let (Some(start), Some(pinned)) = read else {
            return Ok(Admission::Refused(None));
        };
        let Some(public_key) = start
            .arguments
            .get(1)
            .and_then(|argument| party_key_of(argument))
            .and_then(parse_public_key)
        else {
            return Ok(Admission::Refused(None));
        };
        let Some(provider_process_id) = *lock(&self.provider_process_id) else {
            return Ok(Admission::Refused(Some(public_key)));
        };
        let first_argument = start.arguments.get(2).cloned();
        let mut wrapper = None;
        let mut is_nested = false;
        let mut process = pinned.clone();
        loop {
            let parent = match self.reader.read_parent_process(process).await? {
                ParentProcess::Pinned(parent) => parent,
                ParentProcess::Root | ParentProcess::Ended => {
                    return Ok(Admission::Refused(Some(public_key)));
                }
            };
            if parent.id() == provider_process_id {
                return Ok(Admission::Admitted(AdmittedParty {
                    public_key,
                    last_sequence: 0,
                    next_request: 0,
                    is_wrapper: false,
                    is_nested,
                    first_argument,
                    wrapper,
                    process: pinned,
                }));
            }
            if parent.id() <= 1 {
                return Ok(Admission::Refused(Some(public_key)));
            }
            let admitted_ancestor = lock(&self.parties)
                .get(&parent.id())
                .map(|ancestor| ancestor.is_wrapper);
            match admitted_ancestor {
                Some(is_wrapper) => {
                    is_nested = true;
                    if wrapper.is_none() && is_wrapper {
                        wrapper = Some(parent.id());
                    }
                }
                // An ancestor whose first record is not taken yet is a party all the same.
                None => is_nested |= holds_party_key(parent.id()).await?,
            }
            process = parent;
        }
    }
}

// Whether process `id` holds a party's key as its first own argument, as every party does from
// its restart on. Fails when the system refuses the read.
async fn holds_party_key(id: u32) -> io::Result<bool> {
    let start = tokio::task::spawn_blocking(move || read_process_start(id))
        .await
        .map_err(io::Error::other)??;
    Ok(start.is_some_and(|start| {
        start
            .arguments
            .get(1)
            .is_some_and(|argument| party_key_of(argument).is_some())
    }))
}

// Removes the requests in `requests` addressed to `party`. Blocks; fails with the listing's or a
// removal's error, a request already gone aside.
fn remove_party_requests(requests: &Path, party: PartyId) -> io::Result<()> {
    for entry in std::fs::read_dir(requests)? {
        let path = entry?.path();
        if parse_record_name(&path).is_some_and(|(addressed, _)| addressed == party) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

/// Removes every conversation's channel folder a previous run left in `data_folder`, at the
/// daemon's start, before any opens. Fails with the system's error when one cannot be removed.
pub async fn remove_channel_folders(data_folder: &Path) -> io::Result<()> {
    let mut entries = match tokio::fs::read_dir(command_channel_root(data_folder)).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_dir() {
            tokio::fs::remove_dir_all(entry.path()).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
