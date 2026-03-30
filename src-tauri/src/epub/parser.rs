//! EPUB parser implementation.
//!
//! EPUBs are ZIP archives containing:
//! - META-INF/container.xml - points to the root OPF file
//! - content.opf (or similar) - package document with metadata and spine
//! - toc.ncx or nav.xhtml - table of contents
//! - chapter files (XHTML/HTML)

use super::{EpubChapter, EpubContent, EpubMetadata, EpubPreview};
use anyhow::{bail, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use zip::ZipArchive;

/// Parse an EPUB file and extract all content
pub fn parse_epub(path: &str) -> Result<EpubContent> {
    let file = File::open(path).context("Failed to open EPUB file")?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader).context("Failed to read EPUB as ZIP")?;

    // 1. Find rootfile path from container.xml
    let rootfile_path = find_rootfile(&mut archive)?;
    let root_dir = Path::new(&rootfile_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // 2. Parse OPF to get metadata, spine order, and manifest
    let (metadata, spine, manifest) = parse_opf(&mut archive, &rootfile_path)?;

    // 3. Parse table of contents for chapter titles
    let toc = parse_toc(&mut archive, &manifest, &root_dir)?;

    // 4. Extract text from each spine item in order
    let mut chapters = Vec::new();
    let mut full_text = String::new();

    for (index, spine_id) in spine.iter().enumerate() {
        if let Some(href) = manifest.get(spine_id) {
            let full_path = resolve_path(&root_dir, href);

            let chapter_text = match extract_chapter_text(&mut archive, &full_path) {
                Ok(text) => text,
                Err(e) => {
                    log::warn!("Failed to extract chapter {}: {}", href, e);
                    continue;
                }
            };

            // Skip empty chapters
            if chapter_text.trim().is_empty() {
                continue;
            }

            // Find chapter title from TOC
            let title = toc
                .get(href)
                .or_else(|| toc.get(&full_path))
                .cloned()
                .unwrap_or_else(|| format!("Chapter {}", chapters.len() + 1));

            let start_char = full_text.len();

            // Add spacing between chapters
            if !full_text.is_empty() {
                full_text.push_str("\n\n");
            }
            full_text.push_str(&chapter_text);

            let end_char = full_text.len();

            chapters.push(EpubChapter::new(
                chapters.len(),
                title,
                href.clone(),
                chapter_text,
                start_char,
                end_char,
            ));
        }
    }

    Ok(EpubContent {
        metadata,
        chapters,
        full_text,
    })
}

/// Get a preview of an EPUB without full text extraction
pub fn preview_epub(path: &str) -> Result<EpubPreview> {
    let file = File::open(path).context("Failed to open EPUB file")?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader).context("Failed to read EPUB as ZIP")?;

    let rootfile_path = find_rootfile(&mut archive)?;
    let root_dir = Path::new(&rootfile_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let (metadata, spine, manifest) = parse_opf(&mut archive, &rootfile_path)?;
    let toc = parse_toc(&mut archive, &manifest, &root_dir)?;

    // Estimate word count from a sample
    let mut sample_words = 0;
    let mut sample_count = 0;

    for (_, spine_id) in spine.iter().enumerate().take(3) {
        if let Some(href) = manifest.get(spine_id) {
            let full_path = resolve_path(&root_dir, href);
            if let Ok(text) = extract_chapter_text(&mut archive, &full_path) {
                sample_words += text.split_whitespace().count();
                sample_count += 1;
            }
        }
    }

    let avg_words = if sample_count > 0 {
        sample_words / sample_count
    } else {
        5000 // Default estimate
    };
    let estimated_words = avg_words * spine.len();

    Ok(EpubPreview {
        path: path.to_string(),
        metadata,
        chapter_count: toc.len().max(spine.len()),
        estimated_words,
    })
}

/// Find the rootfile path from META-INF/container.xml
fn find_rootfile(archive: &mut ZipArchive<BufReader<File>>) -> Result<String> {
    let content = read_file_from_zip(archive, "META-INF/container.xml")?;

    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(ref e)) if e.name().as_ref() == b"rootfile" => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"full-path" {
                        return Ok(String::from_utf8_lossy(&attr.value).to_string());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error in container.xml: {}", e),
            _ => {}
        }
        buf.clear();
    }

    bail!("Could not find rootfile in container.xml")
}

/// Parse the OPF file to get metadata, spine order, and manifest
fn parse_opf(
    archive: &mut ZipArchive<BufReader<File>>,
    path: &str,
) -> Result<(EpubMetadata, Vec<String>, HashMap<String, String>)> {
    let content = read_file_from_zip(archive, path)?;

    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut metadata = EpubMetadata::default();
    let mut spine = Vec::new();
    let mut manifest = HashMap::new();

    let mut buf = Vec::new();
    let mut in_metadata = false;
    let mut current_element = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local_name = name.split(':').last().unwrap_or(&name);

                match local_name {
                    "metadata" => in_metadata = true,
                    "title" if in_metadata => current_element = "title".to_string(),
                    "creator" if in_metadata => current_element = "creator".to_string(),
                    "language" if in_metadata => current_element = "language".to_string(),
                    "identifier" if in_metadata => current_element = "identifier".to_string(),
                    "publisher" if in_metadata => current_element = "publisher".to_string(),
                    "description" if in_metadata => current_element = "description".to_string(),
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();

                match name.as_str() {
                    "item" => {
                        let mut id = String::new();
                        let mut href = String::new();

                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"id" => id = String::from_utf8_lossy(&attr.value).to_string(),
                                b"href" => href = String::from_utf8_lossy(&attr.value).to_string(),
                                _ => {}
                            }
                        }

                        if !id.is_empty() && !href.is_empty() {
                            manifest.insert(id, href);
                        }
                    }
                    "itemref" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"idref" {
                                spine.push(String::from_utf8_lossy(&attr.value).to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) if in_metadata && !current_element.is_empty() => {
                let text = e.unescape().unwrap_or_default().to_string();
                match current_element.as_str() {
                    "title" if metadata.title.is_none() => metadata.title = Some(text),
                    "creator" => metadata.authors.push(text),
                    "language" if metadata.language.is_none() => metadata.language = Some(text),
                    "identifier" if metadata.identifier.is_none() => metadata.identifier = Some(text),
                    "publisher" if metadata.publisher.is_none() => metadata.publisher = Some(text),
                    "description" if metadata.description.is_none() => metadata.description = Some(text),
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local_name = name.split(':').last().unwrap_or(&name);
                if local_name == "metadata" {
                    in_metadata = false;
                }
                current_element.clear();
            }
            Ok(Event::Eof) => break,
            Err(e) => bail!("XML parse error in OPF: {}", e),
            _ => {}
        }
        buf.clear();
    }

    Ok((metadata, spine, manifest))
}

/// Parse table of contents (NCX or NAV)
fn parse_toc(
    archive: &mut ZipArchive<BufReader<File>>,
    manifest: &HashMap<String, String>,
    root_dir: &str,
) -> Result<HashMap<String, String>> {
    let mut toc = HashMap::new();

    // Try to find NCX file
    for (id, href) in manifest {
        if href.ends_with(".ncx") {
            let full_path = resolve_path(root_dir, href);
            if let Ok(content) = read_file_from_zip(archive, &full_path) {
                if let Ok(ncx_toc) = parse_ncx(&content) {
                    toc.extend(ncx_toc);
                    break;
                }
            }
        }
    }

    // If no NCX or it was empty, try NAV (EPUB 3)
    if toc.is_empty() {
        for (id, href) in manifest {
            if id.contains("nav") || href.contains("nav") {
                let full_path = resolve_path(root_dir, href);
                if let Ok(content) = read_file_from_zip(archive, &full_path) {
                    if let Ok(nav_toc) = parse_nav(&content) {
                        toc.extend(nav_toc);
                        break;
                    }
                }
            }
        }
    }

    Ok(toc)
}

/// Parse NCX table of contents
fn parse_ncx(content: &str) -> Result<HashMap<String, String>> {
    let mut toc = HashMap::new();
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut current_text = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                if e.name().as_ref() == b"text" {
                    in_text = true;
                    current_text.clear();
                }
            }
            Ok(Event::Text(ref e)) if in_text => {
                current_text = e.unescape().unwrap_or_default().to_string();
            }
            Ok(Event::Empty(ref e)) if e.name().as_ref() == b"content" => {
                for attr in e.attributes().flatten() {
                    if attr.key.as_ref() == b"src" {
                        let src = String::from_utf8_lossy(&attr.value).to_string();
                        // Remove fragment identifier if present
                        let src = src.split('#').next().unwrap_or(&src).to_string();
                        if !current_text.is_empty() {
                            toc.insert(src, current_text.clone());
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) if e.name().as_ref() == b"text" => {
                in_text = false;
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // Ignore parse errors, continue with what we have
            _ => {}
        }
        buf.clear();
    }

    Ok(toc)
}

/// Parse NAV table of contents (EPUB 3)
fn parse_nav(content: &str) -> Result<HashMap<String, String>> {
    let mut toc = HashMap::new();

    // Simple regex-based parsing for nav - more forgiving than full XML parsing
    let link_re = regex::Regex::new(r##"<a[^>]*href="([^"#]+)[^"]*"[^>]*>([^<]+)</a>"##)?;

    for cap in link_re.captures_iter(content) {
        let href = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let text = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        if !href.is_empty() && !text.is_empty() {
            toc.insert(href.to_string(), text.trim().to_string());
        }
    }

    Ok(toc)
}

/// Extract plain text from an XHTML chapter file
fn extract_chapter_text(
    archive: &mut ZipArchive<BufReader<File>>,
    path: &str,
) -> Result<String> {
    let content = read_file_from_zip(archive, path)?;

    let mut text = String::new();
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut in_body = false;
    let mut skip_depth: i32 = 0;

    let skip_elements = ["script", "style", "head", "nav", "aside", "figure"];

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();

                if name == "body" {
                    in_body = true;
                } else if skip_elements.contains(&name.as_str()) {
                    skip_depth += 1;
                } else if in_body && skip_depth == 0 {
                    // Add whitespace for block elements
                    match name.as_str() {
                        "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li"
                        | "blockquote" | "br" | "section" | "article" => {
                            if !text.ends_with('\n') && !text.is_empty() {
                                text.push('\n');
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(ref e)) if in_body && skip_depth == 0 => {
                let t = e.unescape().unwrap_or_default();
                let t = t.trim();
                if !t.is_empty() {
                    if !text.is_empty() && !text.ends_with('\n') && !text.ends_with(' ') {
                        text.push(' ');
                    }
                    text.push_str(t);
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();

                if skip_elements.contains(&name.as_str()) {
                    skip_depth = skip_depth.saturating_sub(1);
                } else if name == "body" {
                    in_body = false;
                } else if in_body && skip_depth == 0 {
                    match name.as_str() {
                        "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li"
                        | "blockquote" => {
                            if !text.ends_with('\n') {
                                text.push('\n');
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Empty(ref e)) if in_body && skip_depth == 0 => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if name == "br" && !text.ends_with('\n') {
                    text.push('\n');
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // Ignore parse errors, continue with what we have
            _ => {}
        }
        buf.clear();
    }

    // Normalize the text
    Ok(normalize_text(&text))
}

/// Read a file from the ZIP archive
fn read_file_from_zip(archive: &mut ZipArchive<BufReader<File>>, path: &str) -> Result<String> {
    // Check if exact path exists first
    let exact_exists = archive.by_name(path).is_ok();

    let mut content = String::new();

    if exact_exists {
        let mut file = archive.by_name(path)?;
        file.read_to_string(&mut content)?;
    } else {
        // Try URL-decoded path
        let decoded = urlencoding::decode(path).unwrap_or_else(|_| path.into());
        let mut file = archive
            .by_name(&decoded)
            .context(format!("File not found in EPUB: {}", path))?;
        file.read_to_string(&mut content)?;
    }

    Ok(content)
}

/// Resolve a relative path within the EPUB
fn resolve_path(root_dir: &str, href: &str) -> String {
    if root_dir.is_empty() || href.starts_with('/') {
        href.to_string()
    } else {
        format!("{}/{}", root_dir, href)
    }
}

/// Normalize extracted text
fn normalize_text(text: &str) -> String {
    let mut result = String::new();
    let mut prev_was_newline = false;
    let mut prev_was_space = false;

    for ch in text.chars() {
        match ch {
            '\n' | '\r' => {
                if !prev_was_newline {
                    result.push('\n');
                    prev_was_newline = true;
                    prev_was_space = false;
                }
            }
            ' ' | '\t' => {
                if !prev_was_space && !prev_was_newline {
                    result.push(' ');
                    prev_was_space = true;
                }
            }
            _ => {
                result.push(ch);
                prev_was_newline = false;
                prev_was_space = false;
            }
        }
    }

    result.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_text() {
        let input = "Hello    world\n\n\nThis is   a test";
        let expected = "Hello world\nThis is a test";
        assert_eq!(normalize_text(input), expected);
    }

    #[test]
    fn test_resolve_path() {
        assert_eq!(resolve_path("OEBPS", "chapter1.xhtml"), "OEBPS/chapter1.xhtml");
        assert_eq!(resolve_path("", "chapter1.xhtml"), "chapter1.xhtml");
        assert_eq!(resolve_path("OEBPS", "/absolute.xhtml"), "/absolute.xhtml");
    }
}
