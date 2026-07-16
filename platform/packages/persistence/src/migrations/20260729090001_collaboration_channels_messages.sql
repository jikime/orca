-- Chat slice 1: collaboration bounded context — org-scoped channels + messages +
-- per-user read cursors (doc 08 R7 brief, doc 30:268 reserves the `collaboration`
-- schema, doc 13:206-207 domain sketch). Design-reference-only build: modeled on
-- Pie's own docs and the delivery.comments tenant template, NOT on any external
-- project's code.
--
-- Same tenant model as delivery: composite (organization_id, id) keys + composite
-- same-tenant FKs so a message/member/cursor can never reference another org's
-- channel, and the permissive tenant_isolation + restrictive tenant_boundary_guard
-- + FORCE RLS pair keyed on pie.organization_id.
create schema if not exists collaboration;
grant usage on schema collaboration to pie_app;
grant usage on schema collaboration to pie_worker;

-- channels: an org-scoped conversation space. scope_type/scope_id are a forward
-- pointer (team/project/customer/ticket channels arrive later); slice 1 creates
-- organization-level channels only. visibility mirrors delivery (internal|project|
-- customer) so the internal-vs-customer boundary is consistent across the product.
create table collaboration.channels (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  scope_type text not null default 'organization',
  scope_id uuid,
  visibility text not null default 'internal',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint channels_visibility_check check (visibility in ('internal', 'project', 'customer')),
  constraint channels_scope_type_check
    check (scope_type in ('organization', 'team', 'project', 'customer', 'ticket'))
);

-- channel_members: the roster that gates who may read/post in a channel. This is an
-- explicit membership list (distinct from identity.resource_grants, which narrows or
-- widens a role permission). user_id is a plain uuid (app-resolved), matching the
-- delivery aggregates' assignee/creator columns.
create table collaboration.channel_members (
  organization_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null,
  role text not null default 'member',
  added_at timestamptz not null default now(),
  primary key (organization_id, channel_id, user_id),
  constraint channel_members_channel_fk
    foreign key (organization_id, channel_id) references collaboration.channels (organization_id, id)
    on delete cascade
);

-- messages: a committed post in a channel. version supports later edit history
-- (message_revisions is a later slice). Same-tenant composite FK to channels.
create table collaboration.messages (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  channel_id uuid not null,
  author_user_id uuid not null,
  body text not null,
  visibility text not null default 'internal',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint messages_visibility_check check (visibility in ('internal', 'project', 'customer')),
  constraint messages_channel_fk
    foreign key (organization_id, channel_id) references collaboration.channels (organization_id, id)
    on delete cascade
);

-- Keyset pagination reads by (organization_id, channel_id, created_at, id).
create index messages_channel_idx
  on collaboration.messages (organization_id, channel_id, created_at, id);

-- read_cursors: per-user-per-channel last-read marker, keyed by the last read
-- MESSAGE ID — NEVER by a stream sequence. operations.stream_cursors (which orders
-- realtime delivery per org) is a completely separate concept; do not conflate.
create table collaboration.read_cursors (
  organization_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null,
  last_read_message_id uuid,
  last_read_at timestamptz not null default now(),
  primary key (organization_id, channel_id, user_id),
  constraint read_cursors_channel_fk
    foreign key (organization_id, channel_id) references collaboration.channels (organization_id, id)
    on delete cascade
);

-- === RLS: the standard tenant pair on every collaboration table ===
do $$
declare
  t text;
begin
  foreach t in array array['channels', 'channel_members', 'messages', 'read_cursors']
  loop
    execute format('alter table collaboration.%I enable row level security', t);
    execute format('alter table collaboration.%I force row level security', t);
    execute format(
      'create policy %I on collaboration.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on collaboration.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on collaboration.%I to pie_app', t);
  end loop;
end
$$;
