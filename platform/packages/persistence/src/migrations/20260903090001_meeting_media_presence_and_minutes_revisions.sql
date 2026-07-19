-- LiveKit webhooks are retried, so presence updates keep the signed event id and observed time.
-- This prevents a delayed leave from overwriting a newer rejoin and makes delivery idempotent.
alter table meetings.participants
  add column presence_observed_at timestamptz;

create table meetings.media_events (
  organization_id uuid not null references identity.organizations (id),
  event_id text not null,
  meeting_id uuid not null,
  event_type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (organization_id, event_id),
  constraint meeting_media_events_type_check
    check (event_type in ('participant_joined', 'participant_left'))
);

create index meeting_media_events_meeting_idx
  on meetings.media_events (organization_id, meeting_id, occurred_at);

alter table meetings.media_events enable row level security;
alter table meetings.media_events force row level security;
create policy meeting_media_events_tenant_isolation on meetings.media_events
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_media_events_tenant_boundary_guard on meetings.media_events
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert on meetings.media_events to pie_app;

-- Minutes remain one draft resource; immutable snapshots provide edit history without duplicating
-- the canonical document or weakening its review/finalize state machine.
create table meetings.minute_revisions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  minutes_id uuid not null,
  revision bigint not null,
  summary text not null,
  edited_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, minutes_id, revision)
);

insert into meetings.minute_revisions (
  organization_id,
  minutes_id,
  revision,
  summary,
  edited_by,
  created_at
)
select organization_id, id, version, summary, author_user_id, created_at
from meetings.minutes;

create index meeting_minute_revisions_minutes_idx
  on meetings.minute_revisions (organization_id, minutes_id, revision);

alter table meetings.minute_revisions enable row level security;
alter table meetings.minute_revisions force row level security;
create policy meeting_minute_revisions_tenant_isolation on meetings.minute_revisions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_minute_revisions_tenant_boundary_guard on meetings.minute_revisions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert on meetings.minute_revisions to pie_app;
