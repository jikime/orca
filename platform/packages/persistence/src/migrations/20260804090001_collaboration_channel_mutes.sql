-- Chat slice 10: per-user, per-channel channel mute (notification suppression). A mute
-- silences BROADCAST notifications (@channel/@here) from a channel for one user; a
-- direct explicit @mention still pierces the mute (a human deliberately pinged them).
-- The suppression is applied in application code (message-store resolveMentions filters
-- the broadcast set against this table); this migration only stores the preference.
-- Design-reference-only build, modeled on the collaboration tenant template.

-- channel_mutes: one row = "this user has muted this channel". Idempotent membership of
-- the row set (PK conflict is a no-op). Same-tenant composite FK to channels so a mute
-- can never reference another org's channel, and cascades away with the channel.
create table collaboration.channel_mutes (
  organization_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, channel_id, user_id),
  constraint channel_mutes_channel_fk
    foreign key (organization_id, channel_id) references collaboration.channels (organization_id, id)
    on delete cascade
);

-- === RLS: the standard collaboration tenant pair (permissive isolation + restrictive
-- boundary guard) + FORCE, keyed on pie.organization_id. A mute is a private preference
-- but carries no cross-user read path here (the store always scopes by both channel and
-- the acting user), so the org tenant pair is sufficient — no per-user policy needed. ===
alter table collaboration.channel_mutes enable row level security;
alter table collaboration.channel_mutes force row level security;
create policy channel_mutes_tenant_isolation on collaboration.channel_mutes
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy channel_mutes_tenant_boundary_guard on collaboration.channel_mutes
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.channel_mutes to pie_app;
