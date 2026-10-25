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
use std::sync::{Arc, Mutex, PoisonError};

use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as _, OpModeR, OpModeS, Serializable};
use serde::{Deserialize, Serialize};
use sidekicks_platforms::{
    FolderArrivalWatch, LeftoverSweep, ParentProcess, TerminalDevice, TerminalMasterReading,
    create_file_atomically, create_private_folder, pin_running_process, read_process_start,
};
use zeroize::Zeroizing;

use crate::ipc::caller_process::contract::CallerProcessReader;

pub(crate) mod party;
pub(crate) mod records;

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
const REQUESTS_FOLDER: &str = "requests";

/// The context string every seal and open binds.
const SEALING_INFO: &[u8] = b"sidekicks command channel";

/// The bytes the encapsulated key takes at the head of a sealed record.
const ENCAPSULATED_KEY_BYTES: usize = 32;

/// The mode a record is written with: the account's own processes alone read it.
const RECORD_MODE: u32 = 0o600;

type ChannelKem = X25519HkdfSha256;
type ChannelPrivateKey = <ChannelKem as hpke::Kem>::PrivateKey;
type ChannelPublicKey = <ChannelKem as hpke::Kem>::PublicKey;

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

/// The additional data a record's seal binds: its direction, its party and its sequence number.
fn additional_data(direction: Direction, party: PartyId, sequence: u64) -> [u8; 13] {
    let mut data = [0_u8; 13];
    data[0] = direction as u8;
    data[1..5].copy_from_slice(&party.to_be_bytes());
    data[5..].copy_from_slice(&sequence.to_be_bytes());
    data
}

/// Seals `plaintext` from the holder of `sender` to `recipient`: the encapsulated key, then the
/// ciphertext. Fails with the system's error when no random bytes can be read.
fn seal(
    sender: &(ChannelPrivateKey, ChannelPublicKey),
    recipient: &ChannelPublicKey,
    data: &[u8],
    plaintext: &[u8],
) -> io::Result<Vec<u8>> {
    let mode = OpModeS::Auth((sender.0.clone(), sender.1.clone()));
    let (encapsulated, ciphertext) = hpke::single_shot_seal::<
        ChaCha20Poly1305,
        HkdfSha256,
        ChannelKem,
    >(&mode, recipient, SEALING_INFO, plaintext, data)
    .map_err(io::Error::other)?;
    let mut sealed = encapsulated.to_bytes().to_vec();
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Opens what `sender` sealed to the holder of `recipient` under `data`; `None` when it does not
/// open, as a forged, cut or misdirected record does not.
fn open(
    recipient: &ChannelPrivateKey,
    sender: &ChannelPublicKey,
    data: &[u8],
    sealed: &[u8],
) -> Option<Zeroizing<Vec<u8>>> {
    let (encapsulated, ciphertext) = sealed.split_at_checked(ENCAPSULATED_KEY_BYTES)?;
    let encapsulated = <ChannelKem as hpke::Kem>::EncappedKey::from_bytes(encapsulated).ok()?;
    hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, ChannelKem>(
        &OpModeR::Auth(sender.clone()),
        recipient,
        &encapsulated,
        SEALING_INFO,
        ciphertext,
        data,
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
    /// Whether the party is a wrapper, as its `starting` record shows.
    is_wrapper: bool,
    /// The first of the party's own arguments, which is an askpass's prompt.
    first_argument: Option<String>,
    /// For an askpass, the nearest admitted wrapper above it.
    wrapper: Option<PartyId>,
}

impl AdmittedParty {
    /// Opens the record `party` sealed under `sequence` to `daemon`; `None`, the record dropped,
    /// when it does not open under this party's context or its number is not past the last one
    /// opened. A number past the next one skips those between.
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
        let data = additional_data(Direction::ToDaemon, party, sequence);
        let plaintext = open(daemon, &self.public_key, &data, sealed)?;
        let record = serde_json::from_slice(&plaintext).ok()?;
        self.last_sequence = sequence;
        if matches!(record, PartyRecord::Starting { .. }) {
            self.is_wrapper = true;
        }
        Some(record)
    }
}

/// A record the daemon opened: its party, the wrapper an askpass sits under, the record, and the
/// party's first own argument, an askpass's prompt.
#[derive(Debug)]
pub(crate) struct ReceivedRecord {
    /// The party that wrote it.
    pub(crate) party: PartyId,
    /// The nearest admitted wrapper above the party, for an askpass.
    pub(crate) wrapper: Option<PartyId>,
    /// The record.
    pub(crate) record: PartyRecord,
    /// The first argument the party was started with past its name, as git and ssh put an
    /// askpass's prompt there.
    pub(crate) first_argument: Option<String>,
}

/// A conversation's channel as the daemon holds it: its folder, its key pair, the provider process
/// every party must sit under, and the parties admitted so far.
pub(crate) struct CommandChannel {
    folder: PathBuf,
    keys: (ChannelPrivateKey, ChannelPublicKey),
    provider_process_id: u32,
    reader: Arc<dyn CallerProcessReader>,
    parties: Mutex<HashMap<PartyId, AdmittedParty>>,
}

impl CommandChannel {
    /// Opens the channel in `folder`, made private with its `requests` folder, for the parties
    /// that sit under `provider_process_id`, read through `reader`; a new key pair each time.
    /// Blocks; fails with the system's error when a folder cannot be made.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "each driver opens its conversations' channels")
    )]
    pub(crate) fn open(
        folder: PathBuf,
        provider_process_id: u32,
        reader: Arc<dyn CallerProcessReader>,
    ) -> io::Result<Self> {
        create_private_folder(&folder.join(REQUESTS_FOLDER))?;
        Ok(Self {
            folder,
            keys: ChannelKem::gen_keypair(),
            provider_process_id,
            reader,
            parties: Mutex::new(HashMap::new()),
        })
    }

    /// The variables a provider's commands carry so their parties reach this channel.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "each driver hands its provider the channel's variables"
        )
    )]
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

    /// A watch on the channel's records. Fails with the system's error when the folder cannot be
    /// watched.
    pub(crate) async fn watch(&self) -> io::Result<FolderArrivalWatch> {
        FolderArrivalWatch::watch(&self.folder).await
    }

    /// The records that arrived since the last call in name order, waiting on `watch` until one
    /// does; each file is removed once read, and a record that does not open, from a party
    /// outside the provider's process or out of order, is dropped. Fails with the watch's error.
    pub(crate) async fn next_records(
        &self,
        watch: &mut FolderArrivalWatch,
    ) -> io::Result<Vec<ReceivedRecord>> {
        loop {
            let mut received = Vec::new();
            for path in watch.next_arrivals().await? {
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
                    Err(error) => return Err(error),
                };
                if let Some(record) = self.open_record(party, sequence, &sealed).await? {
                    received.push(record);
                }
            }
            if !received.is_empty() {
                return Ok(received);
            }
        }
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
            let mut parties = self.parties.lock().unwrap_or_else(PoisonError::into_inner);
            let admitted = parties.get_mut(&party).ok_or_else(|| {
                io::Error::new(ErrorKind::NotFound, "no such party on the command channel")
            })?;
            admitted.next_request += 1;
            (admitted.public_key.clone(), admitted.next_request)
        };
        let data = additional_data(Direction::ToParty, party, sequence);
        let sealed = seal(&self.keys, &public_key, &data, &plaintext)?;
        let folder = self.folder.join(REQUESTS_FOLDER);
        tokio::task::spawn_blocking(move || {
            write_record(&folder, &record_name(party, sequence), &sealed)
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Forgets `party`, which has ended or been answered, so its key and numbers are not held;
    /// a later record from its id is admitted afresh.
    pub(crate) fn forget_party(&self, party: PartyId) {
        self.parties
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&party);
    }

    /// Opens one record, admitting its party first when it is new; `None` when it is dropped.
    async fn open_record(
        &self,
        party: PartyId,
        sequence: u64,
        sealed: &[u8],
    ) -> io::Result<Option<ReceivedRecord>> {
        let is_admitted = self
            .parties
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&party);
        if !is_admitted {
            let Some(admitted) = self.admit(party).await? else {
                tracing::debug!(
                    party,
                    "a command channel refused a party outside its provider"
                );
                return Ok(None);
            };
            self.parties
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(party)
                .or_insert(admitted);
        }
        let mut parties = self.parties.lock().unwrap_or_else(PoisonError::into_inner);
        // A party forgotten meanwhile has ended, so its record is dropped.
        let Some(admitted) = parties.get_mut(&party) else {
            return Ok(None);
        };
        let wrapper = admitted.wrapper;
        let first_argument = admitted.first_argument.clone();
        Ok(admitted
            .open_record(&self.keys.0, party, sequence, sealed)
            .map(|record| ReceivedRecord {
                party,
                wrapper,
                record,
                first_argument,
            }))
    }

    /// Admits `party` by the key its first argument holds when it sits under the provider's
    /// process, noting the nearest admitted wrapper above it; `None` when it does not, holds no
    /// key or has ended. Fails when the system refuses a read.
    async fn admit(&self, party: PartyId) -> io::Result<Option<AdmittedParty>> {
        let read = tokio::task::spawn_blocking(move || {
            Ok::<_, io::Error>((read_process_start(party)?, pin_running_process(party)?))
        })
        .await
        .map_err(io::Error::other)??;
        let (Some(start), Some(mut process)) = read else {
            return Ok(None);
        };
        let Some(public_key) = start
            .arguments
            .get(1)
            .and_then(|argument| party_key_of(argument))
            .and_then(parse_public_key)
        else {
            return Ok(None);
        };
        let first_argument = start.arguments.get(2).cloned();
        let mut wrapper = None;
        loop {
            let parent = match self.reader.read_parent_process(process).await? {
                ParentProcess::Pinned(parent) => parent,
                ParentProcess::Root | ParentProcess::Ended => return Ok(None),
            };
            if parent.id() == self.provider_process_id {
                return Ok(Some(AdmittedParty {
                    public_key,
                    last_sequence: 0,
                    next_request: 0,
                    is_wrapper: false,
                    first_argument,
                    wrapper,
                }));
            }
            if parent.id() <= 1 {
                return Ok(None);
            }
            if wrapper.is_none()
                && self
                    .parties
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(&parent.id())
                    .is_some_and(|ancestor| ancestor.is_wrapper)
            {
                wrapper = Some(parent.id());
            }
            process = parent;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::Arc;

    use hpke::Kem as _;

    use super::{
        AdmittedParty, ChannelKem, CommandChannel, Direction, PARTY_KEY_ARGUMENT_PREFIX,
        PartyRecord, additional_data, public_key_hex, seal,
    };
    use crate::ipc::caller_process::system_reader::ProcessTableReader;
    use crate::provider::command::harness_test_name;

    /// The process a test starts as a party: it prints `ready` and waits for its input to end.
    const PARTY_PROCESS_TEST: &str = "a_party_process_waits_for_its_input_to_end";

    fn record() -> PartyRecord {
        PartyRecord::Exited {
            exit_code: Some(0),
            signal: None,
        }
    }

    // Fails when a record opens under the other direction's context or another party's key, or
    // when a number at or below the last one opened is taken, a replay among them.
    #[test]
    fn a_record_opens_only_under_its_own_context_key_and_a_rising_number() {
        let daemon = ChannelKem::gen_keypair();
        let party_keys = ChannelKem::gen_keypair();
        let forger = ChannelKem::gen_keypair();
        let party = 4242;
        let plaintext = serde_json::to_vec(&record()).expect("a record writes");
        let sealed = |keys, direction, sequence| {
            seal(
                keys,
                &daemon.1,
                &additional_data(direction, party, sequence),
                &plaintext,
            )
            .expect("a record seals")
        };
        let mut admitted = AdmittedParty {
            public_key: party_keys.1.clone(),
            last_sequence: 0,
            next_request: 0,
            is_wrapper: false,
            first_argument: None,
            wrapper: None,
        };
        let mut open =
            |sequence, sealed: Vec<u8>| admitted.open_record(&daemon.0, party, sequence, &sealed);
        assert_eq!(open(1, sealed(&party_keys, Direction::ToParty, 1)), None);
        assert_eq!(open(1, sealed(&forger, Direction::ToDaemon, 1)), None);
        assert_eq!(open(2, sealed(&party_keys, Direction::ToDaemon, 1)), None);
        let second = sealed(&party_keys, Direction::ToDaemon, 2);
        assert_eq!(open(2, second.clone()), Some(record()));
        assert_eq!(open(2, second), None);
        assert_eq!(open(1, sealed(&party_keys, Direction::ToDaemon, 1)), None);
        assert_eq!(
            open(5, sealed(&party_keys, Direction::ToDaemon, 5)),
            Some(record())
        );
    }

    // Fails when a party's place under the provider's process goes unchecked, so a process outside
    // it that holds a key is admitted.
    #[tokio::test]
    async fn a_party_outside_the_providers_process_is_refused_at_its_first_record() {
        let folder = tempfile::tempdir().expect("a folder");
        let keys = ChannelKem::gen_keypair();
        let test_name = harness_test_name(module_path!(), PARTY_PROCESS_TEST);
        let mut party = Command::new(std::env::current_exe().expect("the test program"))
            .arg(format!(
                "{PARTY_KEY_ARGUMENT_PREFIX}{}",
                public_key_hex(&keys.1)
            ))
            .args(["--exact", &test_name, "--ignored", "--nocapture", "--quiet"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("the party starts");
        let mut lines = BufReader::new(party.stdout.take().expect("its output")).lines();
        while !lines
            .next()
            .expect("the party prints")
            .expect("a line")
            .ends_with("ready")
        {}
        let mut outsider = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("a process outside the party's tree starts");
        let reader = Arc::new(ProcessTableReader::for_this_program().expect("a reader"));
        for (provider, is_admitted) in [(outsider.id(), false), (std::process::id(), true)] {
            let channel = CommandChannel::open(
                folder.path().join(provider.to_string()),
                provider,
                Arc::clone(&reader) as _,
            )
            .expect("the channel opens");
            let data = additional_data(Direction::ToDaemon, party.id(), 1);
            let plaintext = serde_json::to_vec(&record()).expect("a record writes");
            let sealed = seal(&keys, &channel.keys.1, &data, &plaintext).expect("it seals");
            let opened = channel
                .open_record(party.id(), 1, &sealed)
                .await
                .expect("the party's place reads");
            assert_eq!(opened.is_some(), is_admitted, "provider {provider}");
        }
        drop(party.stdin.take());
        party.wait().expect("the party ends once its input does");
        outsider.kill().expect("the test's own child ends");
        outsider.wait().expect("it is reaped");
    }

    #[test]
    #[ignore = "run only as the party process another test starts"]
    fn a_party_process_waits_for_its_input_to_end() {
        let mut output = std::io::stdout().lock();
        std::io::Write::write_all(&mut output, b"ready\n").expect("it prints");
        std::io::Write::flush(&mut output).expect("it flushes");
        drop(output);
        let mut input = String::new();
        while std::io::stdin().read_line(&mut input).expect("it reads") > 0 {}
    }
}
