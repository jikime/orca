-- R4 slice 1: delivery bounded context — Team + Project foundation (doc 30:104-136,
-- 242-257). Same tenant model as identity/operations: composite (organization_id,
-- id) keys + composite FKs so a child can never reference a parent in another org,
-- and the permissive tenant_isolation + restrictive tenant_boundary_guard + FORCE
-- RLS pair keyed on pie.organization_id. Only the tables THIS slice needs;
-- work_items/workflow_states/etc. arrive in slices 2-3.
create schema if not exists delivery;
grant usage on schema delivery to pie_app;
grant usage on schema delivery to pie_worker;

-- delivery.teams: the workflow owner. key is org-unique and matches team.v1.
create table delivery.teams (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  key text not null,
  name text not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint teams_org_key_unique unique (organization_id, key),
  constraint teams_key_pattern check (key ~ '^[A-Z][A-Z0-9]{1,9}$')
);

-- delivery.team_counters: per-team next WorkItem sequence. Created now so a Team
-- owns its counter from creation (WorkItem consumes it in slice 2).
create table delivery.team_counters (
  organization_id uuid not null,
  team_id uuid not null,
  next_sequence bigint not null default 1,
  primary key (organization_id, team_id),
  constraint team_counters_team_fk
    foreign key (organization_id, team_id) references delivery.teams (organization_id, id)
    on delete cascade
);

-- delivery.projects: project.v1 fields only this slice (customer/contract/health/
-- period land in the Planning Gate slices).
create table delivery.projects (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  summary text,
  status text not null default 'planned',
  version bigint not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint projects_status_check
    check (status in ('planned', 'active', 'paused', 'completed', 'cancelled'))
);

create index projects_active_idx
  on delivery.projects (organization_id, id)
  where archived_at is null;

-- delivery.project_teams: Project↔Team many-to-many with same-tenant composite FKs
-- so a project can never link another org's team.
create table delivery.project_teams (
  organization_id uuid not null,
  project_id uuid not null,
  team_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, project_id, team_id),
  constraint project_teams_project_fk
    foreign key (organization_id, project_id) references delivery.projects (organization_id, id)
    on delete cascade,
  constraint project_teams_team_fk
    foreign key (organization_id, team_id) references delivery.teams (organization_id, id)
    on delete cascade
);

-- === RLS: the standard tenant pair on every delivery table ===
do $$
declare
  t text;
begin
  foreach t in array array['teams', 'team_counters', 'projects', 'project_teams']
  loop
    execute format('alter table delivery.%I enable row level security', t);
    execute format('alter table delivery.%I force row level security', t);
    execute format(
      'create policy %I on delivery.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on delivery.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on delivery.%I to pie_app', t);
  end loop;
end
$$;
