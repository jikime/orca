-- Reviewable meeting outcomes. AI suggestions stay proposed until a human approves them.
create table meetings.decisions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  minutes_id uuid,
  statement text not null,
  status text not null default 'proposed',
  owner_user_id uuid,
  project_id uuid,
  ticket_id uuid,
  evidence_segment_id uuid,
  created_by text not null,
  review_status text not null default 'unreviewed',
  reviewed_by uuid,
  reviewed_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint meeting_decisions_minutes_fk
    foreign key (organization_id, minutes_id)
    references meetings.minutes (organization_id, id) on delete cascade,
  constraint meeting_decisions_evidence_fk
    foreign key (organization_id, evidence_segment_id)
    references meetings.transcript_segments (organization_id, id) on delete set null,
  constraint meeting_decisions_statement_check check (length(btrim(statement)) > 0),
  constraint meeting_decisions_status_check
    check (status in ('proposed', 'confirmed', 'superseded', 'rejected')),
  constraint meeting_decisions_creator_check check (created_by in ('ai', 'user')),
  constraint meeting_decisions_review_check
    check (review_status in ('unreviewed', 'approved', 'rejected'))
);

create index meeting_decisions_meeting_idx
  on meetings.decisions (organization_id, meeting_id, created_at, id);

create table meetings.action_items (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  minutes_id uuid,
  task text not null,
  assignee_user_id uuid,
  assignee_label text,
  due_at timestamptz,
  due_text text,
  priority text not null default 'none',
  status text not null default 'proposed',
  project_id uuid,
  ticket_id uuid,
  work_item_id uuid,
  evidence_segment_id uuid,
  created_by text not null,
  review_status text not null default 'unreviewed',
  reviewed_by uuid,
  reviewed_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint meeting_action_items_minutes_fk
    foreign key (organization_id, minutes_id)
    references meetings.minutes (organization_id, id) on delete cascade,
  constraint meeting_action_items_evidence_fk
    foreign key (organization_id, evidence_segment_id)
    references meetings.transcript_segments (organization_id, id) on delete set null,
  constraint meeting_action_items_task_check check (length(btrim(task)) > 0),
  constraint meeting_action_items_priority_check
    check (priority in ('none', 'urgent', 'high', 'medium', 'low')),
  constraint meeting_action_items_status_check
    check (status in ('proposed', 'accepted', 'in_progress', 'completed', 'cancelled')),
  constraint meeting_action_items_creator_check check (created_by in ('ai', 'user')),
  constraint meeting_action_items_review_check
    check (review_status in ('unreviewed', 'approved', 'rejected'))
);

create index meeting_action_items_meeting_idx
  on meetings.action_items (organization_id, meeting_id, created_at, id);
create unique index meeting_action_items_work_item_unique
  on meetings.action_items (organization_id, work_item_id) where work_item_id is not null;

alter table meetings.decisions enable row level security;
alter table meetings.decisions force row level security;
create policy meeting_decisions_tenant_isolation on meetings.decisions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_decisions_tenant_boundary_guard on meetings.decisions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

alter table meetings.action_items enable row level security;
alter table meetings.action_items force row level security;
create policy meeting_action_items_tenant_isolation on meetings.action_items
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_action_items_tenant_boundary_guard on meetings.action_items
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update, delete on meetings.decisions to pie_app;
grant select, insert, update, delete on meetings.action_items to pie_app;
