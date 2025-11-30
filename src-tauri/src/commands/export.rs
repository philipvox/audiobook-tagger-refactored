// commands/export.rs
// Export metadata to CSV/JSON formats

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;

use crate::scanner::types::BookGroup;

#[derive(Debug, Serialize, Deserialize)]
struct ExportRow {
    title: String,
    subtitle: String,
    author: String,
    narrator: String,
    series: String,
    sequence: String,
    genres: String,
    publisher: String,
    year: String,
    language: String,
    description: String,
    isbn: String,
    asin: String,
    runtime_minutes: String,
    abridged: String,
    file_count: usize,
    folder_path: String,
}

impl From<&BookGroup> for ExportRow {
    fn from(group: &BookGroup) -> Self {
        let metadata = &group.metadata;

        // Get folder path from first file
        let folder_path = group.files.first()
            .map(|f| {
                std::path::Path::new(&f.path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        ExportRow {
            title: metadata.title.clone(),
            subtitle: metadata.subtitle.clone().unwrap_or_default(),
            author: metadata.author.clone(),
            narrator: metadata.narrator.clone().unwrap_or_default(),
            series: metadata.series.clone().unwrap_or_default(),
            sequence: metadata.sequence.clone().unwrap_or_default(),
            genres: metadata.genres.join(", "),
            publisher: metadata.publisher.clone().unwrap_or_default(),
            year: metadata.year.clone().unwrap_or_default(),
            language: metadata.language.clone().unwrap_or_default(),
            description: metadata.description.clone().unwrap_or_default(),
            isbn: metadata.isbn.clone().unwrap_or_default(),
            asin: metadata.asin.clone().unwrap_or_default(),
            runtime_minutes: metadata.runtime_minutes.map(|m| m.to_string()).unwrap_or_default(),
            abridged: metadata.abridged.map(|b| if b { "Yes" } else { "No" }.to_string()).unwrap_or_default(),
            file_count: group.files.len(),
            folder_path,
        }
    }
}

#[tauri::command]
pub async fn export_to_csv(
    groups: Vec<BookGroup>,
    file_path: String,
) -> Result<String, String> {
    let rows: Vec<ExportRow> = groups.iter().map(ExportRow::from).collect();

    let mut wtr = csv::Writer::from_path(&file_path)
        .map_err(|e| format!("Failed to create CSV file: {}", e))?;

    for row in &rows {
        wtr.serialize(row)
            .map_err(|e| format!("Failed to write row: {}", e))?;
    }

    wtr.flush().map_err(|e| format!("Failed to flush CSV: {}", e))?;

    Ok(format!("Exported {} books to {}", rows.len(), file_path))
}

#[tauri::command]
pub async fn export_to_json(
    groups: Vec<BookGroup>,
    file_path: String,
    pretty: bool,
) -> Result<String, String> {
    let mut file = File::create(&file_path)
        .map_err(|e| format!("Failed to create JSON file: {}", e))?;

    let json_data = if pretty {
        serde_json::to_string_pretty(&groups)
            .map_err(|e| format!("Failed to serialize JSON: {}", e))?
    } else {
        serde_json::to_string(&groups)
            .map_err(|e| format!("Failed to serialize JSON: {}", e))?
    };

    file.write_all(json_data.as_bytes())
        .map_err(|e| format!("Failed to write JSON: {}", e))?;

    Ok(format!("Exported {} books to {}", groups.len(), file_path))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub narrator: Option<String>,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub genres: Option<Vec<String>>,
    pub publisher: Option<String>,
    pub year: Option<String>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub asin: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub matched: usize,
    pub unmatched: usize,
    pub updates: Vec<ImportUpdate>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportUpdate {
    pub group_id: String,
    pub title: String,
    pub metadata: ImportMetadata,
}

#[tauri::command]
pub async fn import_from_csv(
    file_path: String,
    groups: Vec<BookGroup>,
) -> Result<ImportResult, String> {
    let mut rdr = csv::Reader::from_path(&file_path)
        .map_err(|e| format!("Failed to read CSV file: {}", e))?;

    let mut updates = Vec::new();
    let mut matched = 0;
    let mut unmatched = 0;

    for result in rdr.deserialize() {
        let row: ExportRow = result.map_err(|e| format!("Failed to parse row: {}", e))?;

        // Try to match by folder path first, then by title
        let matching_group = groups.iter().find(|g| {
            let group_folder = g.files.first()
                .map(|f| {
                    std::path::Path::new(&f.path)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default()
                })
                .unwrap_or_default();

            group_folder == row.folder_path ||
            g.metadata.title.to_lowercase() == row.title.to_lowercase()
        });

        if let Some(group) = matching_group {
            let metadata = ImportMetadata {
                title: Some(row.title.clone()),
                subtitle: if row.subtitle.is_empty() { None } else { Some(row.subtitle) },
                author: Some(row.author),
                narrator: if row.narrator.is_empty() { None } else { Some(row.narrator) },
                series: if row.series.is_empty() { None } else { Some(row.series) },
                sequence: if row.sequence.is_empty() { None } else { Some(row.sequence) },
                genres: if row.genres.is_empty() {
                    None
                } else {
                    Some(row.genres.split(',').map(|s| s.trim().to_string()).collect())
                },
                publisher: if row.publisher.is_empty() { None } else { Some(row.publisher) },
                year: if row.year.is_empty() { None } else { Some(row.year) },
                language: if row.language.is_empty() { None } else { Some(row.language) },
                description: if row.description.is_empty() { None } else { Some(row.description) },
                isbn: if row.isbn.is_empty() { None } else { Some(row.isbn) },
                asin: if row.asin.is_empty() { None } else { Some(row.asin) },
            };

            updates.push(ImportUpdate {
                group_id: group.id.clone(),
                title: row.title,
                metadata,
            });
            matched += 1;
        } else {
            unmatched += 1;
        }
    }

    Ok(ImportResult {
        matched,
        unmatched,
        updates,
    })
}

#[tauri::command]
pub async fn import_from_json(
    file_path: String,
) -> Result<Vec<BookGroup>, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read JSON file: {}", e))?;

    let groups: Vec<BookGroup> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    Ok(groups)
}
