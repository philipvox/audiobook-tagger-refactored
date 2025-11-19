// commands/audible.rs
// Audible authentication and status commands

use crate::audible_auth;

#[tauri::command]
pub async fn login_to_audible(
    email: String, 
    password: String, 
    country_code: String
) -> Result<String, String> {
    audible_auth::login_audible(&email, &password, &country_code).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_audible_installed() -> Result<bool, String> {
    audible_auth::check_audible_status().map_err(|e| e.to_string())
}
