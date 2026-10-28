//! A payload's format read from its leading bytes: a pure function over at most
//! [`DETECTION_PREFIX_BYTES`], so its time is bounded by the slice it reads and it needs no
//! thread, queue or time limit of its own. Its answer decides only what a manifest records and
//! whether a file offered as a picture goes to a provider as one; nothing is refused on it.

use file_format::FileFormat;

/// How many leading bytes the detection reads: most signatures sit within them, and nothing past
/// them is read, so no archive's interior ever is.
pub(crate) const DETECTION_PREFIX_BYTES: usize = 4100;

/// The format `leading_bytes` names, or `None` when they are empty or name none, so the caller
/// reads them as text or as an unknown binary. Reads only the first [`DETECTION_PREFIX_BYTES`].
pub(crate) fn detect_media_type(leading_bytes: &[u8]) -> Option<FileFormat> {
    let prefix = leading_bytes
        .get(..DETECTION_PREFIX_BYTES)
        .unwrap_or(leading_bytes);
    let format = FileFormat::from_bytes(prefix);
    if format == FileFormat::Empty || format == FileFormat::ArbitraryBinaryData {
        None
    } else if format == FileFormat::Id3v2 {
        // An ID3 tag fronts MPEG audio, as the sniffing standard reads it; an ID3-tagged FLAC
        // reads as MPEG audio too, by the same rule.
        Some(FileFormat::Mpeg12AudioLayer3)
    } else {
        Some(format)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use file_format::FileFormat;
    use rstest::rstest;

    use super::{DETECTION_PREFIX_BYTES, detect_media_type};

    /// Zero-filled bytes of `length` with each `(offset, bytes)` written in.
    fn bytes_with(length: usize, parts: &[(usize, &[u8])]) -> Vec<u8> {
        let mut bytes = vec![0; length];
        for (offset, part) in parts {
            bytes[*offset..offset + part.len()].copy_from_slice(part);
        }
        bytes
    }

    /// One prefix per row of the web's sniffing table, plus PDF, each naming one of the formats
    /// that meet its row; past the prefix, a ZIP and an ID3 tag still name theirs.
    #[rstest]
    #[case::windows_icon(bytes_with(64, &[(0, b"\0\0\x01\0")]), &[FileFormat::WindowsIcon])]
    #[case::windows_cursor(bytes_with(64, &[(0, b"\0\0\x02\0")]), &[FileFormat::WindowsCursor])]
    #[case::bitmap(bytes_with(64, &[(0, b"BM"), (26, b"\x01\0")]), &[FileFormat::WindowsBitmap])]
    #[case::gif87a(bytes_with(64, &[(0, b"GIF87a")]), &[FileFormat::GraphicsInterchangeFormat])]
    #[case::gif89a(bytes_with(64, &[(0, b"GIF89a")]), &[FileFormat::GraphicsInterchangeFormat])]
    #[case::webp(bytes_with(64, &[(0, b"RIFF"), (8, b"WEBPVP8 ")]), &[FileFormat::Webp])]
    #[case::png(
        bytes_with(64, &[(0, b"\x89PNG\r\n\x1A\n")]),
        &[FileFormat::PortableNetworkGraphics]
    )]
    #[case::jpeg(
        bytes_with(64, &[(0, b"\xFF\xD8\xFF\xE0")]),
        &[FileFormat::JointPhotographicExpertsGroup]
    )]
    #[case::aiff(
        bytes_with(64, &[(0, b"FORM"), (8, b"AIFF")]),
        &[FileFormat::AudioInterchangeFileFormat]
    )]
    #[case::mp3_after_id3(
        bytes_with(64, &[(0, b"ID3\x03")]),
        &[FileFormat::Mpeg12AudioLayer3]
    )]
    #[case::ogg(bytes_with(64, &[(0, b"OggS\0")]), &[FileFormat::OggMultiplexedMedia])]
    #[case::midi(
        bytes_with(64, &[(0, b"MThd\0\0\0\x06")]),
        &[FileFormat::MusicalInstrumentDigitalInterface]
    )]
    #[case::avi(bytes_with(64, &[(0, b"RIFF"), (8, b"AVI ")]), &[FileFormat::AudioVideoInterleave])]
    #[case::wave(bytes_with(64, &[(0, b"RIFF"), (8, b"WAVE")]), &[FileFormat::WaveformAudio])]
    #[case::mp4(
        bytes_with(24, &[(0, b"\0\0\0\x18ftypisom\0\0\x02\0isommp41")]),
        &[
            FileFormat::Mpeg4Part14,
            FileFormat::Mpeg4Part14Audio,
            FileFormat::Mpeg4Part14Subtitles,
            FileFormat::Mpeg4Part14Video,
        ]
    )]
    #[case::webm(
        bytes_with(12, &[(0, b"\x1A\x45\xDF\xA3\x87\x42\x82\x84webm")]),
        &[FileFormat::Webm, FileFormat::ExtensibleBinaryMetaLanguage]
    )]
    #[case::mp3_without_id3(
        bytes_with(64, &[(0, b"\xFF\xFB\x90\0")]),
        &[FileFormat::Mpeg12AudioLayer3]
    )]
    #[case::embedded_opentype(
        bytes_with(64, &[(8, b"\0\0\x01"), (34, b"LP")]),
        &[FileFormat::EmbeddedOpentype]
    )]
    #[case::truetype(bytes_with(64, &[(0, b"\0\x01\0\0\0")]), &[FileFormat::Truetype])]
    #[case::opentype(bytes_with(64, &[(0, b"OTTO\0")]), &[FileFormat::Opentype])]
    #[case::truetype_collection(
        bytes_with(64, &[(0, b"ttcf\0")]),
        &[FileFormat::TruetypeCollection]
    )]
    #[case::woff(bytes_with(64, &[(0, b"wOFF")]), &[FileFormat::WebOpenFontFormat])]
    #[case::woff2(bytes_with(64, &[(0, b"wOF2")]), &[FileFormat::WebOpenFontFormat2])]
    #[case::gzip(bytes_with(64, &[(0, b"\x1F\x8B\x08")]), &[FileFormat::Gzip])]
    #[case::zip(bytes_with(64, &[(0, b"PK\x03\x04")]), &[FileFormat::Zip])]
    #[case::rar(bytes_with(64, &[(0, b"Rar!\x1A\x07\0")]), &[FileFormat::RoshalArchive])]
    #[case::pdf(bytes_with(64, &[(0, b"%PDF-1.7\n")]), &[FileFormat::PortableDocumentFormat])]
    #[case::zip_end_record_past_prefix(
        bytes_with(DETECTION_PREFIX_BYTES + 900, &[(0, b"PK\x03\x04")]),
        &[FileFormat::Zip]
    )]
    #[case::id3_tag_larger_than_prefix(
        bytes_with(DETECTION_PREFIX_BYTES + 900, &[(0, b"ID3\x03\0\0\0\0\x40\0")]),
        &[FileFormat::Mpeg12AudioLayer3]
    )]
    fn names_a_format_that_meets_each_sniffing_row(
        #[case] leading_bytes: Vec<u8>,
        #[case] accepted: &[FileFormat],
    ) {
        let format = detect_media_type(&leading_bytes);
        assert!(
            format.is_some_and(|format| accepted.contains(&format)),
            "{format:?} is not one of {accepted:?}"
        );
    }

    /// Every input of the fuzz target's committed corpus, its minimized crashers included, goes
    /// through `detect_media_type` and is answered without a panic.
    #[test]
    fn every_fuzz_corpus_input_is_answered() {
        let mut folders =
            vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus/media_type")];
        let mut answered = 0_usize;
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).expect("the corpus folder reads") {
                let path = entry.expect("a corpus entry reads").path();
                if path.is_dir() {
                    folders.push(path);
                } else {
                    let leading_bytes = fs::read(&path).expect("a corpus input reads");
                    let _format = detect_media_type(&leading_bytes);
                    answered += 1;
                }
            }
        }
        assert!(answered > 0, "the corpus holds inputs");
    }
}
