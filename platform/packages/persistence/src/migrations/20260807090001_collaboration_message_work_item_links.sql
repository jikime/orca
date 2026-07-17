-- Chat slice 3 (moderation): message→WorkItem conversion — collaboration.message_work_item_links
-- (doc 33 §4). One row = "this chat message was converted into that delivery work item".
-- This is the ONLY table that bridges collaboration ↔ delivery; the link lives in
-- collaboration (the source side), and each schema's RLS/permissions are still crossed
-- independently by the conversion path. Design-reference-only build, modeled on the
-- collaboration tenant template — NOT on any external project's code.

-- message_work_item_links: created_by is the actor who converted. The message side has a
-- same-tenant composite FK so a link cannot cross an org boundary and cascades away with
-- its message (a hard message/channel delete removes the link row).
--
-- work_item_id has NO cross-schema foreign key ON PURPOSE: collaboration must not take a
-- hard physical dependency on delivery's table layout (the two schemas evolve and are
-- governed separately). The same-org invariant that a real cross-schema FK would give is
-- instead enforced in application code (the store creates the work item and the link in ONE
-- org tenant tx, so both carry the identical organization_id). The
-- (organization_id, message_id, work_item_id) unique key makes re-converting the same
-- message to the same work item idempotent.
create table collaboration.message_work_item_links (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  message_id uuid not null,
  work_item_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, message_id, work_item_id),
  constraint message_work_item_links_message_fk
    foreign key (organization_id, message_id) references collaboration.messages (organization_id, id)
    on delete cascade
);

-- The per-message link read ("this message created WORK-123") scans by (organization_id,
-- message_id), most-recent link first.
create index message_work_item_links_message_idx
  on collaboration.message_work_item_links (organization_id, message_id, created_at desc, id);

-- === RLS: the standard collaboration tenant pair (permissive isolation + restrictive
-- boundary guard) + FORCE, keyed on pie.organization_id. The link carries no cross-user read
-- path (the store scopes reads by message + channel membership), so the org tenant pair is
-- sufficient — no per-user policy needed. ===
alter table collaboration.message_work_item_links enable row level security;
alter table collaboration.message_work_item_links force row level security;
create policy message_work_item_links_tenant_isolation on collaboration.message_work_item_links
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy message_work_item_links_tenant_boundary_guard on collaboration.message_work_item_links
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.message_work_item_links to pie_app;
