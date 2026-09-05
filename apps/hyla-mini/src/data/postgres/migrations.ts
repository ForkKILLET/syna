import { escapeIdentifier, escapeLiteral } from 'pg'
import type { DatabasePool } from './pool.js'

/**
 * Idempotent DDL for the Hyla-mini content tables. All statements are qualified
 * with the configured schema, and the whole batch runs under a transaction-scoped
 * advisory lock so concurrent starts do not race `CREATE ... IF NOT EXISTS`.
 *
 * Posts are identified by `(tenant_id, id)`: an id is a tenant-scoped fact, as it
 * is on the filesystem backend and in the tenant-scoped repository API. Domain
 * ownership lives in `domains` (one row per normalized host), so two tenants
 * claiming one host at the same time is decided by the primary key.
 */
export function migrationStatements(schema: string): readonly string[] {
  const s = escapeIdentifier(schema)
  const literal = escapeLiteral(schema)
  return [
    `create schema if not exists ${s}`,
    `create table if not exists ${s}.sites (
       tenant_id text primary key,
       config jsonb not null,
       config_revision integer not null
     )`,
    `create table if not exists ${s}.posts (
       id text not null,
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
       primary key (tenant_id, id),
       unique (tenant_id, slug)
     )`,
    // Schemas created before the third review round keyed posts by id alone (a
    // global identity): move them to the composite key. Runs once; a composite
    // key has two columns and is left alone.
    `do $$
     declare single_column_key text;
     begin
       select c.conname into single_column_key
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = ${literal} and t.relname = 'posts' and c.contype = 'p' and array_length(c.conkey, 1) = 1;
       if single_column_key is not null then
         execute format('alter table %I.posts drop constraint %I', ${literal}, single_column_key);
         execute format('alter table %I.posts add primary key (tenant_id, id)', ${literal});
       end if;
     end $$`,
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
    `create table if not exists ${s}.content_versions (
       tenant_id text primary key,
       version bigint not null
     )`,
    // The domains table is created once, together with its back-fill from the
    // configurations stored before it existed: lower-case, trimmed, without a
    // port or a trailing dot (the SQL approximation of normalizeDomain; a
    // tenant's next save rewrites its rows with the real one). A stored document
    // whose `domains` is not a list of strings (a raw update) contributes nothing
    // and is that tenant's SiteConfigError on read, not a failed start (F-BD3-06).
    `do $$
     begin
       if to_regclass(${escapeLiteral(`${schema}.domains`)}) is null then
         create table ${s}.domains (
           normalized_host text primary key,
           tenant_id text not null
         );
         insert into ${s}.domains (normalized_host, tenant_id)
         select distinct on (host) host, tenant_id from (
           select regexp_replace(lower(trim(d.value #>> '{}')), '(:[0-9]+)?\\.?$', '') as host, s.tenant_id
             from ${s}.sites s,
                  jsonb_array_elements(case when jsonb_typeof(s.config->'domains') = 'array' then s.config->'domains' else '[]'::jsonb end) as d
            where jsonb_typeof(d.value) = 'string'
         ) claims
         where host <> ''
         order by host, tenant_id
         on conflict (normalized_host) do nothing;
       end if;
     end $$`,
    `create index if not exists domains_tenant_idx on ${s}.domains (tenant_id)`,
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
