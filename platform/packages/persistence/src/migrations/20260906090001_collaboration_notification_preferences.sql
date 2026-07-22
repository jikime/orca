-- Durable user delivery preferences. DND suppresses only external delivery;
-- notification rows are still written so the in-app inbox remains complete.
create table collaboration.notification_preferences (
  organization_id uuid not null references identity.organizations (id),
  user_id uuid not null,
  desktop_enabled boolean not null default true,
  dnd_enabled boolean not null default false,
  dnd_start_minute integer not null default 1320,
  dnd_end_minute integer not null default 480,
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  constraint notification_preferences_dnd_start_check
    check (dnd_start_minute between 0 and 1439),
  constraint notification_preferences_dnd_end_check
    check (dnd_end_minute between 0 and 1439),
  constraint notification_preferences_timezone_length_check
    check (char_length(timezone) between 1 and 100)
);

create table collaboration.channel_notification_preferences (
  organization_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null,
  level text not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, channel_id, user_id),
  constraint channel_notification_preferences_channel_fk
    foreign key (organization_id, channel_id)
    references collaboration.channels (organization_id, id) on delete cascade,
  constraint channel_notification_preferences_level_check
    check (level in ('all', 'mentions', 'none'))
);

alter table collaboration.notifications
  drop constraint notifications_type_check,
  add constraint notifications_type_check check (type in ('mention', 'message'));

alter table collaboration.notification_preferences enable row level security;
alter table collaboration.notification_preferences force row level security;
create policy notification_preferences_tenant_isolation
  on collaboration.notification_preferences as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy notification_preferences_tenant_boundary_guard
  on collaboration.notification_preferences as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

alter table collaboration.channel_notification_preferences enable row level security;
alter table collaboration.channel_notification_preferences force row level security;
create policy channel_notification_preferences_tenant_isolation
  on collaboration.channel_notification_preferences as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy channel_notification_preferences_tenant_boundary_guard
  on collaboration.channel_notification_preferences as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update, delete on collaboration.notification_preferences to pie_app;
grant select, insert, update, delete on collaboration.channel_notification_preferences to pie_app;
