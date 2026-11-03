use std::io::{self, Read};

use rstest::rstest;

use super::{CLAIM_READ_CHUNK_BYTES, ClaimCheck, check_claim, read_text_form, rebuild_claim};

/// Reads `bytes`, counting how many it handed out.
struct CountingReader<'bytes> {
    bytes: &'bytes [u8],
    handed_out: usize,
}

impl Read for CountingReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.bytes.read(buffer)?;
        self.handed_out += read;
        Ok(read)
    }
}

fn utf16le_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn utf8_with_bom(text: &str) -> Vec<u8> {
    [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat()
}

/// A claim verifies equal to the disk whatever its endings, encoding and mark, and rebuilt in the
/// form read from the disk it is the disk's bytes; killed by taking the claim's own bytes, by
/// dropping the mark on one side only, and by comparing endings unnormalized.
#[rstest]
#[case::edit_of_a_crlf_file(b"one\r\ntwo\r\n".to_vec(), "one\ntwo\n", true)]
#[case::edit_of_a_mixed_ending_file(b"one\r\ntwo\nthree\r\n".to_vec(), "one\ntwo\nthree\n", false)]
#[case::edit_of_a_utf16le_file(
    utf16le_with_bom("caf\u{e9}\r\n\u{1F600}\r\n"),
    "\u{FEFF}caf\u{e9}\n\u{1F600}\n",
    true
)]
#[case::write_over_a_utf16le_file(
    utf16le_with_bom("caf\u{e9}\r\n\u{1F600}\r\n"),
    "caf\u{e9}\n\u{1F600}\n",
    true
)]
#[case::edit_of_a_utf8_file_keeping_its_mark(
    utf8_with_bom("caf\u{e9}\n"),
    "\u{FEFF}caf\u{e9}\n",
    true
)]
#[case::edit_of_a_utf8_file_dropping_its_mark(utf8_with_bom("caf\u{e9}\n"), "caf\u{e9}\n", true)]
fn a_claim_verifies_equal_and_rebuilds_the_disk_bytes(
    #[case] disk: Vec<u8>,
    #[case] claim: &str,
    #[case] is_rebuilt_exactly: bool,
) {
    let size = u64::try_from(disk.len()).expect("a test file's length fits a u64");

    let check = check_claim(claim, disk.as_slice(), size).expect("a slice reads");

    assert_eq!(check, ClaimCheck::Equal);
    if is_rebuilt_exactly {
        let form = read_text_form(disk.as_slice())
            .expect("a slice reads")
            .expect("the file is in a known encoding");
        assert_eq!(rebuild_claim(claim, form), disk);
    }
}

/// A claim that is not the disk's text is refused, a file of another size without a byte read
/// and one of the same size only to the first chunk that differs; killed by reading the whole
/// file for a compare or skipping the size check.
#[test]
fn a_differing_claim_is_refused_reading_no_further_than_its_first_differing_chunk() {
    let disk = "a".repeat(CLAIM_READ_CHUNK_BYTES * 3);
    let mut claim = disk.clone();
    claim.replace_range(
        CLAIM_READ_CHUNK_BYTES + 10..CLAIM_READ_CHUNK_BYTES + 11,
        "b",
    );
    let size = u64::try_from(disk.len()).expect("a test file's length fits a u64");
    let mut same_size = CountingReader {
        bytes: disk.as_bytes(),
        handed_out: 0,
    };
    let mut other_size = CountingReader {
        bytes: disk.as_bytes(),
        handed_out: 0,
    };

    let same_size_check = check_claim(&claim, &mut same_size, size).expect("a slice reads");
    let other_size_check = check_claim(&claim[1..], &mut other_size, size).expect("a slice reads");

    assert_eq!(same_size_check, ClaimCheck::Differs);
    assert_eq!(same_size.handed_out, CLAIM_READ_CHUNK_BYTES * 2);
    assert_eq!(other_size_check, ClaimCheck::Differs);
    assert_eq!(other_size.handed_out, 0);
}
