//! Whether the process that opened a connection is an agent's, and whether it is the desktop's
//! signed client. A provider, a command an agent ran, a git hook or a setup command, and anything
//! any of them started in turn, all descend from the daemon, and a command a session runs on the
//! person's own provider service descends from that service, which the daemon dials. The person's
//! own clients descend from neither: the desktop's main process starts or finds the daemon, and the
//! command line runs from the person's terminal. The one exception is a terminal the daemon opened
//! for the person, whose programs are theirs.
//!
//! Where the system keeps a responsible process (macOS), the daemon is its own and every terminal
//! it opens is its own, so a caller the daemon is responsible for is an agent's and the walk up the
//! parents looks only for a held provider service. Elsewhere the walk decides alone.

use std::collections::HashSet;
use std::error::Error;
use std::io;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_platforms::{ParentProcess, PinnedProcess, ResponsibleProcess, SignatureCheck};
use tokio::sync::Semaphore;

use crate::caller_process::contract::CallerProcessReader;
use crate::caller_process::provider_services::ProviderServiceProcesses;
use crate::protocol_negotiation::{CallerAdmission, CallerAdmissionCheck};

/// How many signature checks run at once; each holds a blocking thread for a few milliseconds, so
/// a burst of connections waits here instead of filling the blocking pool.
const CONCURRENT_SIGNATURE_CHECKS: usize = 4;

/// Reads the ids of the processes the daemon started as the person's terminals.
pub(crate) type TerminalProcessIds = Arc<dyn Fn() -> HashSet<u32> + Send + Sync>;

/// The check a connection's handshake runs on this daemon's caller.
pub struct CallerCheck {
    /// Reads the caller's parents, responsible process and signature.
    reader: Arc<dyn CallerProcessReader>,
    /// The person's terminals, whose programs are theirs where the system keeps no responsible
    /// process.
    terminals: TerminalProcessIds,
    /// The provider services the daemon holds connections to.
    provider_services: Arc<ProviderServiceProcesses>,
    /// Bounds the signature checks running at once.
    signature_checks: Semaphore,
    /// This daemon's process id.
    daemon_process_id: u32,
}

impl CallerCheck {
    /// The check for this daemon, reading through `reader`, with the person's terminals read
    /// through `terminals` and the provider services held in `provider_services`.
    pub fn new(
        reader: Arc<dyn CallerProcessReader>,
        terminals: TerminalProcessIds,
        provider_services: Arc<ProviderServiceProcesses>,
    ) -> Arc<Self> {
        Arc::new(Self {
            reader,
            terminals,
            provider_services,
            signature_checks: Semaphore::new(CONCURRENT_SIGNATURE_CHECKS),
            daemon_process_id: std::process::id(),
        })
    }

    /// The check as the negotiator runs it; a read the system refuses answers the handshake
    /// `-32603`.
    pub fn admission_check(self: &Arc<Self>) -> CallerAdmissionCheck {
        let check = Arc::clone(self);
        Arc::new(move |caller: PinnedProcess, is_tokenless: bool| {
            let check = Arc::clone(&check);
            async move {
                check
                    .admit(caller, is_tokenless)
                    .await
                    .map_err(|error| Arc::new(error) as Arc<dyn Error + Send + Sync>)
            }
            .boxed()
        })
    }

    /// How `caller` is admitted: refused when the daemon or a held provider service started it or
    /// nothing vouches for it; admitted by its signature when `is_tokenless` and it is the
    /// desktop's signed client helper; otherwise only with the session token. A signature that does
    /// not meet the requirement is logged at debug with its status. Fails when the system refuses
    /// a read.
    async fn admit(
        &self,
        caller: PinnedProcess,
        is_tokenless: bool,
    ) -> io::Result<CallerAdmission> {
        let responsible = self.reader.read_responsible_process(caller.clone()).await?;
        let is_untracked = match &responsible {
            ResponsibleProcess::ThisProcess | ResponsibleProcess::Ended => {
                return Ok(CallerAdmission::Refused);
            }
            ResponsibleProcess::Untracked => true,
            ResponsibleProcess::Itself | ResponsibleProcess::Another(_) => false,
        };
        if self
            .is_agent_descendant(caller.clone(), is_untracked)
            .await?
        {
            return Ok(CallerAdmission::Refused);
        }
        // Only a helper the app started is the client: a process responsible for itself may be one
        // that took over a connection and then ran the signed helper's program.
        let ResponsibleProcess::Another(app) = responsible else {
            return Ok(CallerAdmission::TokenRequired);
        };
        if !is_tokenless {
            return Ok(CallerAdmission::TokenRequired);
        }
        let _permit = self
            .signature_checks
            .acquire()
            .await
            .expect("the signature checks' semaphore is never closed");
        Ok(match self.reader.check_desktop_client(caller, app).await? {
            Some(SignatureCheck::Met) => CallerAdmission::Signature,
            Some(SignatureCheck::NotMet { status }) => {
                tracing::debug!(
                    status,
                    "a tokenless caller's signature did not meet the desktop client's requirement"
                );
                CallerAdmission::TokenRequired
            }
            None => CallerAdmission::TokenRequired,
        })
    }

    /// Whether `caller` is, or descends from, a held provider service, or, where the system keeps
    /// no responsible process (`is_untracked`), descends from the daemon other than through one of
    /// the person's terminals. A caller whose parents cannot all be read, because one ended during
    /// the read, counts as an agent's, since nothing then vouches for it. Where the system keeps a
    /// responsible process the walk runs only while a provider service is held.
    async fn is_agent_descendant(
        &self,
        caller: PinnedProcess,
        is_untracked: bool,
    ) -> io::Result<bool> {
        if !is_untracked && !self.provider_services.is_holding_any() {
            return Ok(false);
        }
        let mut visited = HashSet::from([caller.id()]);
        let mut process = caller;
        loop {
            if self.provider_services.has(process.id()) {
                return Ok(true);
            }
            let parent = match self.reader.read_parent_process(process.clone()).await? {
                ParentProcess::Pinned(parent) => parent,
                ParentProcess::Root => return Ok(false),
                ParentProcess::Ended => return Ok(true),
            };
            if parent.id() == self.daemon_process_id {
                return Ok(is_untracked && !(self.terminals)().contains(&process.id()));
            }
            // The system's first process, or its kernel parent, ends every chain the daemon is not
            // on.
            if parent.id() <= 1 {
                return Ok(false);
            }
            // An id handed to a new process mid-read can close a loop; such a reading vouches for
            // nothing.
            if !visited.insert(parent.id()) {
                return Ok(true);
            }
            process = parent;
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_reader;

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use rstest::rstest;
    use sidekicks_platforms::{ParentProcess, ResponsibleProcess, this_process};

    use super::CallerCheck;
    use super::test_reader::ScriptedReader;
    use crate::caller_process::contract::CallerProcessReader;
    use crate::caller_process::provider_services::ProviderServiceProcesses;
    use crate::protocol_negotiation::CallerAdmission;

    // The test's own process stands in for every process; its id is also the daemon's, so a
    // parent read as the test's process is the daemon.
    #[rstest]
    #[case::the_daemon_is_responsible(
        ResponsibleProcess::ThisProcess,
        ParentProcess::Root,
        true,
        false,
        CallerAdmission::Refused
    )]
    #[case::the_caller_ended(
        ResponsibleProcess::Ended,
        ParentProcess::Root,
        true,
        false,
        CallerAdmission::Refused
    )]
    #[case::a_signed_helper_responsible_for_itself(
        ResponsibleProcess::Itself,
        ParentProcess::Root,
        true,
        false,
        CallerAdmission::TokenRequired
    )]
    #[case::a_signed_helper_the_app_started(
        ResponsibleProcess::Another(this_process()),
        ParentProcess::Root,
        true,
        false,
        CallerAdmission::Signature
    )]
    #[case::an_unsigned_caller(
        ResponsibleProcess::Another(this_process()),
        ParentProcess::Root,
        false,
        false,
        CallerAdmission::TokenRequired
    )]
    #[case::untracked_under_the_daemon(
        ResponsibleProcess::Untracked,
        ParentProcess::Pinned(this_process()),
        true,
        false,
        CallerAdmission::Refused
    )]
    #[case::untracked_in_the_persons_terminal(
        ResponsibleProcess::Untracked,
        ParentProcess::Pinned(this_process()),
        true,
        true,
        CallerAdmission::TokenRequired
    )]
    #[case::untracked_with_a_parent_gone(
        ResponsibleProcess::Untracked,
        ParentProcess::Ended,
        true,
        false,
        CallerAdmission::Refused
    )]
    #[case::untracked_outside_the_daemon(
        ResponsibleProcess::Untracked,
        ParentProcess::Root,
        true,
        false,
        CallerAdmission::TokenRequired
    )]
    #[tokio::test]
    async fn a_caller_is_admitted_by_its_responsible_process_its_parents_and_its_signature(
        #[case] responsible: ResponsibleProcess,
        #[case] parent: ParentProcess,
        #[case] is_desktop_client: bool,
        #[case] is_in_a_terminal: bool,
        #[case] expected: CallerAdmission,
    ) {
        let reader = Arc::new(ScriptedReader {
            responsible,
            parent,
            is_desktop_client,
            was_signature_read: AtomicBool::new(false),
        });
        let terminals = if is_in_a_terminal {
            HashSet::from([std::process::id()])
        } else {
            HashSet::new()
        };
        let check = CallerCheck::new(
            Arc::clone(&reader) as Arc<dyn CallerProcessReader>,
            Arc::new(move || terminals.clone()),
            Arc::new(ProviderServiceProcesses::default()),
        );
        let admit = check.admission_check();

        let tokenless = admit(this_process(), true)
            .await
            .expect("the check answers");
        assert_eq!(tokenless, expected);
        // A handshake that carries a token never reads the signature, so it is never admitted by
        // it.
        reader.was_signature_read.store(false, Ordering::SeqCst);
        let with_token = admit(this_process(), false)
            .await
            .expect("the check answers");
        assert_eq!(
            with_token,
            match expected {
                CallerAdmission::Signature => CallerAdmission::TokenRequired,
                CallerAdmission::Refused | CallerAdmission::TokenRequired => expected,
            }
        );
        assert!(!reader.was_signature_read.load(Ordering::SeqCst));
    }
}
