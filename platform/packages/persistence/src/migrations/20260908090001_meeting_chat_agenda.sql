-- A meeting keeps agenda items promoted from its canonical chat channel. The
-- source message is unique so retries cannot create duplicate agenda entries.
alter table collaboration.channels drop constraint channels_scope_type_check;
alter table collaboration.channels
  add constraint channels_scope_type_check
    check (scope_type in ('organization', 'team', 'project', 'customer', 'ticket', 'meeting'));

create table meetings.agenda_items (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  source_channel_id uuid not null,
  source_message_id uuid not null,
  body text not null,
  status text not null default 'planned',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint meeting_agenda_status_check check (status in ('planned', 'discussed', 'dropped')),
  constraint meeting_agenda_body_check check (char_length(body) between 1 and 4000),
  unique (organization_id, meeting_id, source_message_id)
);

create index meeting_agenda_meeting_idx
  on meetings.agenda_items (organization_id, meeting_id, created_at, id);

alter table meetings.agenda_items enable row level security;
alter table meetings.agenda_items force row level security;
create policy meeting_agenda_tenant_isolation on meetings.agenda_items
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_agenda_tenant_boundary_guard on meetings.agenda_items
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.agenda_items to pie_app;
