-- Chat slice 2: threads + reactions on collaboration.messages. Design-reference-only
-- (Pie docs + distilled decisions; no external code). Both ride the existing
-- message.created / message.updated realtime invalidations — no new realtime plumbing.

-- Threads: a reply is an ORDINARY message with a pointer to its root — NOT a separate
-- aggregate/table. thread_root_message_id is NULL for a root, and points at a root for
-- a reply. Composite same-tenant FK (MATCH SIMPLE skips the check when the column is
-- NULL, so roots are unconstrained); same-CHANNEL is enforced in application logic.
alter table collaboration.messages
  add column thread_root_message_id uuid;

alter table collaboration.messages
  add constraint messages_thread_root_fk
    foreign key (organization_id, thread_root_message_id)
    references collaboration.messages (organization_id, id)
    on delete cascade;

-- Backs the reply-count / thread-replies reads.
create index messages_thread_root_idx
  on collaboration.messages (organization_id, thread_root_message_id)
  where thread_root_message_id is not null;

-- Reactions: durable add/remove facts. The PK stops a user from double-adding the same
-- emoji on a message; add/remove are the two operations. Same-tenant composite FK to
-- messages so a reaction can't target another org's message.
create table collaboration.message_reactions (
  organization_id uuid not null,
  message_id uuid not null,
  user_id uuid not null,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, message_id, user_id, emoji),
  constraint message_reactions_emoji_length check (char_length(emoji) between 1 and 32),
  constraint message_reactions_message_fk
    foreign key (organization_id, message_id) references collaboration.messages (organization_id, id)
    on delete cascade
);

create index message_reactions_message_idx
  on collaboration.message_reactions (organization_id, message_id);

-- === RLS: the standard tenant pair on message_reactions ===
alter table collaboration.message_reactions enable row level security;
alter table collaboration.message_reactions force row level security;
create policy message_reactions_tenant_isolation on collaboration.message_reactions
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy message_reactions_tenant_boundary_guard on collaboration.message_reactions
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.message_reactions to pie_app;
