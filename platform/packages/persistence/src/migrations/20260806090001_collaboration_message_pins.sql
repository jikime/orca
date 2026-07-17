-- Chat slice 2 (moderation): pinned messages — collaboration.message_pins (doc 33 §3).
-- One row = "this message is pinned in this channel". A channel member may pin (v1
-- product decision: member-or-channel.manage; the store enforces membership) up to a
-- per-channel cap; pin/unpin are idempotent. Design-reference-only build, modeled on the
-- collaboration tenant template — NOT on any external project's code.

-- message_pins: pinned_by is the actor who pinned. TWO same-tenant composite FKs so a pin
-- can never cross an org boundary AND cascades away with either its channel or its message
-- (a deleted/tombstoned message's pin row is removed by the message FK's cascade). The
-- (organization_id, channel_id, message_id) unique key forbids pinning one message twice.
create table collaboration.message_pins (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  channel_id uuid not null,
  message_id uuid not null,
  pinned_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, channel_id, message_id),
  constraint message_pins_channel_fk
    foreign key (organization_id, channel_id) references collaboration.channels (organization_id, id)
    on delete cascade,
  constraint message_pins_message_fk
    foreign key (organization_id, message_id) references collaboration.messages (organization_id, id)
    on delete cascade
);

-- The pin-list read and the per-channel cap count both scan by (organization_id, channel_id).
create index message_pins_channel_idx
  on collaboration.message_pins (organization_id, channel_id, created_at desc, id);

-- === RLS: the standard collaboration tenant pair (permissive isolation + restrictive
-- boundary guard) + FORCE, keyed on pie.organization_id. A pin carries no cross-user read
-- path (the store scopes every read by channel + membership), so the org tenant pair is
-- sufficient — no per-user policy needed. ===
alter table collaboration.message_pins enable row level security;
alter table collaboration.message_pins force row level security;
create policy message_pins_tenant_isolation on collaboration.message_pins
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy message_pins_tenant_boundary_guard on collaboration.message_pins
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.message_pins to pie_app;
