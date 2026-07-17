-- Moderation slice 1: message edit history + soft-delete (doc 33 §데이터모델 1·2).
-- The 20260729 messages migration reserved `version`/`updated_at` for edits and noted
-- "message_revisions is a later slice" — this IS that slice. Two changes:
--   1. collaboration.message_revisions — an immutable snapshot per committed body,
--      keyed by the messages.version it was live under (edit history, doc 33:33-43).
--   2. tombstone columns on collaboration.messages — audit metadata (who/when/why)
--      is retained on the row while the body is redacted (doc 33:45-54).

-- === 1. message_revisions: one immutable row per committed body ===
-- Same tenant model as the rest of collaboration: composite (organization_id, id) PK
-- + composite same-tenant FK to messages so a revision can never point at another
-- org's message. Bodies are appended, never updated in place (doc 33:31 principle);
-- delete redacts them (sets body='') but keeps the audit row.
create table collaboration.message_revisions (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  message_id uuid not null,
  revision bigint not null,
  body text not null,
  edited_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint message_revisions_message_fk
    foreign key (organization_id, message_id) references collaboration.messages (organization_id, id)
    on delete cascade,
  constraint message_revisions_unique_revision
    unique (organization_id, message_id, revision)
);

-- Reads fetch a message's revisions ordered by revision.
create index message_revisions_message_idx
  on collaboration.message_revisions (organization_id, message_id, revision);

-- === 2. tombstone columns on messages (soft-delete, audit/body separation) ===
-- All nullable so an existing (live) message is unaffected. deleted_at present == the
-- message is a tombstone; deleted_by/deletion_reason are the retained audit metadata.
-- messages already carries the standard RLS pair + FORCE, so these columns inherit it.
alter table collaboration.messages add column deleted_at timestamptz;
alter table collaboration.messages add column deleted_by uuid;
alter table collaboration.messages add column deletion_reason text;

-- === RLS: the standard tenant pair on the new table (permissive isolation +
-- restrictive boundary guard + FORCE), keyed on pie.organization_id, granted to pie_app.
alter table collaboration.message_revisions enable row level security;
alter table collaboration.message_revisions force row level security;
create policy message_revisions_tenant_isolation on collaboration.message_revisions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy message_revisions_tenant_boundary_guard on collaboration.message_revisions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.message_revisions to pie_app;
