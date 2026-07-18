-- R6 slice: QA — DELIVERABLES + TEST CASES + DEFECTS. Completes the exit condition
-- "요구사항이 작업, 코드, 테스트, 산출물, 검수까지 추적된다" (doc 14 §R6) by adding the test/deliverable/
-- defect layer on top of R6 s2 (requirements + requirement→work_item + acceptances). A requirement
-- traces DOWN to the deliverables (산출물) it produces, the test_cases that verify it, and the defects
-- raised against those tests/deliverables — the qa-traceability read ties all three back to one
-- requirement.
--
-- Dedicated `qa` schema: every reference this context makes — project_id → delivery.projects,
-- requirement_id → requirements.requirements, wbs_node_id → planning.wbs_nodes, work_item_id →
-- delivery.work_items — is a CROSS-schema link kept deliberately OPAQUE (no cross-schema FK,
-- same-tenant integrity via the shared organization_id, mirroring crm.contract_projects and
-- requirements.requirement_work_items). Only the internal defect → test_case / deliverable edges are
-- same-tenant opaque ids too (no FK) so a test_case/deliverable delete never cascades a defect away.
-- Same tenant model as the rest: composite (organization_id, id) PK + FORCE RLS pair on
-- pie.organization_id.
create schema if not exists qa;
grant usage on schema qa to pie_app;
grant usage on schema qa to pie_worker;

-- qa.deliverables: a project deliverable (산출물). project_id is required; requirement_id / wbs_node_id
-- are OPTIONAL opaque links (nullable, no FK). status walks planned → in_progress → submitted →
-- accepted|rejected; accepting a deliverable is the OCC :transition. version is the OCC counter.
create table qa.deliverables (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  -- Opaque cross-schema links: no FK to delivery.projects / requirements / planning.wbs_nodes.
  project_id uuid not null,
  requirement_id uuid,
  wbs_node_id uuid,
  name text not null,
  description text,
  status text not null default 'planned',
  due_date date,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint deliverables_status_check
    check (status in ('planned', 'in_progress', 'submitted', 'accepted', 'rejected'))
);

create index deliverables_project_idx
  on qa.deliverables (organization_id, project_id, created_at, id);
create index deliverables_requirement_idx
  on qa.deliverables (organization_id, requirement_id);

-- qa.test_cases: a test case verifying a requirement / work item. requirement_id / work_item_id are
-- OPTIONAL opaque links (nullable, no FK). status walks draft → ready → passed|failed|blocked (a
-- pass/fail is the OCC :transition). version is the OCC counter.
create table qa.test_cases (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  requirement_id uuid,
  work_item_id uuid,
  title text not null,
  steps text,
  expected text,
  status text not null default 'draft',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint test_cases_status_check
    check (status in ('draft', 'ready', 'passed', 'failed', 'blocked'))
);

create index test_cases_requirement_idx
  on qa.test_cases (organization_id, requirement_id, created_at, id);
create index test_cases_work_item_idx
  on qa.test_cases (organization_id, work_item_id);

-- qa.defects: a defect raised against a project, optionally tied to the test_case that found it, the
-- work item that owns the fix, or the deliverable it blocks (all OPTIONAL opaque links, no FK). status
-- walks open → triaged → in_progress → resolved → closed (or wontfix); a status change is the OCC
-- :transition. severity is low|medium|high|critical. version is the OCC counter.
create table qa.defects (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  test_case_id uuid,
  work_item_id uuid,
  deliverable_id uuid,
  title text not null,
  description text,
  severity text not null default 'medium',
  status text not null default 'open',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint defects_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint defects_status_check
    check (status in ('open', 'triaged', 'in_progress', 'resolved', 'closed', 'wontfix'))
);

create index defects_project_idx
  on qa.defects (organization_id, project_id, created_at, id);
create index defects_test_case_idx
  on qa.defects (organization_id, test_case_id);
create index defects_deliverable_idx
  on qa.defects (organization_id, deliverable_id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
do $$
declare
  t text;
begin
  foreach t in array array['deliverables', 'test_cases', 'defects']
  loop
    execute format('alter table qa.%I enable row level security', t);
    execute format('alter table qa.%I force row level security', t);
    execute format(
      'create policy %I on qa.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on qa.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on qa.%I to pie_app', t);
  end loop;
end
$$;
