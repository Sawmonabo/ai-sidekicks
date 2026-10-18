//! The machine's installed memory, which every system reports the same way.

use sysinfo::{MemoryRefreshKind, RefreshKind, System};

/// The machine's installed memory in bytes, read from the system on each call, so a caller reads
/// it once at its start. Answers 0 when the system reports none.
pub fn physical_memory() -> u64 {
    System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
    )
    .total_memory()
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use crate::read_process_peak_bytes;

    // A program that starts and ends at once.
    #[cfg(unix)]
    const SHORT_PROGRAM: (&str, &[&str]) = ("/usr/bin/true", &[]);
    #[cfg(windows)]
    const SHORT_PROGRAM: (&str, &[&str]) = ("cmd.exe", &["/c", "exit"]);

    #[test]
    fn a_live_process_has_a_peak_and_a_reaped_one_has_none() {
        let own_peak = read_process_peak_bytes(std::process::id()).expect("the own peak reads");
        assert!(own_peak.is_some_and(|bytes| bytes > 0));

        let (program, arguments) = SHORT_PROGRAM;
        let mut child = Command::new(program)
            .args(arguments)
            .spawn()
            .expect("the program starts");
        let child_id = child.id();
        child.wait().expect("the child is reaped");
        // Dropped so Windows closes the last handle and the process object goes.
        drop(child);

        let reaped_peak = read_process_peak_bytes(child_id).expect("a reaped child reads as none");
        assert_eq!(reaped_peak, None);
    }
}
