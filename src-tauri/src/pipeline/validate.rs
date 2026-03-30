// src-tauri/src/pipeline/validate.rs
// VALIDATE stage - catch GPT mistakes, ensure data quality
// Uses comprehensive lookup tables from validation/lookups.rs

use crate::pipeline::types::{AggregatedBookData, ResolvedMetadata, ResolvedSeries};
use crate::validation::lookups::{
    AUTHOR_AS_SERIES, AUTHOR_CANONICAL, INVALID_AUTHORS, INVALID_SERIES,
    SERIES_CANONICAL, SERIES_OWNERSHIP, VALID_CHARACTER_SERIES, DISCWORLD_ORPHANS,
    DISCWORLD_SEQUENCE,
};

/// Validate and clean GPT output
pub fn validate_metadata(
    mut resolved: ResolvedMetadata,
    original: &AggregatedBookData,
) -> Result<ResolvedMetadata, String> {
    // Collect warnings
    let mut warnings = Vec::new();

    // 1. Title validation
    resolved.title = validate_title(&resolved.title, original, &mut warnings);

    // 2. Author validation + normalization
    resolved.author = validate_author(&resolved.author, &resolved.authors, original, &mut warnings);
    
    // 3. Normalize author name using lookup table
    resolved.author = normalize_author(&resolved.author);
    
    // 4. Update authors array to match normalized author
    if !resolved.authors.is_empty() {
        resolved.authors = resolved.authors.iter()
            .map(|a| normalize_author(a))
            .collect();
    }

    // 5. Series validation (reject invalid, normalize, check ownership)
    resolved.series = validate_series(&resolved.series, &resolved.author, &resolved.title, original, &mut warnings);

    // 6. Ensure authors array matches author field
    if resolved.authors.is_empty() && !resolved.author.is_empty() && resolved.author != "Unknown" {
        resolved.authors = vec![resolved.author.clone()];
    }

    // 7. Ensure narrators array matches narrator field
    if resolved.narrators.is_empty() {
        if let Some(ref narrator) = resolved.narrator {
            resolved.narrators = vec![narrator.clone()];
        }
    }

    // 8. Clean up genres
    resolved.genres = validate_genres(&resolved.genres);

    // 9. Clean description
    if let Some(ref desc) = resolved.description {
        resolved.description = Some(clean_description(desc));
    }

    // 10. Validate year
    if let Some(ref year) = resolved.year {
        if !is_valid_year(year) {
            warnings.push(format!("Invalid year '{}', removing", year));
            resolved.year = None;
        }
    }

    // Log warnings
    for warning in &warnings {
        println!("   ⚠ Validation: {}", warning);
    }

    // Add warnings to reasoning
    if !warnings.is_empty() {
        let warning_text = format!("\nValidation warnings: {}", warnings.join("; "));
        resolved.reasoning = Some(
            resolved
                .reasoning
                .map(|r| format!("{}{}", r, warning_text))
                .unwrap_or(warning_text),
        );
    }

    Ok(resolved)
}

/// Validate and clean title
fn validate_title(
    title: &str,
    original: &AggregatedBookData,
    warnings: &mut Vec<String>,
) -> String {
    let mut clean = title.trim().to_string();

    // Remove common file artifacts
    let artifacts = [
        "_mp3", ".mp3", "_m4b", ".m4b", "_m4a", ".m4a",
        "[Unabridged]", "(Unabridged)", "[unabridged]",
        "[Abridged]", "(Abridged)",
        " - Audiobook", " (Audiobook)", " [Audiobook]",
    ];

    for artifact in &artifacts {
        if clean.contains(artifact) {
            warnings.push(format!("Removed artifact '{}' from title", artifact));
            clean = clean.replace(artifact, "").trim().to_string();
        }
    }

    // If GPT returned something weird, fall back to original
    if clean.is_empty() || clean == "Unknown" {
        if let Some(original_title) = original.best_title() {
            warnings.push("GPT title was empty, using original".to_string());
            return original_title;
        }
    }

    // Check for suspiciously short titles (likely extraction errors)
    if clean.len() < 2 {
        if let Some(original_title) = original.best_title() {
            warnings.push(format!(
                "Title '{}' too short, using original",
                clean
            ));
            return original_title;
        }
    }

    clean
}

/// Validate and clean author
fn validate_author(
    author: &str,
    authors: &[String],
    original: &AggregatedBookData,
    warnings: &mut Vec<String>,
) -> String {
    let clean = author.trim();
    let lower = clean.to_lowercase();

    // Check against INVALID_AUTHORS lookup table
    if INVALID_AUTHORS.contains(lower.as_str()) {
        // Try to get from authors array
        if let Some(first) = authors.first().filter(|a| !INVALID_AUTHORS.contains(a.to_lowercase().as_str())) {
            warnings.push(format!("Author '{}' invalid, using '{}'", author, first));
            return first.clone();
        }

        // Fall back to original
        if let Some(original_author) = original.best_author() {
            warnings.push(format!("Author '{}' invalid, using original", author));
            return original_author;
        }
        
        return "Unknown".to_string();
    }

    // Check for narrator in author field (common GPT mistake)
    let narrator_indicators = ["narrated by", "read by", "performed by"];
    if narrator_indicators.iter().any(|ind| lower.contains(ind)) {
        warnings.push(format!("Author '{}' contains narrator info", author));
        // Try to extract just the author part
        for ind in &narrator_indicators {
            if let Some(idx) = lower.find(ind) {
                let author_part = clean[..idx].trim();
                if !author_part.is_empty() {
                    return author_part.to_string();
                }
            }
        }
    }

    clean.to_string()
}

/// Normalize author name using AUTHOR_CANONICAL lookup table
fn normalize_author(author: &str) -> String {
    let lower = author.to_lowercase();
    
    if let Some(&canonical) = AUTHOR_CANONICAL.get(lower.as_str()) {
        canonical.to_string()
    } else {
        author.to_string()
    }
}

/// Validate series entries - reject invalid, normalize names, check ownership
fn validate_series(
    series: &[ResolvedSeries],
    author: &str,
    title: &str,
    original: &AggregatedBookData,
    warnings: &mut Vec<String>,
) -> Vec<ResolvedSeries> {
    let title_lower = title.to_lowercase();
    let title_normalized = normalize_for_comparison(title);
    let author_lower = author.to_lowercase();

    let mut validated: Vec<ResolvedSeries> = series
        .iter()
        .filter(|s| {
            let name = s.name.trim();
            if name.is_empty() {
                warnings.push("Removed empty series name".to_string());
                return false;
            }

            let lower = name.to_lowercase();

            // ================================================================
            // CHECK 1: INVALID_SERIES lookup table (comprehensive)
            // ================================================================
            if INVALID_SERIES.contains(lower.as_str()) {
                warnings.push(format!("Rejected invalid series '{}' (in INVALID_SERIES)", name));
                return false;
            }

            // ================================================================
            // CHECK 2: AUTHOR_AS_SERIES lookup table
            // ================================================================
            if AUTHOR_AS_SERIES.contains(lower.as_str()) {
                warnings.push(format!("Rejected author-as-series '{}' (in AUTHOR_AS_SERIES)", name));
                return false;
            }

            // ================================================================
            // CHECK 3: Series matches title (common GPT mistake)
            // ================================================================
            let series_normalized = normalize_for_comparison(name);
            if series_normalized == title_normalized {
                let word_count = title_normalized.split_whitespace().count();
                let is_short_title = word_count <= 2 && title_normalized.len() < 20;

                if is_short_title {
                    warnings.push(format!("Rejected series '{}' - matches short title", name));
                    return false;
                }

                // Allow longer titles like "Dungeon Crawler Carl" if has sequence
                if s.sequence.is_none() {
                    warnings.push(format!("Rejected series '{}' - matches title without sequence", name));
                    return false;
                }
            }

            // ================================================================
            // CHECK 4: Series-Author ownership (SERIES_OWNERSHIP lookup)
            // ================================================================
            if let Some(valid_authors) = SERIES_OWNERSHIP.get(lower.as_str()) {
                let author_matches = valid_authors.iter().any(|va| author_lower.contains(va));
                if !author_matches {
                    warnings.push(format!(
                        "Rejected series '{}' - wrong author '{}' (expected one of: {:?})",
                        name, author, valid_authors
                    ));
                    return false;
                }
            }

            // ================================================================
            // CHECK 5: Discworld orphan subseries
            // ================================================================
            if DISCWORLD_ORPHANS.contains(lower.as_str()) {
                // Only reject if it's standalone (not prefixed with "Discworld")
                if !lower.contains("discworld") {
                    warnings.push(format!("Rejected orphan Discworld subseries '{}'", name));
                    return false;
                }
            }

            // ================================================================
            // CHECK 6: Person name as series (not a known character series)
            // ================================================================
            if is_person_name_series(&lower) && !VALID_CHARACTER_SERIES.contains(lower.as_str()) {
                // Also check if it matches the author
                if is_author_as_series_dynamic(&lower, &author_lower) {
                    warnings.push(format!("Rejected person-name series '{}' (matches author)", name));
                    return false;
                }
            }

            // ================================================================
            // CHECK 7: Foreign language series
            // ================================================================
            if is_foreign_language_series(name) {
                warnings.push(format!("Rejected foreign language series '{}'", name));
                return false;
            }

            // ================================================================
            // CHECK 8: Adaptation/retelling series
            // ================================================================
            if is_adaptation_series(name, title) {
                warnings.push(format!("Rejected adaptation series '{}'", name));
                return false;
            }

            // ================================================================
            // CHECK 9: Validate sequence format
            // ================================================================
            if let Some(ref seq) = s.sequence {
                if !is_valid_sequence(seq) {
                    warnings.push(format!(
                        "Series '{}' has invalid sequence '{}', will extract number",
                        name, seq
                    ));
                }
            }

            true
        })
        .cloned()
        .collect();

    // Post-process validated series (separate loop to avoid borrow conflict)
    for s in &mut validated {
        let original_name = s.name.clone();

        // Normalize series name using SERIES_CANONICAL
        s.name = normalize_series_name(&s.name);

        // Clean up sequence
        if let Some(ref seq) = s.sequence.clone() {
            if !is_valid_sequence(seq) {
                s.sequence = extract_sequence_number(seq);
            }
        }

        // IMPORTANT: When normalizing subseries to parent series, clear the sequence
        // The subseries sequence (e.g., "Harry Potter - Illustrated #1") is NOT valid
        // for the parent series (e.g., "Harry Potter")
        // Also detect when SERIES_CANONICAL maps a different name to parent (e.g., "Moist von Lipwig" → "Discworld")
        let was_subseries = original_name.contains(" - ") && !s.name.contains(" - ");
        let was_canonical_remap = original_name.to_lowercase() != s.name.to_lowercase()
            && !original_name.to_lowercase().starts_with(&s.name.to_lowercase());
        if (was_subseries || was_canonical_remap) && s.sequence.is_some() {
            let old_seq = s.sequence.as_deref().unwrap_or("none");

            // Special case: Discworld has authoritative publication order
            if s.name.to_lowercase() == "discworld" {
                if let Some(&correct_seq) = DISCWORLD_SEQUENCE.get(title_lower.as_str()) {
                    warnings.push(format!(
                        "Subseries→parent: '{}' → '{}' (sequence #{} → #{})",
                        original_name, s.name, old_seq, correct_seq
                    ));
                    s.sequence = Some(correct_seq.to_string());
                } else {
                    // Unknown Discworld book - clear sequence
                    warnings.push(format!(
                        "Subseries→parent: '{}' → '{}' (clearing invalid sequence #{})",
                        original_name, s.name, old_seq
                    ));
                    s.sequence = None;
                }
            } else {
                // For all other series, clear the subseries sequence
                warnings.push(format!(
                    "Subseries→parent: '{}' → '{}' (clearing invalid sequence #{})",
                    original_name, s.name, old_seq
                ));
                s.sequence = None;
            }
        }
        // Non-subseries Discworld books also need sequence fix
        else if s.name.to_lowercase() == "discworld" {
            if let Some(&correct_seq) = DISCWORLD_SEQUENCE.get(title_lower.as_str()) {
                let current_seq = s.sequence.as_deref().unwrap_or("none");
                if current_seq != correct_seq {
                    warnings.push(format!(
                        "Fixed Discworld sequence: '{}' #{} → #{}",
                        title, current_seq, correct_seq
                    ));
                    s.sequence = Some(correct_seq.to_string());
                }
            }
        }
    }

    // If we filtered out all series but original had some, try to recover
    if validated.is_empty() && !original.all_series_names().is_empty() {
        warnings.push("All GPT series rejected, checking original series".to_string());
        
        // Find best series from original that passes validation
        for source in &original.sources {
            for se in &source.series {
                let lower = se.name.to_lowercase();
                
                // Skip if invalid
                if INVALID_SERIES.contains(lower.as_str()) {
                    continue;
                }
                if AUTHOR_AS_SERIES.contains(lower.as_str()) {
                    continue;
                }
                
                // Check ownership
                if let Some(valid_authors) = SERIES_OWNERSHIP.get(lower.as_str()) {
                    if !valid_authors.iter().any(|va| author_lower.contains(va)) {
                        continue;
                    }
                }
                
                // This one is valid
                let original_name = se.name.clone();
                let normalized_name = normalize_series_name(&se.name);

                // Determine final sequence - clear if normalizing subseries to parent
                // Also detect when SERIES_CANONICAL maps a different name (e.g., "Moist von Lipwig" → "Discworld")
                let was_subseries = original_name.contains(" - ") && !normalized_name.contains(" - ");
                let was_canonical_remap = original_name.to_lowercase() != normalized_name.to_lowercase()
                    && !original_name.to_lowercase().starts_with(&normalized_name.to_lowercase());
                let final_sequence = if (was_subseries || was_canonical_remap) && se.sequence.is_some() {
                    let old_seq = se.sequence.as_deref().unwrap_or("none");

                    // Special case: Discworld has authoritative publication order
                    if normalized_name.to_lowercase() == "discworld" {
                        if let Some(&correct_seq) = DISCWORLD_SEQUENCE.get(title_lower.as_str()) {
                            warnings.push(format!(
                                "Subseries→parent: '{}' → '{}' (sequence #{} → #{})",
                                original_name, normalized_name, old_seq, correct_seq
                            ));
                            Some(correct_seq.to_string())
                        } else {
                            warnings.push(format!(
                                "Subseries→parent: '{}' → '{}' (clearing invalid sequence #{})",
                                original_name, normalized_name, old_seq
                            ));
                            None
                        }
                    } else {
                        // For all other series, clear the subseries sequence
                        warnings.push(format!(
                            "Subseries→parent: '{}' → '{}' (clearing invalid sequence #{})",
                            original_name, normalized_name, old_seq
                        ));
                        None
                    }
                } else if normalized_name.to_lowercase() == "discworld" {
                    // Non-subseries Discworld - still fix sequence if needed
                    if let Some(&correct_seq) = DISCWORLD_SEQUENCE.get(title_lower.as_str()) {
                        let current_seq = se.sequence.as_deref().unwrap_or("none");
                        if current_seq != correct_seq {
                            warnings.push(format!(
                                "Fixed Discworld sequence: '{}' #{} → #{}",
                                title, current_seq, correct_seq
                            ));
                        }
                        Some(correct_seq.to_string())
                    } else {
                        se.sequence.clone()
                    }
                } else {
                    se.sequence.clone()
                };

                validated.push(ResolvedSeries {
                    name: normalized_name,
                    sequence: final_sequence,
                    is_primary: true,
                    is_subseries_of: None,
                });
                break;
            }
            if !validated.is_empty() {
                break;
            }
        }
    }

    // ONLY KEEP ONE SERIES - the first/best one
    validated.truncate(1);

    // Ensure primary is marked
    if let Some(first) = validated.first_mut() {
        first.is_primary = true;
    }

    validated
}

/// Normalize series name using SERIES_CANONICAL lookup table
fn normalize_series_name(name: &str) -> String {
    let lower = name.to_lowercase();
    
    // First check exact match in SERIES_CANONICAL
    if let Some(&canonical) = SERIES_CANONICAL.get(lower.as_str()) {
        return canonical.to_string();
    }
    
    // Check partial matches for complex patterns
    // Charlotte and Thomas Pitt variants
    if lower.contains("charlotte") && lower.contains("thomas pitt") {
        return "Thomas Pitt".to_string();
    }
    
    // Chief Inspector Gamache variants
    if lower.contains("gamache") && (lower.contains("chief") || lower.contains("inspector")) {
        return "Inspector Gamache".to_string();
    }
    
    // Dresden Files
    if lower == "the dresden files" {
        return "Dresden Files".to_string();
    }
    
    // Discworld subseries -> Discworld
    if lower.starts_with("discworld -") || lower.starts_with("discworld:") {
        return "Discworld".to_string();
    }
    
    // Magic Tree House Merlin Missions variants
    if lower.contains("magic tree house") && lower.contains("merlin") {
        return "Magic Tree House: Merlin Missions".to_string();
    }
    
    // Remove common suffixes
    let mut result = name.to_string();
    let suffixes = [" Series", " Novels", " Books", " Saga", " Chronicles", " Trilogy"];
    for suffix in &suffixes {
        if result.ends_with(suffix) {
            result = result[..result.len() - suffix.len()].to_string();
            break;
        }
    }
    
    // Remove "The " prefix for certain series
    let lower_result = result.to_lowercase();
    let strip_the_prefix = [
        "the expanse", "the dresden files", "the dark tower", "the hunger games",
        "the first law", "the kingkiller chronicle", "the vampire chronicles",
    ];
    if strip_the_prefix.iter().any(|s| lower_result == *s) {
        if result.to_lowercase().starts_with("the ") {
            result = result[4..].to_string();
        }
    }
    
    result
}

/// Validate and clean genres
fn validate_genres(genres: &[String]) -> Vec<String> {
    let invalid = [
        "audiobook", "audio book", "book", "ebook", "e-book",
        "fiction", "nonfiction", "non-fiction", // Too generic
        "unabridged", "abridged",
    ];

    genres
        .iter()
        .filter(|g| {
            let lower = g.to_lowercase();
            !invalid.iter().any(|inv| lower == *inv)
        })
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .take(5)
        .collect()
}

/// Clean HTML and formatting from description
fn clean_description(desc: &str) -> String {
    let mut clean = desc.to_string();

    // Remove HTML tags
    let tag_re = regex::Regex::new(r"<[^>]+>").unwrap();
    clean = tag_re.replace_all(&clean, "").to_string();

    // Fix common HTML entities
    clean = clean
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");

    // Normalize whitespace
    let ws_re = regex::Regex::new(r"\s+").unwrap();
    clean = ws_re.replace_all(&clean, " ").trim().to_string();

    clean
}

/// Check if year is valid
fn is_valid_year(year: &str) -> bool {
    year.parse::<u32>()
        .map(|y| y >= 1400 && y <= 2100)
        .unwrap_or(false)
}

/// Check if sequence is valid format
fn is_valid_sequence(seq: &str) -> bool {
    let trimmed = seq.trim();

    // Pure number
    if trimmed.parse::<f64>().is_ok() {
        return true;
    }

    // Range like "1-2" or "1,2"
    if trimmed.contains('-') || trimmed.contains(',') {
        let parts: Vec<&str> = trimmed.split(&['-', ','][..]).collect();
        return parts.iter().all(|p| p.trim().parse::<f64>().is_ok());
    }

    false
}

/// Try to extract a number from a sequence string
fn extract_sequence_number(seq: &str) -> Option<String> {
    let num_re = regex::Regex::new(r"(\d+(?:\.\d+)?)").unwrap();
    num_re
        .captures(seq)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Normalize string for comparison
fn normalize_for_comparison(s: &str) -> String {
    s.to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && !c.is_whitespace(), "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Check if series name looks like an adaptation/retelling series
fn is_adaptation_series(series_name: &str, book_title: &str) -> bool {
    let lower = series_name.to_lowercase();
    let title_lower = book_title.to_lowercase();

    // Adaptation indicators in series name
    let adaptation_words = [
        "stories", "tales", "graphic", "illustrated", "retelling", "retellings",
        "adaptation", "adaptations", "children's", "childrens", "kids",
        "young readers", "classics illustrated", "manga", "comic",
        "easy reader", "picture book", "board book",
        "made easy", "simplified", "abridged", "for kids", "for children",
        "study guide", "cliffsnotes", "sparknotes", "reader's digest",
    ];

    let has_adaptation_word = adaptation_words.iter().any(|w| lower.contains(w));

    if !has_adaptation_word {
        return false;
    }

    // Check if series name contains classic author name
    let classic_authors = [
        "shakespeare", "dickens", "austen", "twain", "homer", "virgil",
        "tolstoy", "dostoevsky", "chaucer", "milton", "dante", "cervantes",
        "bronte", "hardy", "eliot", "joyce", "woolf", "hemingway",
    ];

    for author in &classic_authors {
        if lower.contains(author) && has_adaptation_word {
            return true;
        }
    }

    // Generic adaptation series
    let generic_adaptation_series = [
        "classic starts", "great illustrated classics", "illustrated classics",
        "graphic classics", "manga classics", "classical comics",
        "campfire graphic novels", "graphic revolve", "barron's graphic classics",
        "classic tales", "fairy tales", "folk tales",
    ];

    if generic_adaptation_series.iter().any(|s| lower.contains(s)) {
        return true;
    }

    // If series contains title word + adaptation word
    let title_words: Vec<&str> = title_lower.split_whitespace().collect();
    if let Some(first_word) = title_words.first() {
        if (lower.starts_with("graphic ") && lower.contains(first_word)) ||
           (lower.ends_with(" stories") && lower.contains(first_word)) ||
           (lower.ends_with(" tales") && lower.contains(first_word)) {
            return true;
        }
    }

    // Generic patterns: "[Word] Stories", "[Word] Tales" where word is short
    if (lower.ends_with(" stories") || lower.ends_with(" tales")) && lower.split_whitespace().count() <= 2 {
        return true;
    }

    false
}

/// Check if series name appears to be in a foreign language
fn is_foreign_language_series(name: &str) -> bool {
    let lower = name.to_lowercase();
    
    // Turkish patterns
    let turkish_patterns = [
        "dizisi", "serisi", "kitaplari", "romani", "öyküleri",
        "hikayeleri", "koleksiyonu", "külliyati",
    ];
    
    // German patterns
    let german_patterns = [
        "reihe", "sammlung", "bücher", "romane", "geschichten",
        "erzählungen", "taschenbücher", "ausgabe",
    ];
    
    // French patterns
    let french_patterns = [
        "série", "collection", "romans", "histoires", "contes",
        "bibliothèque", "édition", "petits meurtres",
    ];
    
    // Spanish patterns
    let spanish_patterns = [
        "serie", "colección", "novelas", "historias", "cuentos",
        "biblioteca", "edición",
    ];
    
    // Check all patterns
    turkish_patterns.iter().any(|p| lower.contains(p)) ||
    german_patterns.iter().any(|p| lower.contains(p)) ||
    french_patterns.iter().any(|p| lower.contains(p)) ||
    spanish_patterns.iter().any(|p| lower.contains(p))
}

/// Check if series name looks like a person's name
fn is_person_name_series(name: &str) -> bool {
    let words: Vec<&str> = name.split_whitespace().collect();

    // Skip if has series-like words
    let series_indicators = [
        "series", "chronicles", "saga", "trilogy", "collection",
        "adventures", "mysteries", "stories", "files", "novels",
        "inspector", "detective", "agent", "captain", "dr.", "doctor",
    ];
    if series_indicators.iter().any(|s| name.to_lowercase().contains(s)) {
        return false;
    }

    // Two-word names like "First Last" are suspicious
    if words.len() == 2 {
        let first = words[0].to_lowercase();
        let second = words[1];

        let common_first_names = [
            "james", "john", "mary", "anne", "peter", "paul", "david", "michael",
            "robert", "william", "richard", "thomas", "charles", "george", "edward",
            "elizabeth", "margaret", "jennifer", "susan", "patricia", "linda", "barbara",
            "audrey", "don", "eric", "mo", "sandra", "roald", "beverly",
            "leo", "jan", "arnold", "tomie", "ezra", "kevin", "maurice",
            "ludwig", "bernard", "russell", "mercer", "syd", "judi", "judith",
            "peggy", "wanda", "kathi", "simms", "iza", "sam", "joyce",
            "stephanie", "nadine", "paul", "rosemary", "marjorie", "bill",
        ];

        if common_first_names.iter().any(|n| first.starts_with(n)) && second.len() > 2 {
            return true;
        }
    }

    // Three-word patterns like "First and Last"
    if words.len() == 3 && words[1].to_lowercase() == "and" {
        return true;
    }

    false
}

/// Dynamic check if series matches author name (not in static list)
fn is_author_as_series_dynamic(series_lower: &str, author_lower: &str) -> bool {
    if author_lower.is_empty() {
        return false;
    }

    let series_normalized = series_lower
        .replace("dr.", "dr")
        .replace(".", "")
        .replace(",", "")
        .trim()
        .to_string();

    let author_normalized = author_lower
        .replace("dr.", "dr")
        .replace(".", "")
        .replace(",", "")
        .trim()
        .to_string();

    // Direct match
    if series_normalized == author_normalized {
        return true;
    }

    // Check if series is author's last name only
    let author_parts: Vec<&str> = author_normalized.split_whitespace().collect();
    if author_parts.len() >= 2 {
        if let Some(last_name) = author_parts.last() {
            if series_normalized == *last_name {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::types::{SourceData, SeriesEntry};

    fn make_original(title: &str, author: &str) -> AggregatedBookData {
        AggregatedBookData {
            id: "test".to_string(),
            sources: vec![SourceData {
                source: "test".to_string(),
                confidence: 90,
                title: Some(title.to_string()),
                authors: vec![author.to_string()],
                ..Default::default()
            }],
            series_context: vec![],
        }
    }

    #[test]
    fn test_validate_title_removes_artifacts() {
        let original = make_original("Test Book", "Author");
        let mut warnings = vec![];

        let result = validate_title("Test Book [Unabridged]", &original, &mut warnings);
        assert_eq!(result, "Test Book");
        assert!(!warnings.is_empty());
    }

    #[test]
    fn test_validate_author_uses_lookup() {
        let original = make_original("Book", "Original Author");
        let mut warnings = vec![];

        // "pimsleur" is in INVALID_AUTHORS
        let result = validate_author("Pimsleur", &[], &original, &mut warnings);
        assert_eq!(result, "Original Author");
    }

    #[test]
    fn test_normalize_author() {
        assert_eq!(normalize_author("j.k. rowling"), "J. K. Rowling");
        assert_eq!(normalize_author("jo nesbo"), "Jo Nesbø");
        assert_eq!(normalize_author("dr seuss"), "Dr. Seuss");
        assert_eq!(normalize_author("Unknown Author"), "Unknown Author"); // Not in table
    }

    #[test]
    fn test_normalize_series_name() {
        assert_eq!(normalize_series_name("Charlotte & Thomas Pitt"), "Thomas Pitt");
        assert_eq!(normalize_series_name("Chief Inspector Armand Gamache"), "Inspector Gamache");
        assert_eq!(normalize_series_name("The Dresden Files"), "Dresden Files");
        assert_eq!(normalize_series_name("Discworld - Death"), "Discworld");
        assert_eq!(normalize_series_name("Magic Tree House Merlin Missions"), "Magic Tree House: Merlin Missions");
        assert_eq!(normalize_series_name("Unknown Series"), "Unknown Series"); // Pass through
    }

    #[test]
    fn test_validate_series_rejects_invalid() {
        let original = make_original("Test Book", "Test Author");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Memoir".to_string(), // In INVALID_SERIES
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Test Author", "Test Book", &original, &mut warnings);
        assert!(result.is_empty());
        assert!(warnings.iter().any(|w| w.contains("INVALID_SERIES")));
    }

    #[test]
    fn test_validate_series_rejects_author_as_series() {
        let original = make_original("The Cat in the Hat", "Dr. Seuss");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Dr. Seuss".to_string(), // In AUTHOR_AS_SERIES
                sequence: None,
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Dr. Seuss", "The Cat in the Hat", &original, &mut warnings);
        assert!(result.is_empty());
        assert!(warnings.iter().any(|w| w.contains("AUTHOR_AS_SERIES")));
    }

    #[test]
    fn test_validate_series_rejects_wrong_author() {
        let original = make_original("Dark Places", "Gillian Flynn");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Inspector Banks".to_string(), // Owned by Peter Robinson
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Gillian Flynn", "Dark Places", &original, &mut warnings);
        assert!(result.is_empty());
        assert!(warnings.iter().any(|w| w.contains("wrong author")));
    }

    #[test]
    fn test_validate_series_allows_correct_author() {
        let original = make_original("Dry Bones That Dream", "Peter Robinson");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Inspector Banks".to_string(),
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Peter Robinson", "Dry Bones That Dream", &original, &mut warnings);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Inspector Banks");
    }

    #[test]
    fn test_validate_series_normalizes() {
        let original = make_original("Still Life", "Louise Penny");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Chief Inspector Armand Gamache".to_string(),
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Louise Penny", "Still Life", &original, &mut warnings);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Inspector Gamache"); // Normalized!
    }

    #[test]
    fn test_validate_series_rejects_discworld_orphan() {
        let original = make_original("Mort", "Terry Pratchett");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Death".to_string(), // Orphan subseries
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Terry Pratchett", "Mort", &original, &mut warnings);
        assert!(result.is_empty());
        assert!(warnings.iter().any(|w| w.contains("orphan Discworld")));
    }

    #[test]
    fn test_validate_series_allows_discworld_combined() {
        let original = make_original("Mort", "Terry Pratchett");
        let mut warnings = vec![];

        let series = vec![
            ResolvedSeries {
                name: "Discworld - Death".to_string(), // Combined is OK
                sequence: Some("1".to_string()),
                is_primary: true,
                is_subseries_of: None,
            },
        ];

        let result = validate_series(&series, "Terry Pratchett", "Mort", &original, &mut warnings);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "Discworld"); // Normalized
    }

    #[test]
    fn test_is_foreign_language_series() {
        assert!(is_foreign_language_series("Tiyatro Dizisi"));
        assert!(is_foreign_language_series("Fischer Taschenbücher"));
        assert!(is_foreign_language_series("Petits Meurtres"));
        assert!(!is_foreign_language_series("Inspector Banks"));
        assert!(!is_foreign_language_series("Harry Potter"));
    }

    #[test]
    fn test_is_adaptation_series() {
        assert!(is_adaptation_series("Shakespeare Stories", "Hamlet"));
        assert!(is_adaptation_series("Graphic Shakespeare", "Macbeth"));
        assert!(is_adaptation_series("Classic Tales", "Romeo and Juliet"));
        assert!(!is_adaptation_series("Discworld", "Mort"));
        assert!(!is_adaptation_series("Harry Potter", "Philosopher's Stone"));
    }

    #[test]
    fn test_is_valid_sequence() {
        assert!(is_valid_sequence("1"));
        assert!(is_valid_sequence("2.5"));
        assert!(is_valid_sequence("10"));
        assert!(is_valid_sequence("1-2"));
        assert!(!is_valid_sequence("Book 1"));
        assert!(!is_valid_sequence("Volume Two"));
    }

    #[test]
    fn test_extract_sequence_number() {
        assert_eq!(extract_sequence_number("Book 1"), Some("1".to_string()));
        assert_eq!(extract_sequence_number("Volume 2.5"), Some("2.5".to_string()));
        assert_eq!(extract_sequence_number("Part 10"), Some("10".to_string()));
        assert_eq!(extract_sequence_number("One"), None);
    }

    #[test]
    fn test_validate_genres() {
        let genres = vec![
            "Fantasy".to_string(),
            "Audiobook".to_string(), // Should be removed
            "Adventure".to_string(),
            "Fiction".to_string(), // Should be removed
        ];

        let result = validate_genres(&genres);
        assert_eq!(result, vec!["Fantasy", "Adventure"]);
    }

    #[test]
    fn test_is_valid_year() {
        assert!(is_valid_year("2023"));
        assert!(is_valid_year("1999"));
        assert!(is_valid_year("1800"));
        assert!(!is_valid_year("999"));
        assert!(!is_valid_year("2200"));
        assert!(!is_valid_year("not a year"));
    }
}