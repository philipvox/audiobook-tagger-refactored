//! Job queue for batch alignment processing.
//!
//! This module provides:
//! - SQLite-backed job persistence
//! - Job status tracking
//! - Alignment data storage

use super::{AlignmentGranularity, BookAlignment};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

// ============================================================================
// JOB STATUS
// ============================================================================

/// Status of an alignment job
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Downloading,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobStatus::Pending => write!(f, "pending"),
            JobStatus::Downloading => write!(f, "downloading"),
            JobStatus::Processing => write!(f, "processing"),
            JobStatus::Completed => write!(f, "completed"),
            JobStatus::Failed => write!(f, "failed"),
            JobStatus::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl std::str::FromStr for JobStatus {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(JobStatus::Pending),
            "downloading" => Ok(JobStatus::Downloading),
            "processing" => Ok(JobStatus::Processing),
            "completed" => Ok(JobStatus::Completed),
            "failed" => Ok(JobStatus::Failed),
            "cancelled" => Ok(JobStatus::Cancelled),
            _ => anyhow::bail!("Unknown job status: {}", s),
        }
    }
}

// ============================================================================
// ALIGNMENT JOB
// ============================================================================

/// An alignment job in the queue
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentJob {
    pub id: String,
    pub book_id: String,
    pub library_id: String,
    pub title: String,
    pub author: String,
    pub status: JobStatus,
    pub progress: f32,
    pub current_chapter: Option<usize>,
    pub total_chapters: Option<usize>,
    pub error: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub retry_count: i32,
}

impl AlignmentJob {
    /// Create a new pending job
    pub fn new(book_id: String, library_id: String, title: String, author: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            book_id,
            library_id,
            title,
            author,
            status: JobStatus::Pending,
            progress: 0.0,
            current_chapter: None,
            total_chapters: None,
            error: None,
            created_at: Utc::now().timestamp(),
            started_at: None,
            completed_at: None,
            retry_count: 0,
        }
    }

    /// Mark job as started
    pub fn start(&mut self) {
        self.status = JobStatus::Downloading;
        self.started_at = Some(Utc::now().timestamp());
    }

    /// Update progress
    pub fn update_progress(&mut self, current: usize, total: usize) {
        self.current_chapter = Some(current);
        self.total_chapters = Some(total);
        self.progress = (current as f32 / total as f32) * 100.0;
    }

    /// Mark as processing
    pub fn set_processing(&mut self) {
        self.status = JobStatus::Processing;
    }

    /// Mark as completed
    pub fn complete(&mut self) {
        self.status = JobStatus::Completed;
        self.completed_at = Some(Utc::now().timestamp());
        self.progress = 100.0;
    }

    /// Mark as failed
    pub fn fail(&mut self, error: String) {
        self.status = JobStatus::Failed;
        self.completed_at = Some(Utc::now().timestamp());
        self.error = Some(error);
    }

    /// Check if job can be retried
    pub fn can_retry(&self) -> bool {
        self.status == JobStatus::Failed && self.retry_count < 3
    }

    /// Retry the job
    pub fn retry(&mut self) {
        self.status = JobStatus::Pending;
        self.retry_count += 1;
        self.error = None;
        self.started_at = None;
        self.completed_at = None;
        self.progress = 0.0;
        self.current_chapter = None;
    }
}

// ============================================================================
// QUEUE DATABASE
// ============================================================================

/// SQLite-backed job queue
pub struct AlignmentQueue {
    conn: Mutex<Connection>,
}

impl AlignmentQueue {
    /// Open or create the queue database
    pub fn open(db_path: &Path) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path).context("Failed to open alignment queue database")?;

        let queue = Self {
            conn: Mutex::new(conn),
        };
        queue.migrate()?;

        Ok(queue)
    }

    /// Run database migrations
    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS alignment_jobs (
                id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL,
                library_id TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                progress REAL NOT NULL DEFAULT 0,
                current_chapter INTEGER,
                total_chapters INTEGER,
                error TEXT,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                completed_at INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status ON alignment_jobs(status);
            CREATE INDEX IF NOT EXISTS idx_jobs_book_id ON alignment_jobs(book_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_created ON alignment_jobs(created_at DESC);

            CREATE TABLE IF NOT EXISTS alignments (
                book_id TEXT PRIMARY KEY,
                alignment_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            "#,
        )
        .context("Failed to run migrations")?;

        Ok(())
    }

    /// Insert a new job
    pub fn insert_job(&self, job: &AlignmentJob) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            r#"
            INSERT INTO alignment_jobs (
                id, book_id, library_id, title, author, status, progress,
                current_chapter, total_chapters, error, created_at, started_at,
                completed_at, retry_count
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            params![
                job.id,
                job.book_id,
                job.library_id,
                job.title,
                job.author,
                job.status.to_string(),
                job.progress,
                job.current_chapter,
                job.total_chapters,
                job.error,
                job.created_at,
                job.started_at,
                job.completed_at,
                job.retry_count,
            ],
        )?;

        Ok(())
    }

    /// Update an existing job
    pub fn update_job(&self, job: &AlignmentJob) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            r#"
            UPDATE alignment_jobs SET
                status = ?2,
                progress = ?3,
                current_chapter = ?4,
                total_chapters = ?5,
                error = ?6,
                started_at = ?7,
                completed_at = ?8,
                retry_count = ?9
            WHERE id = ?1
            "#,
            params![
                job.id,
                job.status.to_string(),
                job.progress,
                job.current_chapter,
                job.total_chapters,
                job.error,
                job.started_at,
                job.completed_at,
                job.retry_count,
            ],
        )?;

        Ok(())
    }

    /// Get a job by ID
    pub fn get_job(&self, id: &str) -> Result<Option<AlignmentJob>> {
        let conn = self.conn.lock().unwrap();

        conn.query_row(
            "SELECT * FROM alignment_jobs WHERE id = ?1",
            params![id],
            |row| self.row_to_job(row),
        )
        .optional()
        .context("Failed to get job")
    }

    /// Get the next pending job
    pub fn get_next_pending(&self) -> Result<Option<AlignmentJob>> {
        let conn = self.conn.lock().unwrap();

        conn.query_row(
            r#"
            SELECT * FROM alignment_jobs
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
            "#,
            [],
            |row| self.row_to_job(row),
        )
        .optional()
        .context("Failed to get next pending job")
    }

    /// Get all jobs with a specific status
    pub fn get_jobs_by_status(&self, status: JobStatus) -> Result<Vec<AlignmentJob>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn
            .prepare("SELECT * FROM alignment_jobs WHERE status = ?1 ORDER BY created_at DESC")?;

        let jobs = stmt
            .query_map(params![status.to_string()], |row| self.row_to_job(row))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(jobs)
    }

    /// Get all jobs
    pub fn get_all_jobs(&self) -> Result<Vec<AlignmentJob>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt =
            conn.prepare("SELECT * FROM alignment_jobs ORDER BY created_at DESC LIMIT 100")?;

        let jobs = stmt
            .query_map([], |row| self.row_to_job(row))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(jobs)
    }

    /// Get pending job count
    pub fn get_pending_count(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignment_jobs WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;

        Ok(count)
    }

    /// Check if a job exists for a book
    pub fn job_exists_for_book(&self, book_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignment_jobs WHERE book_id = ?1 AND status IN ('pending', 'downloading', 'processing')",
            params![book_id],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    /// Delete a job
    pub fn delete_job(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM alignment_jobs WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Clear completed jobs
    pub fn clear_completed(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM alignment_jobs WHERE status IN ('completed', 'cancelled')",
            [],
        )?;
        Ok(count)
    }

    /// Cancel all pending jobs
    pub fn cancel_pending(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "UPDATE alignment_jobs SET status = 'cancelled' WHERE status = 'pending'",
            [],
        )?;
        Ok(count)
    }

    // Alignment storage methods

    /// Save alignment data
    pub fn save_alignment(&self, book_id: &str, alignment: &BookAlignment) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        let alignment_json = serde_json::to_string(alignment)?;

        conn.execute(
            r#"
            INSERT OR REPLACE INTO alignments (book_id, alignment_json, created_at)
            VALUES (?1, ?2, ?3)
            "#,
            params![book_id, alignment_json, Utc::now().timestamp()],
        )?;

        Ok(())
    }

    /// Get alignment data
    pub fn get_alignment(&self, book_id: &str) -> Result<Option<BookAlignment>> {
        let conn = self.conn.lock().unwrap();

        let json: Option<String> = conn
            .query_row(
                "SELECT alignment_json FROM alignments WHERE book_id = ?1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?;

        match json {
            Some(j) => Ok(Some(serde_json::from_str(&j)?)),
            None => Ok(None),
        }
    }

    /// Check if alignment exists
    pub fn has_alignment(&self, book_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignments WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    /// Delete alignment
    pub fn delete_alignment(&self, book_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM alignments WHERE book_id = ?1", params![book_id])?;
        Ok(())
    }

    /// Convert a database row to AlignmentJob
    fn row_to_job(&self, row: &rusqlite::Row) -> rusqlite::Result<AlignmentJob> {
        let status_str: String = row.get("status")?;

        Ok(AlignmentJob {
            id: row.get("id")?,
            book_id: row.get("book_id")?,
            library_id: row.get("library_id")?,
            title: row.get("title")?,
            author: row.get("author")?,
            status: status_str.parse().unwrap_or(JobStatus::Pending),
            progress: row.get("progress")?,
            current_chapter: row.get("current_chapter")?,
            total_chapters: row.get("total_chapters")?,
            error: row.get("error")?,
            created_at: row.get("created_at")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            retry_count: row.get("retry_count")?,
        })
    }
}

// ============================================================================
// QUEUE STATISTICS
// ============================================================================

/// Statistics about the alignment queue
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    pub pending: i64,
    pub processing: i64,
    pub completed: i64,
    pub failed: i64,
    pub total_alignments: i64,
}

impl AlignmentQueue {
    /// Get queue statistics
    pub fn get_stats(&self) -> Result<QueueStats> {
        let conn = self.conn.lock().unwrap();

        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignment_jobs WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;

        let processing: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignment_jobs WHERE status IN ('downloading', 'processing')",
            [],
            |row| row.get(0),
        )?;

        let completed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignment_jobs WHERE status = 'completed'",
            [],
            |row| row.get(0),
        )?;

        let failed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM alignment_jobs WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )?;

        let total_alignments: i64 =
            conn.query_row("SELECT COUNT(*) FROM alignments", [], |row| row.get(0))?;

        Ok(QueueStats {
            pending,
            processing,
            completed,
            failed,
            total_alignments,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_job_lifecycle() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let queue = AlignmentQueue::open(&db_path).unwrap();

        // Create and insert job
        let mut job = AlignmentJob::new(
            "book123".to_string(),
            "lib456".to_string(),
            "Test Book".to_string(),
            "Test Author".to_string(),
        );

        queue.insert_job(&job).unwrap();

        // Verify job exists
        let fetched = queue.get_job(&job.id).unwrap().unwrap();
        assert_eq!(fetched.status, JobStatus::Pending);

        // Update job status
        job.start();
        job.set_processing();
        job.update_progress(5, 10);
        queue.update_job(&job).unwrap();

        let fetched = queue.get_job(&job.id).unwrap().unwrap();
        assert_eq!(fetched.status, JobStatus::Processing);
        assert_eq!(fetched.progress, 50.0);

        // Complete job
        job.complete();
        queue.update_job(&job).unwrap();

        let fetched = queue.get_job(&job.id).unwrap().unwrap();
        assert_eq!(fetched.status, JobStatus::Completed);
    }

    #[test]
    fn test_queue_stats() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let queue = AlignmentQueue::open(&db_path).unwrap();

        // Insert some jobs
        for i in 0..5 {
            let job = AlignmentJob::new(
                format!("book{}", i),
                "lib".to_string(),
                format!("Book {}", i),
                "Author".to_string(),
            );
            queue.insert_job(&job).unwrap();
        }

        let stats = queue.get_stats().unwrap();
        assert_eq!(stats.pending, 5);
        assert_eq!(stats.processing, 0);
    }
}
