-- R7 slice: APPROVAL-GATED RUNBOOKS + WORK QUEUE. Carries the R7 scope line "승인형 Runbook과
-- 작업 큐" (doc 14 §R7) and the exit condition "Runbook은 대상·권한·승인·결과·롤백이 감사된다"
-- (a runbook execution's target, permission, approval, result, and rollback are all audited).
--
-- The load-bearing gate: a runbook_execution whose runbook requires_approval is created in
-- status='pending_approval' and CANNOT :run until an approver moves it to 'approved' — an
-- unapproved :run is refused (route → 422 RUNBOOK_NOT_APPROVED) and the refusal is audited
-- (mirrors the R6 change-request pre-approval execution gate).
--
-- Dedicated `automation` schema so runbook_id / target_id / subject_id / rollback_of_execution_id
-- are genuine OPAQUE cross-schema ids — no cross-schema FK, same-tenant integrity via the shared
-- organization_id (mirrors change.* / governance.* / knowledge.*).
create schema if not exists automation;
grant usage on schema automation to pie_app;
grant usage on schema automation to pie_worker;

-- automation.runbooks: a runbook DEFINITION.
--   steps is an ordered jsonb step list (opaque to the control plane — the executor interprets it).
--   target_kind names what this runbook operates on (project | ticket | environment).
--   requires_approval defaults true: an execution of this runbook is inert until an approver approves.
--   version is the OCC counter.
create table automation.runbooks (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  description text,
  steps jsonb not null default '[]'::jsonb,
  target_kind text not null,
  requires_approval boolean not null default true,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint runbooks_target_kind_check
    check (target_kind in ('project', 'ticket', 'environment'))
);

create index runbooks_org_idx on automation.runbooks (organization_id, id);

-- automation.runbook_executions: a single RUN of a runbook against one target.
--   runbook_id is the OPAQUE id of the runbook definition (no FK).
--   target_id + target_kind are the AUDITED target this run acts on (OPAQUE cross-schema id).
--   status walks pending_approval → approved → running → completed (or → failed), with reject and a
--     compensating rolled_back. approver_user_id + approved_at record the AUDITED approval.
--   result is the AUDITED jsonb outcome recorded at :complete.
--   rollback_of_execution_id is set on a compensating run that reverses an earlier run — the AUDITED
--     rollback references the run it reverses (OPAQUE same-table id, no FK; rollback-is-new-execution).
--   version is the OCC counter.
create table automation.runbook_executions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  runbook_id uuid not null,
  target_id uuid not null,
  target_kind text not null,
  status text not null default 'pending_approval',
  requested_by uuid,
  approver_user_id uuid,
  approved_at timestamptz,
  result jsonb,
  rollback_of_execution_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint runbook_executions_status_check
    check (
      status in (
        'pending_approval', 'approved', 'running', 'completed', 'failed', 'rolled_back', 'rejected'
      )
    )
);

create index runbook_executions_runbook_idx
  on automation.runbook_executions (organization_id, runbook_id, id);

-- automation.work_queue_items: a unit of work in the operator queue.
--   kind names the work category; subject_id is the OPAQUE id of what it tracks (e.g. a
--     runbook_execution or ticket — no FK).
--   status walks queued → claimed → in_progress → done (or cancelled). assignee_user_id is set on
--     :claim. priority orders the queue. version is the OCC counter.
create table automation.work_queue_items (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  title text not null,
  description text,
  kind text not null,
  subject_id uuid,
  status text not null default 'queued',
  assignee_user_id uuid,
  priority text not null default 'normal',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint work_queue_items_status_check
    check (status in ('queued', 'claimed', 'in_progress', 'done', 'cancelled')),
  constraint work_queue_items_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent'))
);

create index work_queue_items_org_idx on automation.work_queue_items (organization_id, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
alter table automation.runbooks enable row level security;
alter table automation.runbooks force row level security;
create policy runbooks_tenant_isolation on automation.runbooks
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy runbooks_tenant_boundary_guard on automation.runbooks
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on automation.runbooks to pie_app;

alter table automation.runbook_executions enable row level security;
alter table automation.runbook_executions force row level security;
create policy runbook_executions_tenant_isolation on automation.runbook_executions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy runbook_executions_tenant_boundary_guard on automation.runbook_executions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on automation.runbook_executions to pie_app;

alter table automation.work_queue_items enable row level security;
alter table automation.work_queue_items force row level security;
create policy work_queue_items_tenant_isolation on automation.work_queue_items
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy work_queue_items_tenant_boundary_guard on automation.work_queue_items
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on automation.work_queue_items to pie_app;
