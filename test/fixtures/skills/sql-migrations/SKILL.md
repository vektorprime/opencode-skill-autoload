---
name: sql-migrations
description: Use when changing a database schema - writing SQL migrations, adding indexes and columns, and rolling changes back safely.
---

# SQL schema migrations

## Writing a migration

Each migration is a numbered file with an up step and a down step. Keep one logical change per
migration and never edit a migration that has already run in production; write a new one instead.

## Adding columns

Add new columns as nullable or with a default so existing rows stay valid. Backfill data in a
separate step, then add the NOT NULL constraint once every row has a value.

## Indexes

Add an index for columns used in WHERE clauses and joins on large tables. On PostgreSQL use
`CREATE INDEX CONCURRENTLY` so the table is not locked. Check that a query uses the index with
`EXPLAIN ANALYZE`.

## Renaming and dropping

Rename in two releases: add the new column, write to both, switch reads, then drop the old column.
Before dropping a table or column, confirm nothing reads it and take a backup.

## Rolling back

Test the down step locally before shipping. If a migration fails halfway, check whether the
database supports transactional DDL; MySQL does not, so a failed migration may need manual cleanup.
