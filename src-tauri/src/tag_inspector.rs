use anyhow::Result;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, ItemValue};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::ptr;

#[derive(Debug, Serialize, Deserialize)]
pub struct RawTags {
    pub file_path: String,
    pub file_format: String,
    pub duration_seconds: Option<u64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub tags: Vec<TagEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TagEntry {
    pub key: String,
    pub value: String,
    pub tag_type: String,
}

pub fn inspect_file_tags(file_path: &str) -> Result<RawTags> {
    let path = Path::new(file_path);

    let tagged_file = Probe::open(path)?.read()?;

    // Get file format
    let file_format = format!("{:?}", tagged_file.file_type());

    // Get audio properties
    let properties = tagged_file.properties();
    let duration_secs = properties.duration().as_secs();
    let duration_seconds = if duration_secs > 0 {
        Some(duration_secs)
    } else {
        None
    };
    let bitrate = properties.audio_bitrate();
    let sample_rate = properties.sample_rate();

    let mut tags = Vec::new();

    let primary_tag = tagged_file.primary_tag();

    // Get all tags from the file
    if let Some(tag) = primary_tag {
        let tag_type = format!("{:?}", tag.tag_type());

        // Standard fields
        if let Some(title) = tag.title() {
            tags.push(TagEntry {
                key: "Title".to_string(),
                value: title.to_string(),
                tag_type: tag_type.clone(),
            });
        }

        if let Some(artist) = tag.artist() {
            tags.push(TagEntry {
                key: "Artist/Author".to_string(),
                value: artist.to_string(),
                tag_type: tag_type.clone(),
            });
        }

        if let Some(album) = tag.album() {
            tags.push(TagEntry {
                key: "Album".to_string(),
                value: album.to_string(),
                tag_type: tag_type.clone(),
            });
        }

        if let Some(year) = tag.year() {
            tags.push(TagEntry {
                key: "Year".to_string(),
                value: year.to_string(),
                tag_type: tag_type.clone(),
            });
        }

        if let Some(comment) = tag.comment() {
            tags.push(TagEntry {
                key: "Comment".to_string(),
                value: comment.to_string(),
                tag_type: tag_type.clone(),
            });
        }

        // Get ALL genre tags (this will show if they're separated or not)
        let genres: Vec<String> = tag
            .get_strings(&ItemKey::Genre)
            .map(|s| s.to_string())
            .collect();

        if !genres.is_empty() {
            for (idx, genre) in genres.iter().enumerate() {
                tags.push(TagEntry {
                    key: format!("Genre #{}", idx + 1),
                    value: genre.clone(),
                    tag_type: tag_type.clone(),
                });
            }
        }

        // Composer (where narrator might be)
        let composers: Vec<String> = tag
            .get_strings(&ItemKey::Composer)
            .map(|s| s.to_string())
            .collect();

        if !composers.is_empty() {
            for composer in composers {
                tags.push(TagEntry {
                    key: "Composer (Narrator?)".to_string(),
                    value: composer,
                    tag_type: tag_type.clone(),
                });
            }
        }

        // Get ALL items (including custom tags)
        for item in tag.items() {
            let value_str = match item_value_to_string(item.value()) {
                Some(value) if !value.is_empty() => value,
                _ => continue,
            };

            let key_str = match item.key() {
                ItemKey::TrackTitle => "TrackTitle (Raw)".to_string(),
                ItemKey::TrackArtist => "TrackArtist (Raw)".to_string(),
                ItemKey::AlbumTitle => "AlbumTitle (Raw)".to_string(),
                ItemKey::Genre => continue,    // Already handled above
                ItemKey::Comment => continue,  // Already handled above
                ItemKey::Year => continue,     // Already handled above
                ItemKey::Composer => continue, // Already handled above
                ItemKey::Unknown(ref s) => format!("Custom: {}", s),
                other => format!("{:?}", other),
            };

            // Skip duplicates we already added
            if key_str.contains("(Raw)") && tags.iter().any(|t| t.value == value_str) {
                continue;
            }

            tags.push(TagEntry {
                key: key_str,
                value: value_str,
                tag_type: tag_type.clone(),
            });
        }
    }

    // Check other tag types too
    for tag in tagged_file.tags() {
        if primary_tag
            .map(|primary| ptr::eq(primary, tag))
            .unwrap_or(false)
        {
            continue; // Already processed
        }

        let tag_type = format!("{:?} (Secondary)", tag.tag_type());

        for item in tag.items() {
            let value = match item_value_to_string(item.value()) {
                Some(value) if !value.is_empty() => value,
                _ => continue,
            };

            let key = format!("{:?}", item.key());

            tags.push(TagEntry {
                key,
                value,
                tag_type: tag_type.clone(),
            });
        }
    }

    Ok(RawTags {
        file_path: file_path.to_string(),
        file_format,
        duration_seconds,
        bitrate,
        sample_rate,
        tags,
    })
}

fn item_value_to_string(value: &ItemValue) -> Option<String> {
    match value {
        ItemValue::Text(text) => Some(text.to_string()),
        ItemValue::Locator(locator) => Some(locator.to_string()),
        ItemValue::Binary(binary) => {
            let bytes: &[u8] = binary.as_ref();

            if bytes.is_empty() {
                None
            } else {
                Some(format!("<binary data: {} bytes>", bytes.len()))
            }
        }
    }
}
