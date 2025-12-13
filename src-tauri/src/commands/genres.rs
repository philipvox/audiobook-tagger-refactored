// src-tauri/src/commands/genres.rs
// Genre cleanup and normalization commands

use serde::{Deserialize, Serialize};
use crate::genres::{
    enforce_genre_policy_with_split,
    enforce_children_age_genres
};

#[derive(Debug, Serialize, Deserialize)]
pub struct GenreCleanupRequest {
    pub groups: Vec<GenreCleanupGroup>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenreCleanupGroup {
    pub id: String,
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub genres: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GenreCleanupResult {
    pub id: String,
    pub original_genres: Vec<String>,
    pub cleaned_genres: Vec<String>,
    pub changed: bool,
}

#[derive(Debug, Serialize)]
pub struct GenreCleanupResponse {
    pub results: Vec<GenreCleanupResult>,
    pub total_cleaned: usize,
    pub total_unchanged: usize,
}

/// Clean and normalize genres for a list of book groups without rescanning
/// This is a quick operation that just applies genre policy rules
#[tauri::command]
pub async fn cleanup_genres(request: GenreCleanupRequest) -> Result<GenreCleanupResponse, String> {
    println!("🧹 Genre cleanup for {} books", request.groups.len());

    let mut results = Vec::new();
    let mut total_cleaned = 0;
    let mut total_unchanged = 0;

    for group in request.groups {
        // Skip if no genres
        if group.genres.is_empty() {
            results.push(GenreCleanupResult {
                id: group.id,
                original_genres: vec![],
                cleaned_genres: vec![],
                changed: false,
            });
            total_unchanged += 1;
            continue;
        }

        // Filter out empty genres first
        let non_empty_genres: Vec<String> = group.genres
            .iter()
            .filter(|g| !g.trim().is_empty())
            .cloned()
            .collect();

        // Apply genre normalization
        let mut cleaned = enforce_genre_policy_with_split(&non_empty_genres);

        // Apply children's age detection
        enforce_children_age_genres(
            &mut cleaned,
            &group.title,
            group.series.as_deref(),
            Some(&group.author),
        );

        // Check if changed
        let changed = cleaned != non_empty_genres || cleaned.len() != group.genres.len();

        if changed {
            total_cleaned += 1;
            println!("   ✅ {} : {:?} → {:?}", group.title, group.genres, cleaned);
        } else {
            total_unchanged += 1;
        }

        results.push(GenreCleanupResult {
            id: group.id,
            original_genres: group.genres,
            cleaned_genres: cleaned,
            changed,
        });
    }

    println!("🧹 Genre cleanup complete: {} cleaned, {} unchanged", total_cleaned, total_unchanged);

    Ok(GenreCleanupResponse {
        results,
        total_cleaned,
        total_unchanged,
    })
}

/// Normalize a single set of genres (local, no ABS)
#[tauri::command]
pub fn normalize_genres_local(
    genres: Vec<String>,
    title: Option<String>,
    series: Option<String>,
    author: Option<String>,
) -> Vec<String> {
    // Filter out empty genres
    let non_empty: Vec<String> = genres
        .iter()
        .filter(|g| !g.trim().is_empty())
        .cloned()
        .collect();

    // Apply genre normalization
    let mut cleaned = enforce_genre_policy_with_split(&non_empty);

    // Apply children's age detection if we have context
    if let Some(ref t) = title {
        enforce_children_age_genres(
            &mut cleaned,
            t,
            series.as_deref(),
            author.as_deref(),
        );
    }

    cleaned
}

/// Get the approved genres list
#[tauri::command]
pub fn get_approved_genres() -> Vec<String> {
    crate::genres::APPROVED_GENRES
        .iter()
        .map(|s| s.to_string())
        .collect()
}
