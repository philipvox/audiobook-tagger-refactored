use std::path::{Path, PathBuf};
use std::fs;
use anyhow::{Result, Context};
use serde::{Serialize, Deserialize};
use regex::Regex;

#[derive(Debug, Serialize, Deserialize)]
pub struct RenameResult {
    pub old_path: String,
    pub new_path: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BookMetadata {
    pub title: String,
    pub author: String,
    pub series: Option<String>,
    pub sequence: Option<String>,
    pub year: Option<String>,
    pub narrator: Option<String>,
}

/// Default rename templates
pub const DEFAULT_FILE_TEMPLATE: &str = "{author} - {[series #sequence] }{title}{ (year)}";
pub const DEFAULT_FOLDER_TEMPLATE: &str = "{author}/{series|title}";

/// Sanitize a string for use in a filename
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            '\0' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Apply a template to generate a filename
///
/// Template syntax:
/// - {author} - Replaced with author name
/// - {title} - Replaced with title
/// - {series} - Replaced with series name (empty if none)
/// - {sequence} - Replaced with book number (empty if none)
/// - {year} - Replaced with year (empty if none)
/// - {narrator} - Replaced with narrator (empty if none)
/// - {[prefix text] } - Include prefix only if following variable exists
/// - { (suffix)} - Include suffix only if preceding variable exists
/// - {var1|var2} - Fallback: use var1 if available, otherwise var2
pub fn apply_template(template: &str, metadata: &BookMetadata) -> String {
    let mut result = template.to_string();

    // First, handle conditional sections with {[prefix]variable} pattern
    // e.g., {[series #sequence] } becomes "[Series #1] " if series exists, "" otherwise
    let conditional_re = Regex::new(r"\{(\[[^\]]+\])([a-z]+)\s*\}").unwrap();
    result = conditional_re.replace_all(&result, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let var_name = &caps[2];
        let value = get_metadata_value(metadata, var_name);
        if value.is_empty() {
            String::new()
        } else {
            // Replace placeholders in prefix
            let mut expanded = prefix.to_string();
            expanded = expanded.replace("series", &get_metadata_value(metadata, "series"));
            expanded = expanded.replace("sequence", &get_metadata_value(metadata, "sequence"));
            format!("{} ", expanded)
        }
    }).to_string();

    // Handle suffix conditionals like { (year)}
    let suffix_re = Regex::new(r"\{\s*\(([a-z]+)\)\}").unwrap();
    result = suffix_re.replace_all(&result, |caps: &regex::Captures| {
        let var_name = &caps[1];
        let value = get_metadata_value(metadata, var_name);
        if value.is_empty() {
            String::new()
        } else {
            format!(" ({})", value)
        }
    }).to_string();

    // Handle fallback syntax {var1|var2}
    let fallback_re = Regex::new(r"\{([a-z]+)\|([a-z]+)\}").unwrap();
    result = fallback_re.replace_all(&result, |caps: &regex::Captures| {
        let var1 = get_metadata_value(metadata, &caps[1]);
        let var2 = get_metadata_value(metadata, &caps[2]);
        if !var1.is_empty() {
            var1
        } else {
            var2
        }
    }).to_string();

    // Handle simple variable replacements {author}, {title}, etc.
    let simple_re = Regex::new(r"\{([a-z]+)\}").unwrap();
    result = simple_re.replace_all(&result, |caps: &regex::Captures| {
        get_metadata_value(metadata, &caps[1])
    }).to_string();

    // Clean up multiple spaces and trim
    let multi_space_re = Regex::new(r"\s{2,}").unwrap();
    result = multi_space_re.replace_all(&result, " ").trim().to_string();

    // Remove trailing dashes or hyphens from empty sections
    let trailing_dash_re = Regex::new(r"\s*-\s*$").unwrap();
    result = trailing_dash_re.replace_all(&result, "").to_string();
    let leading_dash_re = Regex::new(r"^\s*-\s*").unwrap();
    result = leading_dash_re.replace_all(&result, "").to_string();
    let double_dash_re = Regex::new(r"\s*-\s*-\s*").unwrap();
    result = double_dash_re.replace_all(&result, " - ").to_string();

    sanitize_filename(&result)
}

fn get_metadata_value(metadata: &BookMetadata, var_name: &str) -> String {
    match var_name {
        "author" => metadata.author.clone(),
        "title" => metadata.title.clone(),
        "series" => metadata.series.clone().unwrap_or_default(),
        "sequence" => metadata.sequence.clone().unwrap_or_default(),
        "year" => metadata.year.clone().unwrap_or_default(),
        "narrator" => metadata.narrator.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

/// Generate a new filename based on metadata (uses default template)
pub fn generate_filename(metadata: &BookMetadata, original_extension: &str) -> String {
    generate_filename_with_template(metadata, original_extension, DEFAULT_FILE_TEMPLATE)
}

/// Generate a new filename based on metadata and a custom template
pub fn generate_filename_with_template(metadata: &BookMetadata, original_extension: &str, template: &str) -> String {
    let filename = apply_template(template, metadata);
    format!("{}.{}", filename, original_extension)
}

/// Generate a new folder structure based on metadata
pub fn generate_folder_structure(
    library_root: &Path,
    metadata: &BookMetadata,
) -> PathBuf {
    let author = sanitize_filename(&metadata.author);
    
    let mut path = library_root.to_path_buf();
    path.push(&author);
    
    // If it's part of a series, create a series subfolder
    if let Some(series) = &metadata.series {
        path.push(sanitize_filename(series));
    }
    
    path
}

/// Rename a single file and optionally reorganize it
pub async fn rename_and_reorganize_file(
    file_path: &str,
    metadata: &BookMetadata,
    reorganize: bool,
    library_root: Option<&str>,
    template: Option<&str>,
) -> Result<RenameResult> {
    let old_path = Path::new(file_path);

    if !old_path.exists() {
        return Ok(RenameResult {
            old_path: file_path.to_string(),
            new_path: file_path.to_string(),
            success: false,
            error: Some("File does not exist".to_string()),
        });
    }

    let extension = old_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4b");

    // Generate new filename
    let new_filename = match template {
        Some(t) => generate_filename_with_template(metadata, extension, t),
        None => generate_filename(metadata, extension),
    };
    
    // Determine new path
    let new_path = if reorganize && library_root.is_some() {
        // Reorganize into author/series structure
        let root = Path::new(library_root.unwrap());
        let folder = generate_folder_structure(root, metadata);
        
        // Create folder structure if it doesn't exist
        fs::create_dir_all(&folder)
            .context("Failed to create directory structure")?;
        
        folder.join(&new_filename)
    } else {
        // Just rename in the same directory
        old_path.with_file_name(&new_filename)
    };
    
    // Check if target already exists
    if new_path.exists() && new_path != old_path {
        return Ok(RenameResult {
            old_path: file_path.to_string(),
            new_path: new_path.display().to_string(),
            success: false,
            error: Some("Target file already exists".to_string()),
        });
    }
    
    // Perform the rename/move
    fs::rename(old_path, &new_path)
        .context("Failed to rename file")?;
    
    println!("✅ Renamed: {} -> {}", 
        old_path.display(), 
        new_path.display()
    );
    
    Ok(RenameResult {
        old_path: file_path.to_string(),
        new_path: new_path.display().to_string(),
        success: true,
        error: None,
    })
}

/// Rename all files in a book group
pub async fn rename_book_group(
    files: &[String],
    metadata: &BookMetadata,
    reorganize: bool,
    library_root: Option<&str>,
    template: Option<&str>,
) -> Result<Vec<RenameResult>> {
    let mut results = Vec::new();

    for (idx, file_path) in files.iter().enumerate() {
        let old_path = Path::new(file_path);
        let _extension = old_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("m4b");

        // For multi-file books, add part number
        let mut file_metadata = metadata.clone();
        if files.len() > 1 {
            file_metadata.title = format!("{} - Part {}", metadata.title, idx + 1);
        }

        let result = rename_and_reorganize_file(
            file_path,
            &file_metadata,
            reorganize,
            library_root,
            template,
        ).await;
        
        match result {
            Ok(r) => results.push(r),
            Err(e) => results.push(RenameResult {
                old_path: file_path.to_string(),
                new_path: file_path.to_string(),
                success: false,
                error: Some(e.to_string()),
            }),
        }
    }
    
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("Book: Part 1"), "Book_ Part 1");
        assert_eq!(sanitize_filename("Book/Part\\2"), "Book_Part_2");
        assert_eq!(sanitize_filename("Book<Test>"), "Book_Test_");
    }
    
    #[test]
    fn test_generate_filename() {
        let metadata = BookMetadata {
            title: "The Fellowship of the Ring".to_string(),
            author: "J.R.R. Tolkien".to_string(),
            series: Some("The Lord of the Rings".to_string()),
            sequence: Some("1".to_string()),
            year: Some("1954".to_string()),
        };
        
        let filename = generate_filename(&metadata, "m4b");
        assert_eq!(
            filename,
            "J.R.R. Tolkien - [The Lord of the Rings #1] - The Fellowship of the Ring - (1954).m4b"
        );
    }
    
    #[test]
    fn test_generate_filename_no_series() {
        let metadata = BookMetadata {
            title: "1984".to_string(),
            author: "George Orwell".to_string(),
            series: None,
            sequence: None,
            year: Some("1949".to_string()),
        };
        
        let filename = generate_filename(&metadata, "m4b");
        assert_eq!(filename, "George Orwell - 1984 - (1949).m4b");
    }
}