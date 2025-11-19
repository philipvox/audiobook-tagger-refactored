use std::process::Command;
use serde::{Deserialize, Serialize};
use anyhow::Result;

#[derive(Debug, Serialize, Deserialize)]
pub struct AudibleLoginRequest {
    pub email: String,
    pub password: String,
    pub country_code: String,
}

pub fn login_audible(email: &str, password: &str, country_code: &str) -> Result<String> {
    let output = Command::new("audible")
        .arg("manage")
        .arg("auth-file")
        .arg("add")
        .arg("-l")
        .arg(country_code)
        .arg("-u")
        .arg(email)
        .arg("-p")
        .arg(password)
        .output()?;
    
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).to_string();
        anyhow::bail!("Audible login failed: {}", error)
    }
}

pub fn check_audible_status() -> Result<bool> {
    let output = Command::new("audible")
        .arg("--version")
        .output()?;
    
    Ok(output.status.success())
}
