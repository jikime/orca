-- Chat slice 3: mentions + durable per-user notifications (doc 08 멘션·읽음, doc
-- 13:241 NotificationDelivery). Design-reference-only. Both ride the existing
-- outbox→realtime path (notification added to the resource-change union) — no new
-- worker/gateway code.

-- message_mentions: mentions resolved ONCE at post time (never recomputed on edit).
-- A mentioned user must be a channel member (validated in application code before
-- insert). Same-tenant composite FK to messages.
create table collaboration.message_mentions (
  organization_id uuid not null,
  message_id uuid not null,
  mentioned_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, message_id, mentioned_user_id),
  constraint message_mentions_message_fk
    foreign key (organization_id, message_id) references collaboration.messages (organization_id, id)
    on delete cascade
);

-- notifications: a durable, per-user inbox item (survives tab close / cross-device),
-- distinct from ephemeral presence. This is the in-app notification; the doc-13
-- NotificationDelivery (email/push channel + template + status) is a later delivery
-- layer. source_ref is (channel_id, message_id).
create table collaboration.notifications (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  type text not null,
  channel_id uuid,
  message_id uuid,
  seen boolean not null default false,
  read boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint notifications_type_check check (type in ('mention'))
);

-- Unread-first listing per user.
create index notifications_user_idx
  on collaboration.notifications (organization_id, user_id, read, created_at desc, id);

-- === RLS ===
-- message_mentions: the standard org tenant pair.
alter table collaboration.message_mentions enable row level security;
alter table collaboration.message_mentions force row level security;
create policy message_mentions_tenant_isolation on collaboration.message_mentions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy message_mentions_tenant_boundary_guard on collaboration.message_mentions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.message_mentions to pie_app;

-- notifications: org tenant pair PLUS a per-user restriction on read paths. The
-- poster writes a notification FOR the mentioned user (org context only, no
-- pie.user_id), so INSERT is org-scoped; but SELECT/UPDATE additionally require
-- user_id = pie.user_id so org-member A can never read or mark member B's inbox.
alter table collaboration.notifications enable row level security;
alter table collaboration.notifications force row level security;
create policy notifications_tenant_isolation on collaboration.notifications
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy notifications_tenant_boundary_guard on collaboration.notifications
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy notifications_owner_read on collaboration.notifications
  as restrictive for select to pie_app
  using (user_id = nullif(current_setting('pie.user_id', true), '')::uuid);
create policy notifications_owner_update on collaboration.notifications
  as restrictive for update to pie_app
  using (user_id = nullif(current_setting('pie.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('pie.user_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.notifications to pie_app;
