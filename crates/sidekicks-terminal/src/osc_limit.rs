//! The cut on an operating system command's payload: the screen copy's parser and an output
//! filter both keep a command's payload whole until it ends, so a program that opens one and never
//! ends it would grow them without bound.

/// The most payload bytes one operating system command carries before it is cut.
const OSC_PAYLOAD_LIMIT_BYTES: usize = 10_000_000;

const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1A;
const ESC: u8 = 0x1B;
/// `]`, which after `ESC` opens an operating system command.
const OSC_OPENER: u8 = 0x5D;
/// `;`, which separates the command's parameters and is kept out of its payload.
const PARAMETER_SEPARATOR: u8 = 0x3B;

/// Where the scan stands in the output, following the parser's own steps into and out of a
/// command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OscScan {
    /// Outside any command.
    Outside,
    /// After an `ESC`, where `]` opens a command.
    Escape,
    /// Inside a command, with the payload bytes it holds so far.
    Payload(usize),
    /// Past a cut command, dropping its rest until it ends.
    Dropping,
}

/// What the scan does with one byte.
enum OscStep {
    Keep,
    /// Ends the command with `BEL` in place of this byte, which is dropped.
    Cut,
    Drop,
}

/// Cuts each operating system command in a shell's output at [`OSC_PAYLOAD_LIMIT_BYTES`]: past
/// it, the command is ended with `BEL` and its rest dropped up to its own end, across reads.
pub(crate) struct OscPayloadLimit {
    scan: OscScan,
}

impl OscPayloadLimit {
    /// A limit for output that starts outside any command.
    pub(crate) fn new() -> Self {
        Self {
            scan: OscScan::Outside,
        }
    }

    /// The bytes of `chunk` the limit lets through: `chunk` itself unless a command in it is cut,
    /// otherwise what is kept, written into `cut`.
    pub(crate) fn limit<'a>(&mut self, chunk: &'a [u8], cut: &'a mut Vec<u8>) -> &'a [u8] {
        let mut is_cutting = false;
        for (index, &byte) in chunk.iter().enumerate() {
            let step = self.step(byte);
            if !is_cutting && !matches!(step, OscStep::Keep) {
                is_cutting = true;
                cut.clear();
                cut.extend_from_slice(&chunk[..index]);
            }
            match step {
                OscStep::Keep if is_cutting => cut.push(byte),
                OscStep::Cut => cut.push(BEL),
                OscStep::Keep | OscStep::Drop => {}
            }
        }
        if is_cutting { cut } else { chunk }
    }

    fn step(&mut self, byte: u8) -> OscStep {
        let (scan, step) = match (self.scan, byte) {
            (OscScan::Dropping, BEL | CAN | SUB) => (OscScan::Outside, OscStep::Drop),
            (OscScan::Dropping, ESC) => (OscScan::Escape, OscStep::Keep),
            (OscScan::Dropping, _) => (OscScan::Dropping, OscStep::Drop),
            (_, ESC) => (OscScan::Escape, OscStep::Keep),
            (OscScan::Escape, OSC_OPENER) => (OscScan::Payload(0), OscStep::Keep),
            // A control or a high byte leaves the parser waiting after the `ESC`.
            (OscScan::Escape, 0x00..=0x17 | 0x19 | 0x1C..=0x1F | 0x7F..) => {
                (OscScan::Escape, OscStep::Keep)
            }
            (OscScan::Payload(_), BEL | CAN | SUB) | (OscScan::Escape | OscScan::Outside, _) => {
                (OscScan::Outside, OscStep::Keep)
            }
            // The parser ignores these controls inside a command and keeps the separator apart.
            (
                OscScan::Payload(held),
                0x00..=0x06 | 0x08..=0x17 | 0x19 | 0x1C..=0x1F | PARAMETER_SEPARATOR,
            ) => (OscScan::Payload(held), OscStep::Keep),
            (OscScan::Payload(held), _) if held < OSC_PAYLOAD_LIMIT_BYTES => {
                (OscScan::Payload(held + 1), OscStep::Keep)
            }
            (OscScan::Payload(_), _) => (OscScan::Dropping, OscStep::Cut),
        };
        self.scan = scan;
        step
    }
}

#[cfg(test)]
mod tests {
    use super::{OSC_PAYLOAD_LIMIT_BYTES, OscPayloadLimit};

    /// Passes `output` through a fresh limit in reads of `read_bytes`.
    fn limit_in_reads(output: &[u8], read_bytes: usize) -> Vec<u8> {
        let mut limit = OscPayloadLimit::new();
        let mut cut = Vec::new();
        let mut kept = Vec::new();
        for read in output.chunks(read_bytes) {
            kept.extend_from_slice(limit.limit(read, &mut cut));
        }
        kept
    }

    #[test]
    fn a_command_past_the_limit_is_cut_and_its_rest_dropped_across_reads() {
        let mut output = b"\x1b]0;".to_vec();
        output.resize(output.len() + OSC_PAYLOAD_LIMIT_BYTES + 5_000, b'a');
        output.extend_from_slice(b"\x07after\x1b]2;title\x07");

        let mut expected = b"\x1b]0;".to_vec();
        // The `0` counts toward the payload; the separator does not.
        expected.resize(expected.len() + OSC_PAYLOAD_LIMIT_BYTES - 1, b'a');
        expected.extend_from_slice(b"\x07after\x1b]2;title\x07");
        assert_eq!(limit_in_reads(&output, 64 * 1024), expected);

        // A command at the limit, and output with no command, pass untouched and uncopied.
        let mut at_limit = b"\x1b]".to_vec();
        at_limit.resize(at_limit.len() + OSC_PAYLOAD_LIMIT_BYTES, b'a');
        at_limit.push(0x07);
        assert_eq!(limit_in_reads(&at_limit, 64 * 1024), at_limit);
        let plain = b"plain \x1b[1moutput\x1b[0m";
        let mut cut = Vec::new();
        assert!(std::ptr::eq(
            OscPayloadLimit::new().limit(plain, &mut cut),
            plain.as_slice()
        ));
    }

    #[test]
    fn a_cut_command_ending_in_an_escape_keeps_the_sequence_after_it() {
        let mut output = b"\x1b]".to_vec();
        output.resize(output.len() + OSC_PAYLOAD_LIMIT_BYTES + 1, b'a');
        output.extend_from_slice(b"\x1b\\\x1b[31mred");

        let mut expected = b"\x1b]".to_vec();
        expected.resize(expected.len() + OSC_PAYLOAD_LIMIT_BYTES, b'a');
        expected.extend_from_slice(b"\x07\x1b\\\x1b[31mred");
        assert_eq!(limit_in_reads(&output, 4096), expected);
    }
}
