//! What a process started with, its arguments and its environment, as macOS shows them through
//! one `KERN_PROCARGS2` read.

use std::io;
use std::ptr;
use std::sync::OnceLock;

use crate::posix::process::id::system_process_id;
use crate::process_start::ProcessStart;

// The bytes of the argument count that opens a `KERN_PROCARGS2` answer.
const ARGUMENT_COUNT_BYTES: usize = size_of::<libc::c_int>();

// The boundary the kernel pads the executable's path to before the arguments: a pointer of a
// 64-bit process, which is every process this macOS runs.
const STRING_AREA_ALIGNMENT: usize = size_of::<u64>();

// The most bytes a process's arguments and environment take together (`KERN_ARGMAX`), read once.
static ARGUMENT_BYTES: OnceLock<usize> = OnceLock::new();

/// The arguments and environment process `process_id` started with, bytes that are not UTF-8 read
/// lossily; `None` when the system refuses the process (it ended, or another user runs it). Its
/// own programs show their arguments and no environment. Blocks on the read; fails with the
/// system's error on any other refusal.
pub fn read_process_start(process_id: u32) -> io::Result<Option<ProcessStart>> {
    let Ok(pid) = system_process_id(process_id) else {
        return Ok(None);
    };
    let argument_bytes = if let Some(bytes) = ARGUMENT_BYTES.get() {
        *bytes
    } else {
        let bytes = read_argument_bytes()?;
        *ARGUMENT_BYTES.get_or_init(|| bytes)
    };
    // Allocated per read and freed after it, so no buffer the size of the limit stays held.
    let mut buffer = vec![0_u8; argument_bytes];
    let mut length = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid.get()];
    // SAFETY: `name` holds three integers, the buffer is live and `length` long, and nothing else
    // reads either until the call returns.
    let status = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &raw mut length,
            ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        // A process that ended or that the system hides from this user is refused as invalid.
        return match error.raw_os_error() {
            Some(libc::EINVAL | libc::EPERM | libc::ESRCH) => Ok(None),
            _ => Err(error),
        };
    }
    buffer.truncate(length);
    process_start_in(&buffer).map(Some).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("process {process_id}'s start was cut short"),
        )
    })
}

/// The environment process `process_id` started with, one `NAME=value` entry each, bytes that are
/// not UTF-8 read lossily; `None` when the system refuses the process (it ended, or another user
/// runs it) or shows no environment, as it shows none for its own programs. Blocks on the read;
/// fails with the system's error on any other refusal.
pub fn read_process_environment(process_id: u32) -> io::Result<Option<Vec<String>>> {
    Ok(read_process_start(process_id)?
        .map(|start| start.environment)
        .filter(|environment| !environment.is_empty()))
}

// `KERN_ARGMAX`: the most bytes a process's arguments and environment take together.
fn read_argument_bytes() -> io::Result<usize> {
    let mut argument_bytes: libc::c_int = 0;
    let mut length = size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `name` holds two integers, the answer is one live `c_int` of `length` bytes, and
    // nothing else reads either until the call returns.
    let status = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut argument_bytes).cast(),
            &raw mut length,
            ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    usize::try_from(argument_bytes).map_err(io::Error::other)
}

// A `KERN_PROCARGS2` answer is the argument count, then the executable's path, zero bytes that
// pad the strings to the next pointer boundary from their start, each argument and each environment
// entry, each ended by a zero byte, and the environment by an empty entry; `None` when the answer
// is cut short before its last argument. Only the padding is skipped, so an empty first argument
// is still counted.
fn process_start_in(answer: &[u8]) -> Option<ProcessStart> {
    let (count_bytes, strings) = answer.split_at_checked(ARGUMENT_COUNT_BYTES)?;
    let argument_count = libc::c_int::from_ne_bytes(count_bytes.try_into().ok()?);
    let argument_count = usize::try_from(argument_count).ok()?;
    let path_end = strings.iter().position(|byte| *byte == 0)?;
    let arguments_start = (path_end + 1).next_multiple_of(STRING_AREA_ALIGNMENT);
    let mut entries = strings
        .get(arguments_start..)?
        .split(|byte| *byte == 0)
        .map(|entry| String::from_utf8_lossy(entry).into_owned());
    let arguments: Vec<String> = entries.by_ref().take(argument_count).collect();
    if arguments.len() < argument_count {
        return None;
    }
    let environment = entries.take_while(|entry| !entry.is_empty()).collect();
    Some(ProcessStart {
        arguments,
        environment,
    })
}

#[cfg(test)]
mod tests {
    use super::process_start_in;
    use crate::process_start::ProcessStart;

    // Fails when the padding after the executable's path is skipped as a run of empty entries,
    // which also skips an empty first argument and then reads one argument as the environment.
    #[test]
    fn process_start_counts_an_empty_first_argument_after_the_path_s_padding() {
        let answer = |path: &[u8]| -> Vec<u8> {
            let mut answer = 2_i32.to_ne_bytes().to_vec();
            answer.extend_from_slice(path);
            answer.push(0);
            answer.resize((answer.len() - 4).next_multiple_of(8) + 4, 0);
            answer.extend_from_slice(b"\0second\0A=1\0B=2\0\0apple=x\0");
            answer
        };
        let expected = Some(ProcessStart {
            arguments: vec![String::new(), "second".to_owned()],
            environment: vec!["A=1".to_owned(), "B=2".to_owned()],
        });

        // A path whose end falls between boundaries, and one whose end falls on one.
        assert_eq!(process_start_in(&answer(b"/bin/a")), expected);
        assert_eq!(process_start_in(&answer(b"/bin/ab")), expected);
    }
}
