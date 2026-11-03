//! A file tool's text claim checked against the file on disk, and rebuilt in the disk's form.
//!
//! - A file tool reads a file as UTF-16LE when it starts with FF FE and as UTF-8 otherwise, and
//!   hands back its text with every CRLF pair as LF, so the disk is decoded and normalized the
//!   same way before it is compared, a leading byte-order mark dropped on both sides.
//! - The file's size is checked against every size the claim could encode to before any byte is
//!   read, and the compare reads 64 KiB at a time, stopping at the first chunk that differs, so it
//!   holds at most one chunk beside the claim.

use std::fs::File;
use std::io::{self, Read, Seek as _, SeekFrom};
use std::path::Path;

use sidekicks_std::missing_entry::is_missing_entry;

// How much of a file one read of a tool's claim takes.
const CLAIM_READ_CHUNK_BYTES: usize = 64 * 1024;

/// The byte-order mark of a UTF-8 file.
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// The byte-order mark of a UTF-16LE file.
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];

/// How many leading characters decide a file's line endings, as the file tool counts them.
const LINE_ENDING_SAMPLE_CHARS: usize = 4096;

const CARRIAGE_RETURN: u16 = 0x0D;
const LINE_FEED: u16 = 0x0A;

/// The two encodings a file tool reads a file in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TextEncoding {
    Utf8,
    Utf16Le,
}

impl TextEncoding {
    // The encoding a file starting with `leading` is read in, with its mark's length.
    fn of_leading(leading: &[u8]) -> (Self, usize) {
        if leading.starts_with(UTF16LE_BOM) {
            (Self::Utf16Le, UTF16LE_BOM.len())
        } else if leading.starts_with(UTF8_BOM) {
            (Self::Utf8, UTF8_BOM.len())
        } else {
            (Self::Utf8, 0)
        }
    }

    fn bom(self) -> &'static [u8] {
        match self {
            Self::Utf8 => UTF8_BOM,
            Self::Utf16Le => UTF16LE_BOM,
        }
    }
}

/// How a file on disk spells its text: its encoding, whether it starts with a byte-order mark,
/// and whether its lines end in CRLF.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TextForm {
    encoding: TextEncoding,
    has_bom: bool,
    is_crlf: bool,
}

/// Whether a claim's text is the file's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClaimCheck {
    /// Decoded and normalized, the file holds exactly the claim.
    Equal,
    /// The file's size or text is not the claim's.
    Differs,
}

/// What a claim keeps as its path's next version.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ClaimedVersion {
    /// The file on disk holds the claim: its bytes are the version.
    Disk,
    /// The claim's text spelled in the disk file's form.
    Rebuilt(Vec<u8>),
    /// No version: the file is gone, is in neither encoding, or differs unexplained.
    Nothing,
}

/// The version `claim` keeps of the file at `path`: the disk's bytes when they hold it, else, when
/// `is_explained` says a later call explains the difference, the claim rebuilt in the disk's form.
/// Fails as the file's read fails.
pub(super) fn claimed_version(
    claim: &str,
    path: &Path,
    is_explained: bool,
) -> io::Result<ClaimedVersion> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if is_missing_entry(&error) => return Ok(ClaimedVersion::Nothing),
        Err(error) => return Err(error),
    };
    let file_size = file.metadata()?.len();
    if check_claim(claim, &file, file_size)? == ClaimCheck::Equal {
        return Ok(ClaimedVersion::Disk);
    }
    if !is_explained {
        return Ok(ClaimedVersion::Nothing);
    }
    (&file).seek(SeekFrom::Start(0))?;
    Ok(
        read_text_form(&file)?.map_or(ClaimedVersion::Nothing, |form| {
            ClaimedVersion::Rebuilt(rebuild_claim(claim, form))
        }),
    )
}

/// Compares `claim` with `file`, `file_size` bytes long: nothing is read when no spelling of the
/// claim has that size, and the read stops at the first 64 KiB chunk that differs.
pub(super) fn check_claim(
    claim: &str,
    mut file: impl Read,
    file_size: u64,
) -> io::Result<ClaimCheck> {
    let claim = without_bom(claim);
    let sizes = ClaimSizes::of(claim);
    let spellings = [
        (TextEncoding::Utf8, 0),
        (TextEncoding::Utf8, UTF8_BOM.len()),
        (TextEncoding::Utf16Le, UTF16LE_BOM.len()),
    ];
    if !spellings
        .into_iter()
        .any(|(encoding, bom_len)| sizes.admits(encoding, bom_len, file_size))
    {
        return Ok(ClaimCheck::Differs);
    }
    let mut chunk = vec![0; CLAIM_READ_CHUNK_BYTES];
    let mut read = fill_chunk(&mut file, &mut chunk)?;
    let (encoding, bom_len) = TextEncoding::of_leading(&chunk[..read]);
    if !sizes.admits(encoding, bom_len, file_size) {
        return Ok(ClaimCheck::Differs);
    }
    let mut compare = UnitCompare::new(claim, encoding);
    let mut start = bom_len;
    loop {
        if !compare.feed(&chunk[start..read]) {
            return Ok(ClaimCheck::Differs);
        }
        if read < chunk.len() {
            break;
        }
        read = fill_chunk(&mut file, &mut chunk)?;
        start = 0;
        if read == 0 {
            break;
        }
    }
    Ok(if compare.finish() {
        ClaimCheck::Equal
    } else {
        ClaimCheck::Differs
    })
}

/// The form of `file` from its first 64 KiB: its mark, its encoding and the line endings its
/// first 4096 characters favor, CRLF when its CRLF pairs outnumber its lone LFs; none when that
/// chunk is in neither encoding.
pub(super) fn read_text_form(mut file: impl Read) -> io::Result<Option<TextForm>> {
    let mut chunk = vec![0; CLAIM_READ_CHUNK_BYTES];
    let read = fill_chunk(&mut file, &mut chunk)?;
    let is_whole_file = read < chunk.len();
    let (encoding, bom_len) = TextEncoding::of_leading(&chunk[..read]);
    let text = &chunk[bom_len..read];
    let is_crlf = match encoding {
        TextEncoding::Utf8 => {
            let valid = match std::str::from_utf8(text) {
                Ok(valid) => valid,
                // A character the chunk cut is finished past it.
                Err(error) if error.error_len().is_none() && !is_whole_file => {
                    std::str::from_utf8(&text[..error.valid_up_to()])
                        .expect("the bytes before the first error are UTF-8")
                }
                Err(_) => return Ok(None),
            };
            favors_crlf(valid.chars().map(Some))
        }
        TextEncoding::Utf16Le => {
            if is_whole_file && text.len() % 2 == 1 {
                return Ok(None);
            }
            let mut pairs = text.as_chunks::<2>().0;
            // A surrogate pair the chunk cut is finished past it.
            if !is_whole_file
                && let Some((last, before)) = pairs.split_last()
                && (0xD800..0xDC00).contains(&u16::from_le_bytes(*last))
            {
                pairs = before;
            }
            let units = pairs.iter().map(|pair| u16::from_le_bytes(*pair));
            favors_crlf(char::decode_utf16(units).map(Result::ok))
        }
    };
    Ok(is_crlf.map(|is_crlf| TextForm {
        encoding,
        has_bom: bom_len > 0,
        is_crlf,
    }))
}

/// `claim`'s text spelled in `form`: its line endings, encoding and byte-order mark.
pub(super) fn rebuild_claim(claim: &str, form: TextForm) -> Vec<u8> {
    let claim = without_bom(claim);
    let line_ending = if form.is_crlf { "\r\n" } else { "\n" };
    let mut bytes = Vec::with_capacity(claim.len() + UTF8_BOM.len());
    if form.has_bom {
        bytes.extend_from_slice(form.encoding.bom());
    }
    for (index, line) in claim.split('\n').enumerate() {
        if index > 0 {
            push_encoded(&mut bytes, line_ending, form.encoding);
        }
        push_encoded(&mut bytes, line, form.encoding);
    }
    bytes
}

fn push_encoded(bytes: &mut Vec<u8>, text: &str, encoding: TextEncoding) {
    match encoding {
        TextEncoding::Utf8 => bytes.extend_from_slice(text.as_bytes()),
        TextEncoding::Utf16Le => {
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
        }
    }
}

fn without_bom(claim: &str) -> &str {
    claim.strip_prefix('\u{FEFF}').unwrap_or(claim)
}

// Whether the first 4096 characters hold more CRLF pairs than lone LFs; none when any character
// fails to decode.
fn favors_crlf(characters: impl Iterator<Item = Option<char>>) -> Option<bool> {
    let (mut crlf_pairs, mut lone_line_feeds) = (0_usize, 0_usize);
    let mut is_after_carriage_return = false;
    for (index, character) in characters.enumerate() {
        let character = character?;
        if index < LINE_ENDING_SAMPLE_CHARS && character == '\n' {
            if is_after_carriage_return {
                crlf_pairs += 1;
            } else {
                lone_line_feeds += 1;
            }
        }
        is_after_carriage_return = character == '\r';
    }
    Some(crlf_pairs > lone_line_feeds)
}

// Reads into `chunk` until it is full or the file ends, returning how much it read.
fn fill_chunk(file: &mut impl Read, chunk: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < chunk.len() {
        match file.read(&mut chunk[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

/// The lengths a claim's spellings are built from: its UTF-8 bytes, its UTF-16 units and its LFs,
/// each of which a CRLF file spells one unit longer.
struct ClaimSizes {
    utf8_bytes: u64,
    utf16_units: u64,
    line_feeds: u64,
}

impl ClaimSizes {
    fn of(claim: &str) -> Self {
        let count = |length: usize| u64::try_from(length).expect("a length fits a u64");
        Self {
            utf8_bytes: count(claim.len()),
            utf16_units: count(claim.encode_utf16().count()),
            line_feeds: count(claim.bytes().filter(|&byte| byte == b'\n').count()),
        }
    }

    // Whether a file of `file_size` bytes could spell the claim in `encoding` after a mark of
    // `bom_len` bytes, its line endings anywhere from all LF to all CRLF.
    fn admits(&self, encoding: TextEncoding, bom_len: usize, file_size: u64) -> bool {
        let (text_bytes, unit_bytes) = match encoding {
            TextEncoding::Utf8 => (self.utf8_bytes, 1),
            TextEncoding::Utf16Le => (self.utf16_units * 2, 2),
        };
        let shortest = text_bytes + u64::try_from(bom_len).expect("a mark's length fits a u64");
        (shortest..=shortest + self.line_feeds * unit_bytes).contains(&file_size)
    }
}

/// The claim's code units, read as the disk's are compared.
enum ClaimUnits<'claim> {
    Utf8(std::str::Bytes<'claim>),
    Utf16Le(std::str::EncodeUtf16<'claim>),
}

impl Iterator for ClaimUnits<'_> {
    type Item = u16;

    fn next(&mut self) -> Option<u16> {
        match self {
            Self::Utf8(bytes) => bytes.next().map(u16::from),
            Self::Utf16Le(units) => units.next(),
        }
    }
}

/// The disk's code units compared with the claim's as they are read, each CRLF pair taken as LF;
/// a CR or an odd byte at a chunk's end waits for the next chunk.
struct UnitCompare<'claim> {
    claim: ClaimUnits<'claim>,
    encoding: TextEncoding,
    is_carriage_return_held: bool,
    held_byte: Option<u8>,
}

impl<'claim> UnitCompare<'claim> {
    fn new(claim: &'claim str, encoding: TextEncoding) -> Self {
        let claim = match encoding {
            TextEncoding::Utf8 => ClaimUnits::Utf8(claim.bytes()),
            TextEncoding::Utf16Le => ClaimUnits::Utf16Le(claim.encode_utf16()),
        };
        Self {
            claim,
            encoding,
            is_carriage_return_held: false,
            held_byte: None,
        }
    }

    // Compares the next bytes of the disk; false at the first unit that differs.
    fn feed(&mut self, mut bytes: &[u8]) -> bool {
        match self.encoding {
            TextEncoding::Utf8 => bytes.iter().all(|&byte| self.take(u16::from(byte))),
            TextEncoding::Utf16Le => {
                if let Some(low) = self.held_byte.take() {
                    let Some((&high, rest)) = bytes.split_first() else {
                        self.held_byte = Some(low);
                        return true;
                    };
                    if !self.take(u16::from_le_bytes([low, high])) {
                        return false;
                    }
                    bytes = rest;
                }
                let (pairs, remainder) = bytes.as_chunks::<2>();
                if !pairs
                    .iter()
                    .all(|pair| self.take(u16::from_le_bytes(*pair)))
                {
                    return false;
                }
                if let [last] = remainder {
                    self.held_byte = Some(*last);
                }
                true
            }
        }
    }

    // Whether the disk ended where the claim does.
    fn finish(mut self) -> bool {
        if self.held_byte.is_some() {
            return false;
        }
        if self.is_carriage_return_held && !self.expect(CARRIAGE_RETURN) {
            return false;
        }
        self.claim.next().is_none()
    }

    fn take(&mut self, unit: u16) -> bool {
        if self.is_carriage_return_held {
            self.is_carriage_return_held = false;
            if unit == LINE_FEED {
                return self.expect(LINE_FEED);
            }
            if !self.expect(CARRIAGE_RETURN) {
                return false;
            }
        }
        if unit == CARRIAGE_RETURN {
            self.is_carriage_return_held = true;
            return true;
        }
        self.expect(unit)
    }

    fn expect(&mut self, unit: u16) -> bool {
        self.claim.next() == Some(unit)
    }
}

#[cfg(test)]
mod tests;
