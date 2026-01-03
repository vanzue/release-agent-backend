-- 006_issue_sync_cursor.sql

alter table issue_sync_state
  add column if not exists last_synced_issue_number int null;
