import { escapeIdentifier } from 'pg'
import type { DatabasePool } from './pool.js'

/**
 * Idempotent DDL for the Hyla-mini content tables. All statements are qualified
 * with the configured schema, and the whole batch runs under a transaction-scoped
 * advisory lock so concurrent starts do not race `CREATE ... IF NOT EXISTS`.
 */
export function migrationStatements(schema: string): readonly string[] {
  const s = escapeIdentifier(schema)
  return [
    `create schema if not exists ${s}`,
    `create table if not exists ${s}.sites (
       tenant_id text primary key,
       config jsonb not null,
       config_revision integer not null
     )`,
    `create table if not exists ${s}.posts (
       id text primary key,
       tenant_id text not null,
       slug text not null,
       locale text not null,
       title text not null,
       body text not null,
       status text not null,
       categories text[] not null,
       primary_category text null,
       tags text[] not null,
       revision integer not null,
       created_at timestamptz not null,
       updated_at timestamptz not null,
       unique (tenant_id, slug)
     )`,
    `create index if not exists posts_tenant_status_created_idx
       on ${s}.posts (tenant_id, status, created_at desc)`,
    `create index if not exists posts_tenant_categories_idx
       on ${s}.posts using gin (categories)`,
    `create index if not exists posts_tenant_tags_idx
       on ${s}.posts using gin (tags)`,
    `create table if not exists ${s}.categories (
       tenant_id text not null,
       slug text not null,
       name text not null,
       primary key (tenant_id, slug)
     )`,
    `create table if not exists ${s}.tags (
       tenant_id text not null,
       slug text not null,
       name text not null,
       primary key (tenant_id, slug)
     )`,
  ]
}

export async function applyMigrations(pool: DatabasePool): Promise<void> {
  await pool.withTransaction(async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`hyla-mini:migrations:${pool.schema}`])
    for (const statement of migrationStatements(pool.schema)) {
      await client.query(statement)
    }
  })
}
