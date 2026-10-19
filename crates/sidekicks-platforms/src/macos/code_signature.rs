//! The code signature the desktop's client helper is admitted by. The requirement is built at start
//! from this program's own signature: the helper must carry the app's helper identifier, be signed
//! by the same team as this program under Apple's certificate chain, and have library validation
//! on; the process responsible for it must be the app itself, signed the same way. A program with
//! no team in its signature (a development build) builds no requirement and admits no client by
//! its signature.

use std::io;
use std::ptr::NonNull;

use objc2_core_foundation::{CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_security::{
    SecCSFlags, SecCode, SecRequirement, SecStaticCode, errSecCSRemoteSignerFailed,
    errSecCSUnimplemented, kSecCSSigningInformation, kSecCodeInfoTeamIdentifier,
    kSecGuestAttributeAudit, kSecGuestAttributePid,
};

use crate::PinnedProcess;
use crate::code_signature::{CodeSignatureError, SignatureCheck};
use crate::macos::pinned_process::is_running;
use crate::posix::process::id::system_process_id;

/// The kernel's "no such process" as the Security framework reports it: its POSIX error base
/// (100000) plus `ESRCH`, for a process that ended before its signature was read.
const NO_SUCH_PROCESS_STATUS: i32 = 100_000 + libc::ESRCH;

/// The identifier Electron gives the helper program each of an app's processes runs in, after the
/// app's own.
const HELPER_IDENTIFIER_SUFFIX: &str = ".helper";

/// A compiled code requirement, read by every signature check.
struct Requirement(CFRetained<SecRequirement>);

// SAFETY: a compiled requirement is never changed after it is built, and the Security framework
// only reads it during a check, so checks on several threads may share it.
unsafe impl Send for Requirement {}
// SAFETY: as above, every use of a shared requirement only reads it.
unsafe impl Sync for Requirement {}

/// The signatures a desktop client meets: the requirement its helper process meets and the one the
/// app process responsible for it meets.
pub struct DesktopClientRequirement {
    /// What the client helper's signature meets.
    helper: Requirement,
    /// What the signature of the app responsible for the helper meets.
    app: Requirement,
}

impl DesktopClientRequirement {
    /// The requirement for the app `app_identifier`'s helper, signed by this program's own team;
    /// `None` when this program's signature names no team, so no client is admitted by its
    /// signature. Fails when this program's signature cannot be read, when its team is not one a
    /// requirement can name, or when a requirement does not compile.
    pub fn for_this_program(app_identifier: &str) -> Result<Option<Self>, CodeSignatureError> {
        let Some(team) = read_own_team()? else {
            return Ok(None);
        };
        if team.is_empty()
            || !team
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        {
            return Err(CodeSignatureError::TeamIdentifier);
        }
        let helper_identifier = format!("{app_identifier}{HELPER_IDENTIFIER_SUFFIX}");
        Ok(Some(Self {
            helper: compile(&signed_by_team(&helper_identifier, &team))?,
            app: compile(&signed_by_team(app_identifier, &team))?,
        }))
    }

    /// A requirement from the text of the helper's and the app's requirements, for tests that
    /// check programs the system signs. Fails when either does not compile.
    #[cfg(any(test, feature = "test-support"))]
    pub fn from_requirement_text(helper: &str, app: &str) -> Result<Self, CodeSignatureError> {
        Ok(Self {
            helper: compile(helper)?,
            app: compile(app)?,
        })
    }

    /// Whether `caller` runs a helper that meets the requirement and `responsible`, the process
    /// responsible for it, runs the app that does. A program that is unsigned, signed otherwise,
    /// changed on disk, or that ended or ran another program since it was pinned, does not meet
    /// it, and the answer carries the status that said so; fails only when the system cannot
    /// check.
    pub fn check(
        &self,
        caller: &PinnedProcess,
        responsible: &PinnedProcess,
    ) -> io::Result<SignatureCheck> {
        match meets(caller, &self.helper)? {
            SignatureCheck::Met => meets(responsible, &self.app),
            not_met @ SignatureCheck::NotMet { .. } => Ok(not_met),
        }
    }
}

/// The requirement that `identifier` is signed by `team` under Apple's certificate chain with
/// library validation on, so the signed program loads no library another team signed.
fn signed_by_team(identifier: &str, team: &str) -> String {
    format!(
        "anchor apple generic and identifier \"{identifier}\" and certificate leaf[subject.OU] = \
         \"{team}\" and ! entitlement[\"com.apple.security.cs.disable-library-validation\"] exists"
    )
}

/// `text` compiled. Fails with the Security framework's status when it does not compile.
fn compile(text: &str) -> Result<Requirement, CodeSignatureError> {
    let text = CFString::from_str(text);
    let mut requirement: *mut SecRequirement = std::ptr::null_mut();
    // SAFETY: `requirement` is a live pointer the call fills with a new requirement it owns.
    let status = unsafe {
        SecRequirement::create_with_string(
            &text,
            SecCSFlags::DefaultFlags,
            NonNull::from(&mut requirement),
        )
    };
    if status != 0 {
        return Err(CodeSignatureError::Compile { status });
    }
    let requirement = NonNull::new(requirement).ok_or(CodeSignatureError::Compile { status: 0 })?;
    // SAFETY: the call succeeded and handed over one reference to the new requirement.
    Ok(Requirement(unsafe { CFRetained::from_raw(requirement) }))
}

/// The team in this program's own signature; `None` when it names none (an ad hoc signature).
/// Fails with the Security framework's status when the signature cannot be read.
fn read_own_team() -> Result<Option<String>, CodeSignatureError> {
    let mut own: *mut SecCode = std::ptr::null_mut();
    // SAFETY: `own` is a live pointer the call fills with a new reference to this program's code.
    let status = unsafe { SecCode::copy_self(SecCSFlags::DefaultFlags, NonNull::from(&mut own)) };
    let own = owned(status, own).map_err(|status| CodeSignatureError::OwnSignature { status })?;
    let mut on_disk: *const SecStaticCode = std::ptr::null();
    // SAFETY: `on_disk` is a live pointer the call fills with a new reference to the code on disk.
    let status =
        unsafe { own.copy_static_code(SecCSFlags::DefaultFlags, NonNull::from(&mut on_disk)) };
    let on_disk = owned(status, on_disk.cast_mut())
        .map_err(|status| CodeSignatureError::OwnSignature { status })?;
    let mut information: *const CFDictionary = std::ptr::null();
    // SAFETY: `information` is a live pointer the call fills with a new dictionary it owns; the
    // signing-information flag makes it hold the signature's team.
    let status = unsafe {
        SecCode::copy_signing_information(
            &on_disk,
            SecCSFlags(kSecCSSigningInformation),
            NonNull::from(&mut information),
        )
    };
    let information = owned(status, information.cast_mut())
        .map_err(|status| CodeSignatureError::OwnSignature { status })?;
    // SAFETY: the signing information's keys are strings and its values CoreFoundation objects.
    let information =
        unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(information) };
    // SAFETY: the key is the Security framework's own constant.
    let team_key = unsafe { kSecCodeInfoTeamIdentifier };
    Ok(information
        .get(team_key)
        .and_then(|team| team.downcast::<CFString>().ok())
        .map(|team| team.to_string()))
}

/// The object a Security framework call created, once its `status` says it succeeded; the status
/// otherwise.
fn owned<T: objc2_core_foundation::Type>(
    status: i32,
    object: *mut T,
) -> Result<CFRetained<T>, i32> {
    if status != 0 {
        return Err(status);
    }
    let object = NonNull::new(object).ok_or(status)?;
    // SAFETY: the call succeeded and handed over one reference to the object.
    Ok(unsafe { CFRetained::from_raw(object) })
}

/// Whether `process` runs a program that meets `requirement`: a peer is looked up by its
/// connection's audit token, which fails once the process ran another program; any other process
/// by its id, taken only once the process is read still running afterward. Fails with
/// `InvalidInput` only for a process with no audit token whose id is 0 or past `i32::MAX`, else
/// only when the system cannot check.
fn meets(process: &PinnedProcess, requirement: &Requirement) -> io::Result<SignatureCheck> {
    let attributes = if let Some(token) = process.audit_token() {
        let token = CFData::from_bytes(&token.to_bytes());
        // SAFETY: the key is the Security framework's own constant.
        let key = unsafe { kSecGuestAttributeAudit };
        CFDictionary::<CFString, CFType>::from_slices(&[key], &[token.as_ref()])
    } else {
        let pid = CFNumber::new_i32(system_process_id(process.id())?.get());
        // SAFETY: the key is the Security framework's own constant.
        let key = unsafe { kSecGuestAttributePid };
        CFDictionary::<CFString, CFType>::from_slices(&[key], &[pid.as_ref()])
    };
    let mut code: *mut SecCode = std::ptr::null_mut();
    // SAFETY: the attributes are a dictionary of the keys and value types the call reads, and
    // `code` is a live pointer the call fills with a new reference to the process's code.
    let status = unsafe {
        SecCode::copy_guest_with_attributes(
            None,
            Some(attributes.as_opaque()),
            SecCSFlags::DefaultFlags,
            NonNull::from(&mut code),
        )
    };
    let code = match owned(status, code) {
        Ok(code) => code,
        Err(status) => return refusal(status),
    };
    // SAFETY: `code` and the requirement are live objects the call only reads.
    let status = unsafe { code.check_validity(SecCSFlags::DefaultFlags, Some(&requirement.0)) };
    if status != 0 {
        return refusal(status);
    }
    if process.audit_token().is_none() && !is_running(process)? {
        return Ok(SignatureCheck::NotMet {
            status: NO_SUCH_PROCESS_STATUS,
        });
    }
    Ok(SignatureCheck::Met)
}

/// What a failed lookup or check means: a code-signing status, or the kernel's "no such process",
/// says the program is not the client; any other status is a failure to check.
fn refusal(status: i32) -> io::Result<SignatureCheck> {
    if (errSecCSUnimplemented..=errSecCSRemoteSignerFailed).contains(&status)
        || status == NO_SUCH_PROCESS_STATUS
    {
        return Ok(SignatureCheck::NotMet { status });
    }
    Err(io::Error::other(format!(
        "the Security framework could not check a process's signature (status {status})"
    )))
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use interprocess::local_socket::tokio::Stream;
    use interprocess::os::unix::uds_local_socket::tokio::Stream as UnixSocketStream;

    use super::{DesktopClientRequirement, compile, signed_by_team};
    use crate::code_signature::{CodeSignatureError, SignatureCheck};
    use crate::macos::caller_process::read_peer_process;
    use crate::macos::pinned_process::pin_running_process;

    /// The requirement `nc` meets as the helper and `sleep` as the app: two programs the system
    /// signs.
    const NC_REQUIREMENT: &str = "anchor apple and identifier \"com.apple.nc\"";
    const SLEEP_REQUIREMENT: &str = "anchor apple and identifier \"com.apple.sleep\"";

    #[test]
    fn a_requirement_that_does_not_compile_fails_and_an_unsigned_build_builds_none() {
        assert!(matches!(
            DesktopClientRequirement::from_requirement_text(
                "anchor apple and (",
                SLEEP_REQUIREMENT
            ),
            Err(CodeSignatureError::Compile { .. })
        ));
        // The test program is signed ad hoc, with no team, so it admits no client by signature.
        assert!(
            DesktopClientRequirement::for_this_program("io.example.app")
                .expect("this program's signature reads")
                .is_none()
        );
    }

    #[test]
    fn the_requirements_a_team_signed_build_makes_compile() {
        for identifier in ["io.example.app", "io.example.app.helper"] {
            assert!(
                compile(&signed_by_team(identifier, "ABCDE12345")).is_ok(),
                "{identifier}'s requirement compiles"
            );
        }
    }

    #[test]
    fn admits_only_a_signed_helper_whose_responsible_process_is_the_signed_app() {
        let requirement =
            DesktopClientRequirement::from_requirement_text(NC_REQUIREMENT, SLEEP_REQUIREMENT)
                .expect("the requirements compile");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .expect("a runtime");
        let _entered = runtime.enter();
        let folder = tempfile::tempdir().expect("a folder");
        let path = folder.path().join("client.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("the socket binds");
        let mut nc = std::process::Command::new("/usr/bin/nc")
            .arg("-U")
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("nc starts");
        let (accepted, _) = listener.accept().expect("nc connects");
        accepted
            .set_nonblocking(true)
            .expect("the socket turns non-blocking");
        let stream = Stream::from(UnixSocketStream::from(
            tokio::net::UnixStream::from_std(accepted).expect("tokio takes the socket"),
        ));
        let caller = read_peer_process(&stream)
            .expect("the peer reads")
            .expect("nc runs");
        let mut sleep = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("sleep starts");
        let app = pin_running_process(sleep.id())
            .expect("sleep reads")
            .expect("sleep runs");
        let unsigned = pin_running_process(std::process::id())
            .expect("the test reads")
            .expect("the test runs");

        assert_eq!(
            requirement.check(&caller, &app).expect("the check answers"),
            SignatureCheck::Met
        );
        // The test program is signed ad hoc, so it meets neither requirement.
        assert!(matches!(
            requirement
                .check(&caller, &unsigned)
                .expect("the check answers"),
            SignatureCheck::NotMet { .. }
        ));
        assert!(matches!(
            requirement
                .check(&unsigned, &app)
                .expect("the check answers"),
            SignatureCheck::NotMet { .. }
        ));
        // A program meeting the other's requirement meets neither.
        assert!(matches!(
            requirement.check(&app, &caller).expect("the check answers"),
            SignatureCheck::NotMet { .. }
        ));

        // Once the helper and the app have ended, neither is the client, and neither is an error.
        nc.kill().expect("nc ends");
        nc.wait().expect("nc is reaped");
        sleep.kill().expect("sleep ends");
        sleep.wait().expect("sleep is reaped");
        assert!(matches!(
            requirement.check(&caller, &app).expect("the check answers"),
            SignatureCheck::NotMet { .. }
        ));
    }
}
