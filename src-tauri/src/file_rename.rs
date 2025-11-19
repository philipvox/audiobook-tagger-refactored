use std::path::{Path, PathBuf};
use std::fs;
use anyhow::{Result, Context};
use serde::{Serialize, Deserialize};

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
}

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

/// Generate a new filename based on metadata
pub fn generate_filename(metadata: &BookMetadata, original_extension: &str) -> String {
    let mut parts = Vec::new();
    
    // Add author
    if !metadata.author.is_empty() {
        parts.push(sanitize_filename(&metadata.author));
    }
    
    // Add series and sequence if present
    if let Some(series) = &metadata.series {
        let mut series_part = format!("[{}]", sanitize_filename(series));
        if let Some(seq) = &metadata.sequence {
            series_part = format!("[{} #{}]", sanitize_filename(series), seq);
        }
        parts.push(series_part);
    }
    
    // Add title
    parts.push(sanitize_filename(&metadata.title));
    
    // Add year if present
    if let Some(year) = &metadata.year {
        parts.push(format!("({})", year));
    }
    
    // Join parts and add extension
    let filename = parts.join(" - ");
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
    let new_filename = generate_filename(metadata, extension);
    
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