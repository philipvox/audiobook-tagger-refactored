use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudibleMetadata {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub narrators: Vec<String>,
    pub series: Vec<AudibleSeries>,
    pub publisher: Option<String>,
    pub release_date: Option<String>,
    pub description: Option<String>,
    pub asin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudibleSeries {
    pub name: String,
    pub position: Option<String>,
}

pub async fn search_audible(
    title: &str,
    author: &str,
    cli_path: &str,
) -> Result<Option<AudibleMetadata>> {
    println!("          🎧 Audible: searching for '{}' by '{}'...", title, author);
    
    let search_query = format!("{} {}", title, author);
    
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::task::spawn_blocking({
            let query = search_query.clone();
            let cli = cli_path.to_string();
            move || {
                Command::new(&cli)
                    .arg("api")
                    .arg("1.0/catalog/products")
                    .arg("-p")
                    .arg(format!("keywords={}", query))
                    .arg("-p")
                    .arg("num_results=3")
                    .arg("-p")
                    .arg("response_groups=product_desc,product_attrs,contributors,series")
                    .output()
            }
        })
    ).await {
        Ok(Ok(Ok(output))) => output,
        Ok(Ok(Err(e))) => {
            println!("             ❌ CLI execution error: {}", e);
            println!("             💡 Make sure audible-cli is installed and authenticated");
            return Ok(None);
        }
        Ok(Err(e)) => {
            println!("             ❌ Task spawn error: {}", e);
            return Ok(None);
        }
        Err(_) => {
            println!("             ⚠️  Timeout (30s)");
            return Ok(None);
        }
    };
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        println!("             ❌ Command failed with exit code: {:?}", output.status.code());
        if !stderr.is_empty() {
            println!("             📛 STDERR: {}", stderr.trim());
        }
        if !stdout.is_empty() {
            println!("             📄 STDOUT: {}", stdout.trim());
        }
        return Ok(None);
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    
    if stdout.trim().is_empty() {
        println!("             ⚠️  No results");
        return Ok(None);
    }
    
    match parse_response(&stdout) {
        Ok(meta) => {
            println!("             ✅ Title: {:?}", meta.title);
            println!("                Narrators: {:?}", meta.narrators);
            println!("                ASIN: {:?}", meta.asin);
            Ok(Some(meta))
        }
        Err(e) => {
            println!("             ⚠️  Parse error: {}", e);
            println!("             📄 Raw response (first 500 chars): {}", &stdout[..stdout.len().min(500)]);
            Ok(None)
        }
    }
}

fn parse_response(json: &str) -> Result<AudibleMetadata> {
    #[derive(Deserialize)]
    struct Response {
        products: Vec<Product>,
    }
    
    #[derive(Deserialize)]
    struct Product {
        title: Option<String>,
        subtitle: Option<String>,
        authors: Option<Vec<Person>>,
        narrators: Option<Vec<Person>>,
        series: Option<Vec<Series>>,
        publisher_name: Option<String>,
        release_date: Option<String>,
        publisher_summary: Option<String>,
        asin: Option<String>,
    }
    
    #[derive(Deserialize)]
    struct Person {
        name: String,
    }
    
    #[derive(Deserialize)]
    struct Series {
        title: String,
        sequence: Option<String>,
    }
    
    let resp: Response = serde_json::from_str(json)?;
    let product = resp.products.first().ok_or_else(|| anyhow::anyhow!("No products"))?;
    
    Ok(AudibleMetadata {
        title: product.title.clone(),
        subtitle: product.subtitle.clone(),
        authors: product.authors.as_ref()
            .map(|a| a.iter().map(|p| p.name.clone()).collect())
            .unwrap_or_default(),
        narrators: product.narrators.as_ref()
            .map(|n| n.iter().map(|p| p.name.clone()).collect())
            .unwrap_or_default(),
        series: product.series.as_ref()
            .map(|s| s.iter().map(|info| AudibleSeries {
                name: info.title.clone(),
                position: info.sequence.clone(),
            }).collect())
            .unwrap_or_default(),
        publisher: product.publisher_name.clone(),
        release_date: product.release_date.clone(),
        description: product.publisher_summary.clone(),
        asin: product.asin.clone(),
    })
}
