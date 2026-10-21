//! A picture's natural size, read from its header when its bytes are stored, never from its pixels:
//! the width and height the header declares, swapped when its EXIF orientation turns it a quarter,
//! so the size is the one it is drawn at.
//!
//! - PNG (animated too), GIF and WebP are read through `image`'s decoders, each of which stops at
//!   its header and metadata.
//! - JPEG is read through `zune-jpeg`, which stops at the start of the scan. `image`'s own JPEG
//!   decoder reads the whole file into memory before its header, and no bound caps one file's
//!   size. Its default caps refuse a picture wider or taller than 16,384 pixels, so they are
//!   raised: a header read decodes no pixel.
//! - Bytes whose header cannot be read carry no size: the type was read from their leading bytes,
//!   and nothing is refused for its type.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use file_format::FileFormat;
use image::metadata::Orientation;
use image::{ImageDecoder as _, ImageFormat, ImageReader};
use sidekicks_contracts::artifacts::operations::ArtifactPictureSize;
use sidekicks_contracts::wire::integer::SafeInt;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::options::DecoderOptions;

/// The size of the picture stored at `path`, whose leading bytes read as `format`, or `None` for
/// bytes of another format or whose header cannot be read. Blocks while it reads the header; fails
/// only when the file cannot be opened.
pub(crate) fn read_picture_size(
    path: &Path,
    format: FileFormat,
) -> io::Result<Option<ArtifactPictureSize>> {
    // `file_format` names hundreds of formats; these five are the pictures the read takes.
    let image_format = if matches!(
        format,
        FileFormat::PortableNetworkGraphics | FileFormat::AnimatedPortableNetworkGraphics
    ) {
        ImageFormat::Png
    } else if matches!(format, FileFormat::GraphicsInterchangeFormat) {
        ImageFormat::Gif
    } else if matches!(format, FileFormat::Webp) {
        ImageFormat::WebP
    } else if matches!(format, FileFormat::JointPhotographicExpertsGroup) {
        return Ok(read_jpeg_size(BufReader::new(File::open(path)?)));
    } else {
        return Ok(None);
    };
    let reader = ImageReader::with_format(BufReader::new(File::open(path)?), image_format);
    let Ok(mut decoder) = reader.into_decoder() else {
        return Ok(None);
    };
    let (width, height) = decoder.dimensions();
    // A picture whose metadata cannot be read is drawn as its header lays it out.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    Ok(oriented_size(
        u64::from(width),
        u64::from(height),
        orientation,
    ))
}

// A JPEG's size from its frame header, oriented by its EXIF chunk when it has one.
fn read_jpeg_size(reader: BufReader<File>) -> Option<ArtifactPictureSize> {
    let options = DecoderOptions::default()
        .set_max_width(usize::MAX)
        .set_max_height(usize::MAX);
    let mut decoder = JpegDecoder::new_with_options(reader, options);
    decoder.decode_headers().ok()?;
    let (width, height) = decoder.dimensions()?;
    let orientation = decoder
        .exif()
        .and_then(|chunk| Orientation::from_exif_chunk(chunk))
        .unwrap_or(Orientation::NoTransforms);
    oriented_size(
        u64::try_from(width).ok()?,
        u64::try_from(height).ok()?,
        orientation,
    )
}

// The size a picture of `width` by `height` is drawn at under `orientation`; none for a header
// that declares no pixel.
fn oriented_size(width: u64, height: u64, orientation: Orientation) -> Option<ArtifactPictureSize> {
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        Orientation::NoTransforms
        | Orientation::Rotate180
        | Orientation::FlipHorizontal
        | Orientation::FlipVertical => (width, height),
    };
    Some(ArtifactPictureSize {
        width: SafeInt::new(width)?,
        height: SafeInt::new(height)?,
    })
}

#[cfg(test)]
mod tests {
    use file_format::FileFormat;
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder as _};
    use rstest::rstest;

    use super::read_picture_size;
    use crate::artifacts::detection::detect_media_type;

    /// A JPEG of `width` by `height`, with an EXIF orientation where one is given.
    fn jpeg(width: u32, height: u32, orientation: Option<u8>) -> Vec<u8> {
        let mut encoded = Vec::new();
        let pixels = vec![0; usize::try_from(width * height * 3).expect("a test picture fits")];
        JpegEncoder::new(&mut encoded)
            .encode(&pixels, width, height, ExtendedColorType::Rgb8)
            .expect("the test encodes a JPEG");
        let Some(orientation) = orientation else {
            return encoded;
        };
        // An APP1 segment of one big-endian TIFF directory holding only the orientation.
        let mut exif = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0]);
        let length = u16::try_from(exif.len() + 2).expect("the segment is short");
        let mut segment = vec![0xFF, 0xE1];
        segment.extend_from_slice(&length.to_be_bytes());
        segment.extend_from_slice(&exif);
        encoded.splice(2..2, segment);
        encoded
    }

    /// `jpeg` cut right after its start-of-scan header, so no scan byte follows.
    fn cut_after_scan_header(jpeg: &[u8]) -> Vec<u8> {
        let marker = jpeg
            .windows(2)
            .position(|pair| pair == [0xFF, 0xDA])
            .expect("a JPEG has a start of scan");
        let length = usize::from(u16::from_be_bytes([jpeg[marker + 2], jpeg[marker + 3]]));
        jpeg[..marker + 2 + length].to_vec()
    }

    /// A PNG of `width` by `height`, animated when `is_animated`: an `acTL` chunk after its header.
    fn png(width: u32, height: u32, is_animated: bool) -> Vec<u8> {
        let mut encoded = Vec::new();
        let pixels = vec![0; usize::try_from(width * height * 3).expect("a test picture fits")];
        PngEncoder::new(&mut encoded)
            .write_image(&pixels, width, height, ExtendedColorType::Rgb8)
            .expect("the test encodes a PNG");
        if is_animated {
            // One frame, played once.
            let body = b"acTL\0\0\0\x01\0\0\0\0";
            let mut crc = flate2::Crc::new();
            crc.update(body);
            let mut chunk = 8_u32.to_be_bytes().to_vec();
            chunk.extend_from_slice(body);
            chunk.extend_from_slice(&crc.sum().to_be_bytes());
            // The signature and the header chunk come first.
            encoded.splice(33..33, chunk);
            assert_eq!(
                detect_media_type(&encoded),
                Some(FileFormat::AnimatedPortableNetworkGraphics)
            );
        }
        encoded
    }

    /// The size the bytes store, read as the pipeline reads it.
    fn stored_size(bytes: &[u8]) -> Option<(u64, u64)> {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let path = folder.path().join("picture");
        std::fs::write(&path, bytes).expect("the test writes the picture");
        let format = detect_media_type(bytes)?;
        read_picture_size(&path, format)
            .expect("the test's file opens")
            .map(|size| (size.width.get(), size.height.get()))
    }

    /// A picture stores the size it is drawn at: an orientation that turns it a quarter swaps its
    /// sides and one that does not keeps them, a JPEG past the decoder's default caps and one cut
    /// at its scan read from the header alone, an animated PNG reads as a PNG, and text stores no
    /// size.
    #[rstest]
    #[case::a_quarter_turn_swaps(jpeg(8, 4, Some(6)), Some((4, 8)))]
    #[case::a_half_turn_keeps(jpeg(8, 4, Some(3)), Some((8, 4)))]
    #[case::wider_than_the_default_cap(jpeg(20_000, 1, None), Some((20_000, 1)))]
    #[case::cut_at_its_scan(cut_after_scan_header(&jpeg(8, 4, Some(6))), Some((4, 8)))]
    #[case::a_png(png(8, 4, false), Some((8, 4)))]
    #[case::an_animated_png(png(8, 4, true), Some((8, 4)))]
    #[case::text(b"plain words".to_vec(), None)]
    fn a_picture_stores_the_size_it_is_drawn_at(
        #[case] bytes: Vec<u8>,
        #[case] expected: Option<(u64, u64)>,
    ) {
        assert_eq!(stored_size(&bytes), expected);
    }
}
