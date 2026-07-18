-- R6 slice (last platform slice): PROJECT GOVERNANCE — RISK REGISTER + DECISION LOG + STATUS REPORTS.
-- Carries the R6 scope line "프로젝트 위험·의사결정·상태" (doc 14 §R6). A running project keeps a per-project
-- risk register (probability × impact ⇒ a computed severity), an append-oriented decision log (a
-- superseding decision is a NEW row referencing the prior via supersedes_id), and periodic status
-- reports (green|amber|red over a period). Dedicated `governance` schema so every reference to
-- delivery.projects (and the risk→decision link) is a genuine OPAQUE cross-schema id — no cross-schema
-- FK, same-tenant integrity via the shared organization_id (mirrors crm.contract_projects / qa.*).
create schema if not exists governance;
grant usage on schema governance to pie_app;
grant usage on schema governance to pie_worker;

-- governance.project_risks: a risk register entry against a running project. project_id / owner_user_id
-- are OPAQUE links (no FK). severity is DERIVED from probability × impact and STORED (computed on write,
-- never trusted from the caller). status walks open → mitigating → closed|accepted (a status change is
-- the OCC :transition). version is the OCC counter.
create table governance.project_risks (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  title text not null,
  description text,
  category text not null default 'technical',
  probability text not null default 'medium',
  impact text not null default 'medium',
  severity text not null default 'medium',
  status text not null default 'open',
  mitigation text,
  owner_user_id uuid,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint project_risks_category_check
    check (category in ('schedule', 'budget', 'technical', 'resource', 'external')),
  constraint project_risks_probability_check check (probability in ('low', 'medium', 'high')),
  constraint project_risks_impact_check check (impact in ('low', 'medium', 'high')),
  constraint project_risks_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint project_risks_status_check
    check (status in ('open', 'mitigating', 'closed', 'accepted'))
);

create index project_risks_project_idx
  on governance.project_risks (organization_id, project_id, severity, id);

-- governance.project_decisions: a decision log entry (append-oriented — a superseding decision is a NEW
-- row that references the one it replaces via supersedes_id). project_id / decided_by / related_risk_id /
-- supersedes_id are OPAQUE same-tenant links (no FK) so a superseded decision is never cascaded away.
-- version present for wire uniformity; decisions are not edited in place.
create table governance.project_decisions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  title text not null,
  context text,
  decision text not null,
  rationale text,
  decided_by uuid,
  decided_at timestamptz not null default now(),
  related_risk_id uuid,
  supersedes_id uuid,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create index project_decisions_project_idx
  on governance.project_decisions (organization_id, project_id, decided_at, id);

-- governance.status_reports: a periodic project status. period_start/period_end bound the reporting
-- window; overall_status is green|amber|red. project_id / reported_by are OPAQUE links (no FK). version
-- is the OCC counter for in-place edits of a draft report.
create table governance.status_reports (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  period_start date not null,
  period_end date not null,
  overall_status text not null default 'green',
  summary text not null,
  highlights text,
  risks_summary text,
  next_steps text,
  reported_by uuid,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint status_reports_overall_status_check
    check (overall_status in ('green', 'amber', 'red'))
);

create index status_reports_project_idx
  on governance.status_reports (organization_id, project_id, period_end, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
do $$
declare
  t text;
begin
  foreach t in array array['project_risks', 'project_decisions', 'status_reports']
  loop
    execute format('alter table governance.%I enable row level security', t);
    execute format('alter table governance.%I force row level security', t);
    execute format(
      'create policy %I on governance.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on governance.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on governance.%I to pie_app', t);
  end loop;
end
$$;
