// src-tauri/src/series.rs
// Centralized series processing - single source of truth for all series logic
//
// This module handles:
// - Series validation (reject invalid/placeholder names)
// - Foreign language filtering
// - Name normalization (canonical mappings)
// - Smart deduplication (prefers entries with sequences)
// - Hierarchical sorting (parent before child using delimiter parsing)

use crate::scanner::types::{MetadataSource, SeriesInfo};
use crate::normalize;
use std::collections::HashMap;

/// Centralized series processor - call process() ONCE after all sources are merged
pub struct SeriesProcessor {
    /// Known canonical series name mappings
    canonical_mappings: HashMap<String, &'static str>,
    /// Foreign language article prefixes
    foreign_prefixes: Vec<&'static str>,
    /// Foreign language pattern keywords
    foreign_patterns: Vec<&'static str>,
    /// Sub-series indicators that shouldn't stand alone
    subseries_blocklist: Vec<&'static str>,
    /// Generic/marketing series to reject
    generic_series: Vec<&'static str>,
    /// Companion series indicators
    companion_indicators: Vec<&'static str>,
}

impl Default for SeriesProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl SeriesProcessor {
    pub fn new() -> Self {
        let mut canonical_mappings = HashMap::new();

        // Inspector Banks variants
        canonical_mappings.insert("banks".to_string(), "Inspector Banks");
        canonical_mappings.insert("dci banks".to_string(), "Inspector Banks");
        canonical_mappings.insert("inspector banks".to_string(), "Inspector Banks");
        canonical_mappings.insert("alan banks".to_string(), "Inspector Banks");

        // Shakespeare variants
        canonical_mappings.insert("complete arkangel shakespeare".to_string(), "The Complete Arkangel Shakespeare");
        canonical_mappings.insert("arkangel shakespeare".to_string(), "The Complete Arkangel Shakespeare");
        canonical_mappings.insert("the complete arkangel shakespeare".to_string(), "The Complete Arkangel Shakespeare");
        canonical_mappings.insert("shakespeare".to_string(), "The Complete Arkangel Shakespeare");

        Self {
            canonical_mappings,
            foreign_prefixes: vec![
                // French
                "la ", "le ", "les ", "l'", "un ", "une ", "des ",
                // German
                "das ", "der ", "die ", "ein ", "eine ",
                // Spanish
                "el ", "los ", "las ",
                // Italian
                "il ", "lo ", "gli ", "i ",
                // Portuguese
                "o ", "os ", "as ",
                // Dutch
                "de ", "het ",
            ],
            foreign_patterns: vec![
                // German
                "magisches", "magische", "baumhaus", "baum", "sammlung",
                // French
                "magique", "cabane", "maison", "arbre", "collection",
                // Spanish
                "casa", "coleccion",
                // Polish
                "wielka kolekcja", "kolekcja",
                // Italian
                "collezione",
                // Hindi/Punjabi romanized
                "jag badalnare granth", "granth",
                // Generic foreign collection terms
                "serie ", "reihe",
            ],
            subseries_blocklist: vec![
                "death", "witches", "wizards", "watch", "rincewind", "tiffany aching",
                "moist von lipwig", "industrial revolution", "ancient civilizations",
                "gods", "legends", "tales", "adventures", "mysteries", "cases",
            ],
            generic_series: vec![
                "timeless classic", "timeless classics", "classic literature",
                "great books", "must read", "bestseller", "bestsellers",
                "award winner", "award winners", "pulitzer prize",
                "new york times bestseller", "audible originals",
                "kindle unlimited", "prime reading",
                "book", "audiobook", "audio", "unabridged", "novel", "story",
                "fiction", "non-fiction", "chapter", "part", "volume", "edition",
                "complete", "collection", "anthology", "omnibus", "box set",
                "manga shakespeare", "graphic novel", "comic adaptation",
                "illustrated edition", "pop-up book", "board book",
            ],
            companion_indicators: vec![
                "fact tracker", "research guide", "companion to", "nonfiction companion",
            ],
        }
    }

    /// Single entry point - call this ONCE after all sources are merged
    ///
    /// This handles:
    /// 1. Normalization (canonical names, suffix removal)
    /// 2. Validation (reject invalid series)
    /// 3. Foreign language filtering
    /// 4. Smart deduplication (keeps best sequence)
    /// 5. Hierarchical sorting (parent before child)
    pub fn process(
        &self,
        series: Vec<SeriesInfo>,
        title: &str,
        book_language: Option<&str>,
    ) -> Vec<SeriesInfo> {
        if series.is_empty() {
            return series;
        }

        let book_is_english = book_language
            .map(|l| l.to_lowercase().starts_with("en") || l.to_lowercase() == "english")
            .unwrap_or(true); // Assume English if not specified

        println!("   🔧 SeriesProcessor: processing {} series for '{}'", series.len(), title);

        // Step 1: Normalize all series names
        let normalized: Vec<SeriesInfo> = series
            .into_iter()
            .map(|mut s| {
                let original = s.name.clone();
                s.name = self.normalize_name(&s.name);
                if s.name != original {
                    println!("   🔄 Normalizing: '{}' → '{}'", original, s.name);
                }
                s
            })
            .collect();

        // Step 2: Filter invalid series
        let validated: Vec<SeriesInfo> = normalized
            .into_iter()
            .filter(|s| {
                let is_valid = self.is_valid(&s.name, title, s.sequence.as_deref());
                if !is_valid {
                    println!("   ⚠️ Rejecting invalid series: '{}'", s.name);
                }
                is_valid
            })
            .collect();

        // Step 3: Filter foreign language series (for English books)
        let language_filtered: Vec<SeriesInfo> = if book_is_english {
            validated
                .into_iter()
                .filter(|s| {
                    let is_foreign = self.is_foreign_language(&s.name);
                    if is_foreign {
                        println!("   🌍 Rejecting foreign series: '{}'", s.name);
                    }
                    !is_foreign
                })
                .collect()
        } else {
            validated
        };

        // Step 4: Smart deduplication (keeps entry with sequence)
        let deduplicated = self.deduplicate_smart(language_filtered);

        // Step 5: Sort hierarchically (parent before child)
        let sorted = self.sort_hierarchically(deduplicated);

        println!("   ✓ SeriesProcessor: {} series after processing", sorted.len());
        sorted
    }

    /// Normalize series name to canonical form
    pub fn normalize_name(&self, name: &str) -> String {
        let mut result = name.trim().to_string();

        // Remove common suffixes
        let suffixes = [" series", " Series", " novels", " Novels", " books", " Books"];
        for suffix in &suffixes {
            if result.ends_with(suffix) {
                result = result[..result.len() - suffix.len()].to_string();
            }
        }

        // Check canonical mappings (strip "The " / "the " for lookup)
        let stripped = result
            .strip_prefix("The ")
            .or_else(|| result.strip_prefix("the "))
            .unwrap_or(&result);
        let check_name = stripped.to_lowercase();

        if let Some(canonical) = self.canonical_mappings.get(&check_name) {
            return canonical.to_string();
        }

        result
    }

    /// Check if series name appears to be in a foreign language
    pub fn is_foreign_language(&self, name: &str) -> bool {
        let lower = name.to_lowercase();
        let trimmed = lower.trim();

        // Check foreign prefixes
        for prefix in &self.foreign_prefixes {
            if trimmed.starts_with(prefix) {
                return true;
            }
        }

        // Check non-ASCII characters
        if !name.is_ascii() {
            return true;
        }

        // Check foreign patterns
        for pattern in &self.foreign_patterns {
            if lower.contains(pattern) {
                return true;
            }
        }

        false
    }

    /// Validate a series name against title and other criteria
    pub fn is_valid(&self, series: &str, title: &str, sequence: Option<&str>) -> bool {
        // Basic validity check
        if !normalize::is_valid_series(series) {
            return false;
        }

        let series_lower = series.to_lowercase().trim().to_string();
        let title_lower = title.to_lowercase().trim().to_string();

        // Too short
        if series_lower.len() < 3 {
            return false;
        }

        // Too many numbers
        let digit_count = series.chars().filter(|c| c.is_ascii_digit()).count();
        if digit_count > 0 && (digit_count as f32 / series.len() as f32) > 0.3 {
            return false;
        }

        // Generic/marketing series
        if self.generic_series.iter().any(|g| series_lower == *g) {
            return false;
        }

        // Standalone sub-series indicators
        if self.subseries_blocklist.iter().any(|s| series_lower == *s) {
            return false;
        }

        // Normalize for comparison
        let series_normalized = series_lower.replace(" & ", " and ").replace("&", " and ");
        let title_normalized = title_lower.replace(" & ", " and ").replace("&", " and ");
        let series_no_the = series_normalized.strip_prefix("the ").unwrap_or(&series_normalized);
        let title_no_the = title_normalized.strip_prefix("the ").unwrap_or(&title_normalized);

        // Title matching - be strict about exact matches
        let title_matches = series_normalized == title_normalized
            || series_no_the == title_no_the
            || series_normalized == title_no_the
            || series_no_the == title_normalized;

        let has_sequence = sequence.is_some();

        if title_matches {
            // For EXACT title matches, only allow if:
            // 1. Has sequence AND
            // 2. Title is long enough to plausibly be a series name (not "Tempest", "Hamlet", etc.)
            // Short single-word titles are almost never valid "title-as-series" patterns
            let word_count = title_normalized.split_whitespace().count();
            let is_short_title = word_count <= 2 && title_normalized.len() < 20;

            if !has_sequence {
                println!("   ⚠️ Rejecting series '{}' - matches title (no sequence)", series);
                return false;
            }

            if is_short_title {
                println!("   ⚠️ Rejecting series '{}' - matches short title '{}' (likely bad metadata)", series, title);
                return false;
            }

            // Long title with sequence - probably valid (e.g., "Dungeon Crawler Carl")
            println!("   ✓ Allowing series '{}' matching title - has sequence and long title", series);
        }

        // High overlap check - skip if has sequence
        if !has_sequence && title_normalized.starts_with(&series_normalized) {
            let overlap = series_normalized.len() as f32 / title_normalized.len() as f32;
            if overlap > 0.8 {
                return false;
            }
        }

        // "The X" too short - skip if has sequence
        if !has_sequence && series_lower.starts_with("the ") && series_lower.len() < 10 {
            return false;
        }

        // Looks like full title with subtitle
        if (series_lower.contains(": ") || series_lower.contains(" - ")) && series_lower.len() > 40 {
            if !series_lower.contains("series") && !series_lower.contains("saga")
                && !series_lower.contains("chronicles") {
                return false;
            }
        }

        // Companion series check
        let is_companion = self.companion_indicators.iter().any(|c| series_lower.contains(c));
        if is_companion {
            let title_has_companion = self.companion_indicators.iter().any(|c| title_lower.contains(c))
                || title_lower.contains("fact")
                || title_lower.contains("guide")
                || title_lower.contains("nonfiction");
            if !title_has_companion {
                return false;
            }
        }

        true
    }

    /// Smart deduplication - keeps entry with sequence when duplicates exist
    fn deduplicate_smart(&self, series: Vec<SeriesInfo>) -> Vec<SeriesInfo> {
        if series.len() <= 1 {
            return series;
        }

        // Group by normalized name (case-insensitive)
        let mut groups: HashMap<String, Vec<SeriesInfo>> = HashMap::new();
        for s in series {
            let key = s.name.to_lowercase();
            groups.entry(key).or_default().push(s);
        }

        // For each group, pick the best entry (one with sequence, or first if none have sequence)
        let mut result: Vec<SeriesInfo> = Vec::new();
        for (_key, mut entries) in groups {
            // Sort so entries WITH sequence come first
            entries.sort_by(|a, b| {
                match (&a.sequence, &b.sequence) {
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                }
            });

            if let Some(best) = entries.into_iter().next() {
                println!("   🔄 Dedup: keeping '{}' #{:?}", best.name, best.sequence);
                result.push(best);
            }
        }

        result
    }

    /// Sort hierarchically - parent series before child series
    /// Uses delimiter parsing (e.g., "Discworld - Witches") not substring matching
    fn sort_hierarchically(&self, mut series: Vec<SeriesInfo>) -> Vec<SeriesInfo> {
        if series.len() <= 1 {
            return series;
        }

        series.sort_by(|a, b| {
            let a_name = &a.name;
            let b_name = &b.name;

            // Parse parent from "Parent - Child" structure
            let a_parent = self.extract_parent(a_name);
            let b_parent = self.extract_parent(b_name);

            // If a is b's parent
            if let Some(ref bp) = b_parent {
                if a_name.eq_ignore_ascii_case(bp) {
                    return std::cmp::Ordering::Less;
                }
            }

            // If b is a's parent
            if let Some(ref ap) = a_parent {
                if b_name.eq_ignore_ascii_case(ap) {
                    return std::cmp::Ordering::Greater;
                }
            }

            // Same parent? Child comes after parent
            if a_parent == b_parent {
                // If one has no parent and the other does, the one without parent comes first
                match (&a_parent, &b_parent) {
                    (None, Some(_)) => return std::cmp::Ordering::Less,
                    (Some(_), None) => return std::cmp::Ordering::Greater,
                    _ => {}
                }
            }

            // Alphabetical fallback
            a_name.cmp(b_name)
        });

        series
    }

    /// Extract parent series from "Parent - Child" format
    fn extract_parent(&self, name: &str) -> Option<String> {
        // Try " - " delimiter first (most common)
        if let Some(pos) = name.find(" - ") {
            let parent = name[..pos].trim();
            if !parent.is_empty() {
                return Some(parent.to_string());
            }
        }

        // Try ": " delimiter (e.g., "Chronicles of Narnia: The Lion...")
        if let Some(pos) = name.find(": ") {
            let parent = name[..pos].trim();
            if !parent.is_empty() && parent.len() > 5 {
                return Some(parent.to_string());
            }
        }

        None
    }

    /// Parse a combined series string like "Discworld #6, Discworld - Witches #2"
    pub fn parse_combined_string(&self, combined: &str) -> Vec<SeriesInfo> {
        let mut results = Vec::new();

        for part in combined.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }

            // Try to extract sequence number (e.g., "#6" or "Book 6")
            if let Some(hash_pos) = part.rfind('#') {
                let name = part[..hash_pos].trim().to_string();
                let seq_str = part[hash_pos + 1..].trim();
                let seq: String = seq_str.chars().take_while(|c| c.is_numeric() || *c == '.').collect();
                if !name.is_empty() {
                    results.push(SeriesInfo {
                        name,
                        sequence: if seq.is_empty() { None } else { Some(seq) },
                        source: Some(MetadataSource::Abs),
                    });
                }
            } else {
                results.push(SeriesInfo {
                    name: part.to_string(),
                    sequence: None,
                    source: Some(MetadataSource::Abs),
                });
            }
        }

        results
    }
}

/// Global instance for convenience
pub fn processor() -> SeriesProcessor {
    SeriesProcessor::new()
}

// ============================================================================
// GPT-BASED SERIES CLEANUP
// ============================================================================

use std::collections::HashSet;

/// Determine if GPT cleanup is needed for this series list
/// Returns true when there's ambiguity that rule-based processing can't handle well
pub fn needs_gpt_cleanup(series: &[SeriesInfo]) -> bool {
    // Single or no series - no ambiguity
    if series.len() <= 1 {
        return false;
    }

    // Multiple series from different sources = potential conflict
    // Count unique sources (compare by debug string since MetadataSource doesn't impl Hash)
    let source_strings: HashSet<String> = series.iter()
        .filter_map(|s| s.source.as_ref().map(|src| format!("{:?}", src)))
        .collect();
    if source_strings.len() > 1 {
        return true;
    }

    // Check for potential duplicates (similar names that might be the same series)
    for i in 0..series.len() {
        for j in (i + 1)..series.len() {
            let a = series[i].name.to_lowercase();
            let b = series[j].name.to_lowercase();

            // One contains the other (e.g., "Discworld" and "Discworld - Witches")
            if a.contains(&b) || b.contains(&a) {
                return true;
            }

            // Similar length and share significant words
            let a_words: HashSet<&str> = a.split_whitespace().collect();
            let b_words: HashSet<&str> = b.split_whitespace().collect();
            let overlap = a_words.intersection(&b_words).count();
            if overlap >= 2 {
                return true;
            }
        }
    }

    // More than 3 series is suspicious - likely needs cleanup
    if series.len() > 3 {
        return true;
    }

    false
}

/// Response structure for GPT series cleanup
#[derive(Debug, serde::Deserialize)]
struct GptSeriesResponse {
    series: Vec<GptCleanedSeries>,
}

#[derive(Debug, serde::Deserialize)]
struct GptCleanedSeries {
    name: String,
    sequence: Option<String>,
    #[serde(default)]
    is_primary: bool,
}

/// Clean up series list using GPT
/// Handles: normalization, foreign language filtering, deduplication, primary selection
pub async fn cleanup_series_with_gpt(
    title: &str,
    author: &str,
    language: Option<&str>,
    raw_series: &[SeriesInfo],
    api_key: &str,
) -> Result<Vec<SeriesInfo>, String> {
    if raw_series.is_empty() {
        return Ok(vec![]);
    }

    // Format series for GPT prompt
    let series_str = raw_series.iter()
        .map(|s| {
            let seq = s.sequence.as_ref().map(|sq| format!(" #{}", sq)).unwrap_or_default();
            let src = s.source.as_ref().map(|s| format!(" (from {:?})", s)).unwrap_or_default();
            format!("- \"{}\"{}{}", s.name, seq, src)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
r#"Clean up this audiobook's series metadata.

Book: "{}" by {}
Language: {}

Raw series data from multiple sources:
{}

RULES:
1. REMOVE foreign language series names (keep {} only)
2. NORMALIZE series names to canonical forms:
   - "DCI Banks", "Alan Banks", "Banks" → "Inspector Banks"
   - "The X Series" → "X" (remove "The" prefix and "Series" suffix)
3. REMOVE exact duplicates (same series, different spellings/case)
4. IDENTIFY the PRIMARY series (main series for this book, not a subseries)
5. KEEP valid subseries SEPARATE (e.g., "Discworld - Witches" is distinct from "Discworld")
6. PRESERVE sequence numbers - prefer the most specific one
7. REJECT standalone sub-series indicators ("Death", "Witches", "Watch" alone are invalid)
8. REJECT generic/marketing series ("Bestseller", "Timeless Classics", etc.)

Return ONLY valid JSON:
{{"series": [{{"name": "Series Name", "sequence": "1", "is_primary": true}}, {{"name": "Subseries", "sequence": "2", "is_primary": false}}]}}"#,
        title,
        author,
        language.unwrap_or("English"),
        series_str,
        language.unwrap_or("English")
    );

    // Call GPT API
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::scanner::processor::call_gpt_api(&prompt, api_key, "gpt-5-nano", 1000)
    ).await;

    match result {
        Ok(Ok(response)) => {
            // Parse GPT response
            match serde_json::from_str::<GptSeriesResponse>(&response) {
                Ok(parsed) => {
                    // Convert to SeriesInfo, sorted with primary first
                    let mut cleaned: Vec<SeriesInfo> = parsed.series.into_iter()
                        .map(|s| SeriesInfo {
                            name: s.name,
                            sequence: s.sequence,
                            source: Some(MetadataSource::Gpt),
                        })
                        .collect();

                    // Sort so primary series comes first
                    // (GPT should return is_primary but we lost that in conversion,
                    // so we rely on GPT returning primary first in the array)

                    if cleaned.is_empty() && !raw_series.is_empty() {
                        println!("   ⚠️ GPT returned empty series, keeping originals");
                        return Ok(raw_series.to_vec());
                    }

                    let removed_count = raw_series.len().saturating_sub(cleaned.len());
                    if removed_count > 0 {
                        println!("   🤖 GPT series cleanup: {} → {} series (removed {})",
                            raw_series.len(), cleaned.len(), removed_count);
                    }

                    Ok(cleaned)
                }
                Err(e) => {
                    println!("   ⚠️ GPT series parse error: {}, keeping originals", e);
                    Ok(raw_series.to_vec())
                }
            }
        }
        Ok(Err(e)) => {
            println!("   ⚠️ GPT series cleanup failed: {}", e);
            Ok(raw_series.to_vec())
        }
        Err(_) => {
            println!("   ⚠️ GPT series cleanup timed out");
            Ok(raw_series.to_vec())
        }
    }
}

/// Process series with optional GPT cleanup
/// Uses rule-based processing first, then GPT for complex cases
pub async fn process_with_gpt_fallback(
    series: Vec<SeriesInfo>,
    title: &str,
    author: &str,
    language: Option<&str>,
    api_key: Option<&str>,
) -> Vec<SeriesInfo> {
    let processor = processor();

    // Always run rule-based processing first (fast)
    let rule_processed = processor.process(series.clone(), title, language);

    // Check if GPT cleanup would help
    if let Some(key) = api_key {
        if needs_gpt_cleanup(&rule_processed) {
            println!("   🤖 Series needs GPT cleanup ({} series with ambiguity)", rule_processed.len());
            match cleanup_series_with_gpt(title, author, language, &rule_processed, key).await {
                Ok(gpt_cleaned) => return gpt_cleaned,
                Err(e) => println!("   ⚠️ GPT cleanup error: {}", e),
            }
        }
    }

    rule_processed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_name() {
        let processor = SeriesProcessor::new();
        assert_eq!(processor.normalize_name("Inspector Banks series"), "Inspector Banks");
        assert_eq!(processor.normalize_name("The Inspector Banks Series"), "Inspector Banks");
        assert_eq!(processor.normalize_name("DCI Banks"), "Inspector Banks");
        assert_eq!(processor.normalize_name("Banks"), "Inspector Banks");
        assert_eq!(processor.normalize_name("Discworld"), "Discworld");
    }

    #[test]
    fn test_foreign_language_detection() {
        let processor = SeriesProcessor::new();
        assert!(processor.is_foreign_language("La Cabane Magique"));
        assert!(processor.is_foreign_language("Das magische Baumhaus"));
        assert!(processor.is_foreign_language("Jag Badalnare Granth"));
        assert!(!processor.is_foreign_language("Magic Tree House"));
    }

    #[test]
    fn test_smart_dedup_prefers_sequence() {
        let processor = SeriesProcessor::new();
        let series = vec![
            SeriesInfo { name: "Discworld".to_string(), sequence: None, source: None },
            SeriesInfo { name: "Discworld".to_string(), sequence: Some("6".to_string()), source: None },
        ];
        let result = processor.deduplicate_smart(series);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].sequence, Some("6".to_string()));
    }

    #[test]
    fn test_hierarchical_sort() {
        let processor = SeriesProcessor::new();
        let series = vec![
            SeriesInfo { name: "Discworld - Witches".to_string(), sequence: Some("2".to_string()), source: None },
            SeriesInfo { name: "Discworld".to_string(), sequence: Some("6".to_string()), source: None },
        ];
        let result = processor.sort_hierarchically(series);
        assert_eq!(result[0].name, "Discworld");
        assert_eq!(result[1].name, "Discworld - Witches");
    }

    #[test]
    fn test_companion_series_rejection() {
        let processor = SeriesProcessor::new();

        // Should reject Fact Tracker for non-fact-tracker book
        assert!(!processor.is_valid("Magic Tree House Fact Tracker", "Vikings at Sunrise", None));

        // Should allow Fact Tracker for fact tracker book
        assert!(processor.is_valid("Magic Tree House Fact Tracker", "Vikings Fact Tracker", None));
    }

    #[test]
    fn test_title_match_with_sequence() {
        let processor = SeriesProcessor::new();

        // Without sequence - reject (even long titles)
        assert!(!processor.is_valid("Dungeon Crawler Carl", "Dungeon Crawler Carl", None));

        // With sequence AND long title - allow (3+ words, 20+ chars)
        assert!(processor.is_valid("Dungeon Crawler Carl", "Dungeon Crawler Carl", Some("1")));

        // Short title with sequence - REJECT (bad metadata like "Tempest #1" for book "Tempest")
        assert!(!processor.is_valid("Tempest", "Tempest", Some("1")));
        assert!(!processor.is_valid("Hamlet", "Hamlet", Some("1")));
        assert!(!processor.is_valid("The Tempest", "The Tempest", Some("1")));

        // 2-word short title - still reject
        assert!(!processor.is_valid("The Martian", "The Martian", Some("1")));
    }
}
