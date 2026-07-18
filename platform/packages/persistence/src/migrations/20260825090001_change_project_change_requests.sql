-- R6 (project-execution level): PROJECT CHANGE REQUESTS + CUSTOMER APPROVAL. Carries the R6
-- exit condition at the EXECUTION level — "계약 범위와 변경 범위를 구분하고 승인 전 실행을
-- 제한한다" (doc 14 §R6). R6 s1 gated CONTRACT scope; THIS gates a scope/schedule/cost change
-- proposed WHILE a project runs: the change is inert until a customer approves, and :apply
-- (the execution step) is refused unless status = 'approved'. New `change` schema so the link
-- to delivery.projects is a genuine OPAQUE cross-schema id (no FK — mirrors crm.contract_projects).
create schema if not exists change;
grant usage on schema change to pie_app;
grant usage on schema change to pie_worker;

-- change.change_requests: a proposed scope/schedule/cost change against a running project.
-- project_id / wbs_node_id / requirement_id are OPAQUE ids into other schemas (delivery/planning/
-- requirements) — deliberately NO cross-schema FK. status is the pre-approval execution gate:
-- draft → submitted → approved|rejected, and approved → applied is the EXECUTION step. approver_
-- user_id + decided_at record who decided (approver ≠ requester); applied_at records execution.
create table change.change_requests (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  wbs_node_id uuid,
  requirement_id uuid,
  title text not null,
  description text,
  status text not null default 'draft',
  scope_delta text,
  schedule_delta_days integer,
  cost_delta numeric(18, 2),
  requested_by uuid,
  approver_user_id uuid,
  decided_at timestamptz,
  applied_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint change_requests_status_check
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'applied'))
);

create index change_requests_project_idx
  on change.change_requests (organization_id, project_id, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
alter table change.change_requests enable row level security;
alter table change.change_requests force row level security;
create policy change_requests_tenant_isolation on change.change_requests
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy change_requests_tenant_boundary_guard on change.change_requests
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on change.change_requests to pie_app;
