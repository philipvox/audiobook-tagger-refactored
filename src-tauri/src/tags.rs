use anyhow::Result;
use std::path::Path;

// Keep the async wrapper for compatibility
pub async fn write_file_tags(
    file_path: &str,
    changes: &std::collections::HashMap<String, crate::scanner::MetadataChange>,
    backup: bool,
) -> Result<()> {
    write_file_tags_sync(file_path, changes, backup)
}

// ✅ NEW: Synchronous version for spawn_blocking
pub fn write_file_tags_sync(
    file_path: &str,
    changes: &std::collections::HashMap<String, crate::scanner::MetadataChange>,
    backup: bool,
) -> Result<()> {
    let path = Path::new(file_path);
    
    if !path.exists() {
        anyhow::bail!("File does not exist: {}", file_path);
    }
    
    let metadata = std::fs::metadata(path)?;
    if metadata.len() == 0 {
        anyhow::bail!("File is empty (0 bytes)");
    }
    
    if backup {
        let backup_path = path.with_extension(
            format!("{}.backup", path.extension().unwrap_or_default().to_string_lossy())
        );
        std::fs::copy(path, &backup_path)?;
    }
    
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    match ext.as_str() {
        "m4a" | "m4b" => write_m4a_tags_sync(file_path, changes),
        "mp3" | "flac" | "ogg" | "opus" => write_standard_tags_sync(file_path, changes),
        _ => anyhow::bail!("Unsupported format: {}", ext)
    }
}

// iTunes M4A/M4B files - synchronous
fn write_m4a_tags_sync(
    file_path: &str,
    changes: &std::collections::HashMap<String, crate::scanner::MetadataChange>,
) -> Result<()> {
    use mp4ameta::{Tag, Data, Fourcc};

    let mut tag = Tag::read_from_path(file_path)
        .unwrap_or_else(|_| Tag::default());

    for (field, change) in changes {
        match field.as_str() {
            "title" => {
                tag.set_title(&change.new);
                tag.set_album(&change.new);
            },
            "artist" | "author" => {
                tag.set_artist(&change.new);
                tag.set_album_artist(&change.new);
            },
            "album" => tag.set_album(&change.new),
            "genre" => {
                tag.remove_data_of(&Fourcc(*b"\xa9gen"));
                let genres: Vec<&str> = change.new.split(',').map(|s| s.trim()).collect();
                for genre in genres {
                    tag.add_data(Fourcc(*b"\xa9gen"), Data::Utf8(genre.to_string()));
                }
            },
            "narrator" | "narrators" => {
                // Support multiple narrators separated by semicolon for ABS
                tag.set_composer(&change.new);
            },
            "description" | "comment" => {
                if !change.new.to_lowercase().contains("narrated by") {
                    tag.set_comment(&change.new);
                }
            },
            "year" => {
                // Validate year is a valid number before setting
                if change.new.parse::<u32>().is_ok() {
                    tag.set_year(change.new.clone());
                }
            },
            "series" => {
                // Remove existing series data first
                tag.remove_data_of(&Fourcc(*b"seri"));
                tag.add_data(Fourcc(*b"seri"), Data::Utf8(change.new.clone()));
            },
            "sequence" => {
                // Remove existing sequence data first
                tag.remove_data_of(&Fourcc(*b"sequ"));
                tag.add_data(Fourcc(*b"sequ"), Data::Utf8(change.new.clone()));
            },
            // NEW FIELDS
            "asin" => {
                // Store ASIN in custom atom
                tag.remove_data_of(&Fourcc(*b"ASIN"));
                tag.add_data(Fourcc(*b"ASIN"), Data::Utf8(change.new.clone()));
            },
            "isbn" => {
                // Store ISBN in custom atom
                tag.remove_data_of(&Fourcc(*b"ISBN"));
                tag.add_data(Fourcc(*b"ISBN"), Data::Utf8(change.new.clone()));
            },
            "language" => {
                // Store language code
                tag.remove_data_of(&Fourcc(*b"lang"));
                tag.add_data(Fourcc(*b"lang"), Data::Utf8(change.new.clone()));
            },
            "publisher" => {
                // Store publisher (copyright holder often used)
                tag.set_copyright(&change.new);
            },
            _ => {}
        }
    }

    tag.write_to_path(file_path)?;
    Ok(())
}

// MP3, FLAC, OGG, etc using lofty - synchronous
fn write_standard_tags_sync(
    file_path: &str,
    changes: &std::collections::HashMap<String, crate::scanner::MetadataChange>,
) -> Result<()> {
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::tag::{Accessor, ItemKey, Tag, TagItem, ItemValue};

    let mut tagged_file = Probe::open(file_path)?.read()?;

    let tag = if let Some(t) = tagged_file.primary_tag_mut() {
        t
    } else {
        let tag_type = tagged_file.primary_tag_type();
        tagged_file.insert_tag(Tag::new(tag_type));
        tagged_file.primary_tag_mut().unwrap()
    };

    for (field, change) in changes {
        match field.as_str() {
            "title" => {
                tag.remove_key(&ItemKey::TrackTitle);
                tag.set_title(change.new.clone());
                tag.remove_key(&ItemKey::AlbumTitle);
                tag.set_album(change.new.clone());
            },
            "artist" | "author" => {
                tag.remove_key(&ItemKey::TrackArtist);
                tag.set_artist(change.new.clone());
                tag.remove_key(&ItemKey::AlbumArtist);
                tag.insert_text(ItemKey::AlbumArtist, change.new.clone());
            },
            "album" => {
                tag.remove_key(&ItemKey::AlbumTitle);
                tag.set_album(change.new.clone());
            },
            "genre" => {
                tag.remove_key(&ItemKey::Genre);
                let genres: Vec<&str> = change.new.split(',').map(|s| s.trim()).collect();
                for genre in genres {
                    tag.push(TagItem::new(
                        ItemKey::Genre,
                        ItemValue::Text(genre.to_string())
                    ));
                }
            },
            "narrator" | "narrators" => {
                // Support multiple narrators separated by semicolon for ABS
                tag.remove_key(&ItemKey::Composer);
                tag.insert_text(ItemKey::Composer, change.new.clone());
            },
            "description" | "comment" => {
                if !change.new.to_lowercase().contains("narrated by") {
                    tag.set_comment(change.new.clone());
                }
            },
            "year" => {
                if let Ok(year) = change.new.parse::<u32>() {
                    tag.set_year(year);
                }
            },
            "series" => {
                // Use TXXX frame for custom data (SERIES)
                tag.remove_key(&ItemKey::Unknown("SERIES".to_string()));
                tag.insert_text(ItemKey::Unknown("SERIES".to_string()), change.new.clone());
            },
            "sequence" => {
                // Use TXXX frame for custom data (SERIES-PART)
                tag.remove_key(&ItemKey::Unknown("SERIES-PART".to_string()));
                tag.insert_text(ItemKey::Unknown("SERIES-PART".to_string()), change.new.clone());
            },
            // NEW FIELDS
            "asin" => {
                // Store ASIN in TXXX:ASIN frame (compatible with many players)
                tag.remove_key(&ItemKey::Unknown("ASIN".to_string()));
                tag.insert_text(ItemKey::Unknown("ASIN".to_string()), change.new.clone());
            },
            "isbn" => {
                // Store ISBN in TXXX:ISBN frame
                tag.remove_key(&ItemKey::Unknown("ISBN".to_string()));
                tag.insert_text(ItemKey::Unknown("ISBN".to_string()), change.new.clone());
            },
            "language" => {
                // Store language in TLAN frame (standard ID3v2)
                tag.remove_key(&ItemKey::Language);
                tag.insert_text(ItemKey::Language, change.new.clone());
            },
            "publisher" => {
                // Store publisher in TPUB frame (standard ID3v2)
                tag.remove_key(&ItemKey::Publisher);
                tag.insert_text(ItemKey::Publisher, change.new.clone());
            },
            _ => {}
        }
    }

    tagged_file.save_to_path(file_path, lofty::config::WriteOptions::default())?;
    Ok(())
}

pub fn verify_genres(file_path: &str) -> Result<Vec<String>> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    match ext.as_str() {
        "m4a" | "m4b" => {
            let tag = mp4ameta::Tag::read_from_path(file_path)?;
            let genres: Vec<String> = tag
                .strings_of(&mp4ameta::Fourcc(*b"\xa9gen"))
                .map(|s| s.to_string())
                .collect();
            Ok(genres)
        },
        _ => {
            use lofty::prelude::*;
            use lofty::probe::Probe;
            use lofty::tag::ItemKey;
            
            let tagged_file = Probe::open(file_path)?.read()?;
            let tag = tagged_file.primary_tag().ok_or_else(|| anyhow::anyhow!("No tag"))?;
            
            let genres: Vec<String> = tag
                .get_strings(&ItemKey::Genre)
                .map(|s| s.to_string())
                .collect();
            Ok(genres)
        }
    }
}