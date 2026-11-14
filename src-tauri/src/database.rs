use chrono::Utc;
use rusqlite::{params, Connection};
use std::{fs, path::Path};

pub(crate) fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            "#,
        )
        .map_err(|error| error.to_string())?;
    migrate(&mut connection)?;
    Ok(connection)
}

pub(crate) fn migrate(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| error.to_string())?;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_state (
                namespace TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_path TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                run_id TEXT,
                step_id TEXT,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                progress REAL NOT NULL DEFAULT 0,
                payload_ref TEXT,
                result_ref TEXT,
                attempt INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 2,
                next_retry_at TEXT,
                idempotency_key TEXT NOT NULL,
                lease_expires_at TEXT,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS render_jobs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                project_revision INTEGER NOT NULL,
                spec_path TEXT NOT NULL,
                output_path TEXT NOT NULL,
                partial_path TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                rendered_frames INTEGER NOT NULL DEFAULT 0,
                encoded_frames INTEGER NOT NULL DEFAULT 0,
                renderer_version TEXT NOT NULL,
                pid INTEGER,
                bytes INTEGER,
                sha256 TEXT,
                duration_ms INTEGER,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS usage_records (
                id TEXT PRIMARY KEY,
                provider_call_id TEXT,
                project_id TEXT,
                capability TEXT NOT NULL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                image_count INTEGER NOT NULL DEFAULT 0,
                audio_ms INTEGER NOT NULL DEFAULT 0,
                estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
                currency TEXT NOT NULL DEFAULT 'USD',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS artifact_refs (
                id TEXT PRIMARY KEY,
                owner_type TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                asset_id TEXT,
                project_relative_path TEXT NOT NULL,
                mime_type TEXT,
                sha256 TEXT,
                bytes INTEGER,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS image_jobs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                scene_id TEXT NOT NULL,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                provider_id TEXT NOT NULL,
                provider_name TEXT NOT NULL,
                anchor_label TEXT NOT NULL DEFAULT '',
                request_json TEXT NOT NULL,
                result_json TEXT,
                asset_ids_json TEXT NOT NULL DEFAULT '[]',
                attempt INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 2,
                error_code TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(source_id, chunk_index)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
                ON tasks(idempotency_key);
            CREATE INDEX IF NOT EXISTS idx_tasks_queue
                ON tasks(status, priority DESC, next_retry_at);
            CREATE INDEX IF NOT EXISTS idx_render_jobs_project
                ON render_jobs(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_image_jobs_project
                ON image_jobs(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_image_jobs_status
                ON image_jobs(status, created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_records_project
                ON usage_records(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_artifact_refs_owner
                ON artifact_refs(owner_type, owner_id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_project
                ON knowledge_chunks(project_id);
            CREATE INDEX IF NOT EXISTS idx_projects_updated
                ON projects(updated_at DESC);
            "#,
        )
        .map_err(|error| error.to_string())?;

    ensure_column(
        &transaction,
        "projects",
        "manifest_version",
        "TEXT NOT NULL DEFAULT '1.0'",
    )?;
    ensure_column(
        &transaction,
        "projects",
        "status",
        "TEXT NOT NULL DEFAULT 'ready'",
    )?;
    ensure_column(&transaction, "projects", "current_run_id", "TEXT")?;
    ensure_column(&transaction, "projects", "thumbnail_rel_path", "TEXT")?;
    ensure_column(&transaction, "projects", "last_opened_at", "TEXT")?;
    ensure_column(&transaction, "projects", "created_at", "TEXT")?;
    ensure_column(
        &transaction,
        "providers",
        "protocol",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "providers",
        "base_url",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &transaction,
        "providers",
        "capabilities_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        &transaction,
        "providers",
        "health",
        "TEXT NOT NULL DEFAULT 'unknown'",
    )?;
    ensure_column(&transaction, "providers", "last_checked_at", "TEXT")?;

    let migration_version = 4_i64;
    let already_applied = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            params![migration_version],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    if !already_applied {
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![migration_version, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|existing| existing == column) {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_add_platform_tables_and_are_idempotent() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("studio.sqlite3");
        let mut connection = Connection::open(&database_path).expect("open database");
        connection
            .execute_batch(
                r#"
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                "#,
            )
            .expect("legacy projects table");

        migrate(&mut connection).expect("first migration");
        migrate(&mut connection).expect("second migration");

        for table in [
            "schema_migrations",
            "tasks",
            "render_jobs",
            "image_jobs",
            "usage_records",
            "artifact_refs",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    params![table],
                    |row| row.get(0),
                )
                .expect("table lookup");
            assert_eq!(exists, 1, "missing table {table}");
        }
    }
}
