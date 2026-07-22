-- M5 stores the wall-clock scheduling intent alongside the UTC occurrence and lets support
-- sessions own a meeting just like projects and tickets do.
alter table meetings.meetings
  add column time_zone text not null default 'UTC',
  add column recurrence text not null default 'none',
  add column series_id uuid,
  add column occurrence_index integer not null default 0;

alter table meetings.meetings
  drop constraint meetings_scope_kind_check;

alter table meetings.meetings
  add constraint meetings_scope_kind_check
  check (scope_kind in ('project', 'ticket', 'remote_session', 'none'));

alter table meetings.meetings
  add constraint meetings_recurrence_check
  check (recurrence in ('none', 'daily', 'weekly', 'monthly'));

alter table meetings.meetings
  add constraint meetings_occurrence_index_check check (occurrence_index >= 0);

create index meetings_series_idx
  on meetings.meetings (organization_id, series_id, occurrence_index);

-- Calendar export is a separate retryable boundary; provider failures never roll back the meeting.
create table meetings.calendar_links (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  provider text not null,
  calendar_id text not null,
  event_id text,
  web_url text,
  sync_status text not null default 'pending',
  last_error text,
  last_synced_at timestamptz,
  created_by uuid not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, meeting_id, provider),
  constraint meeting_calendar_provider_check
    check (provider in ('google_workspace', 'microsoft_365')),
  constraint meeting_calendar_status_check check (sync_status in ('pending', 'synced', 'failed'))
);

create index meeting_calendar_links_meeting_idx
  on meetings.calendar_links (organization_id, meeting_id, id);

alter table meetings.calendar_links enable row level security;
alter table meetings.calendar_links force row level security;
create policy meeting_calendar_links_tenant_isolation on meetings.calendar_links
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_calendar_links_tenant_boundary_guard on meetings.calendar_links
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.calendar_links to pie_app;

create table meetings.guest_links (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  token_hash text not null unique,
  identity_mode text not null,
  visibility text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  created_by uuid not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint meeting_guest_identity_mode_check
    check (identity_mode in ('account_required', 'limited_guest')),
  constraint meeting_guest_visibility_check
    check (visibility in ('meeting_only', 'meeting_and_recap'))
);

create index meeting_guest_links_meeting_idx
  on meetings.guest_links (organization_id, meeting_id, id);

alter table meetings.guest_links enable row level security;
alter table meetings.guest_links force row level security;
create policy meeting_guest_links_tenant_isolation on meetings.guest_links
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_guest_links_tenant_boundary_guard on meetings.guest_links
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.guest_links to pie_app;

create table meetings.guest_sessions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  guest_link_id uuid not null,
  meeting_id uuid not null,
  user_id uuid not null,
  display_name text not null,
  email text,
  access_token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create index meeting_guest_sessions_meeting_idx
  on meetings.guest_sessions (organization_id, meeting_id, id);

alter table meetings.guest_sessions enable row level security;
alter table meetings.guest_sessions force row level security;
create policy meeting_guest_sessions_tenant_isolation on meetings.guest_sessions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_guest_sessions_tenant_boundary_guard on meetings.guest_sessions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.guest_sessions to pie_app;
