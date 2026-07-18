-- R6 slice 4: PLANNING bounded context — the planned-schedule backbone (WBS tree +
-- milestones + captured schedule baselines) that R6's "계획 대비 일정·공수·비용" exit
-- condition compares actuals against (doc 14 §R6: WBS, 마일스톤, 간트, 기준선). This slice
-- builds only the PLANNED side; actuals/variance is a later slice. Same tenant model as
-- delivery/crm: composite (organization_id, id) keys + composite FKs, and the permissive
-- tenant_isolation + restrictive tenant_boundary_guard + FORCE RLS pair keyed on
-- pie.organization_id. project_id / work_item_id / wbs_node_id that reach into delivery are
-- OPAQUE cross-schema links (no cross-schema FK); only the WBS tree self-FK (parent_id) is
-- an in-schema composite FK.
create schema if not exists planning;
grant usage on schema planning to pie_app;
grant usage on schema planning to pie_worker;

-- planning.wbs_nodes: the Work Breakdown Structure tree. project_id is an OPAQUE id into
-- delivery.projects; work_item_id an OPAQUE id into delivery.work_items (a leaf mapping) —
-- neither is a cross-schema FK. parent_id is the in-schema tree self-FK: a composite FK on
-- (organization_id, parent_id) → (organization_id, id) so a node's parent is always same-org,
-- and a root node has null parent. Cycles (a node its own ancestor) are guarded in app code on
-- insert/move — a composite FK alone cannot forbid a cycle. Summary nodes may leave dates/effort
-- null and have them ROLLED UP from descendants on read; leaves store their own planned values.
create table planning.wbs_nodes (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  parent_id uuid,
  wbs_code text not null,
  name text not null,
  node_type text not null default 'task',
  sort_order integer not null default 0,
  planned_start date,
  planned_end date,
  planned_effort_hours numeric(12, 2),
  work_item_id uuid,
  status text not null default 'planned',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint wbs_nodes_project_code_unique unique (organization_id, project_id, wbs_code),
  constraint wbs_nodes_node_type_check
    check (node_type in ('summary', 'task', 'deliverable')),
  constraint wbs_nodes_status_check
    check (status in ('planned', 'in_progress', 'done', 'cancelled')),
  -- The tree self-FK: parent must be an existing node in the SAME org (a child can never
  -- reference a parent in another org). Deleting a parent cascades to its subtree.
  constraint wbs_nodes_parent_fk
    foreign key (organization_id, parent_id) references planning.wbs_nodes (organization_id, id)
    on delete cascade
);

create index wbs_nodes_project_idx
  on planning.wbs_nodes (organization_id, project_id, parent_id, sort_order);

-- planning.milestones: a dated checkpoint on a project (opaque project_id). wbs_node_id is an
-- OPTIONAL opaque link to the WBS node the milestone tracks (no FK, so the milestone survives a
-- node delete). status is the checkpoint state; version is the OCC counter for :transition.
create table planning.milestones (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  wbs_node_id uuid,
  name text not null,
  target_date date not null,
  status text not null default 'planned',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint milestones_status_check
    check (status in ('planned', 'met', 'missed', 'at_risk'))
);

create index milestones_project_idx
  on planning.milestones (organization_id, project_id, target_date);

-- planning.schedule_baselines: the header of an immutable SNAPSHOT of a project's planned WBS
-- schedule at capture time. Append-only (like agent_provenance): once captured it is never
-- mutated — it is the frozen reference a later variance slice compares actuals against.
create table planning.schedule_baselines (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  name text not null,
  captured_by uuid,
  entry_count integer not null default 0,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create index schedule_baselines_project_idx
  on planning.schedule_baselines (organization_id, project_id, captured_at);

-- planning.baseline_entries: one immutable row per WBS node copied at capture time. Append-only
-- (INSERT + SELECT only in app code) so a later edit to the live wbs_node CANNOT alter the
-- snapshot — that unchangeability is the whole point of a baseline. wbs_node_id/parent_id are
-- RECORDED ids only (no FK) so the entry survives even if the source node is later deleted;
-- baseline_id is an in-schema composite FK to the header.
create table planning.baseline_entries (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  baseline_id uuid not null,
  wbs_node_id uuid not null,
  parent_id uuid,
  wbs_code text not null,
  name text not null,
  node_type text not null,
  sort_order integer not null default 0,
  planned_start date,
  planned_end date,
  planned_effort_hours numeric(12, 2),
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint baseline_entries_baseline_fk
    foreign key (organization_id, baseline_id)
    references planning.schedule_baselines (organization_id, id)
    on delete cascade
);

create index baseline_entries_baseline_idx
  on planning.baseline_entries (organization_id, baseline_id, sort_order);

-- === RLS: the standard tenant pair on every planning table ===
do $$
declare
  t text;
begin
  foreach t in array array['wbs_nodes', 'milestones', 'schedule_baselines', 'baseline_entries']
  loop
    execute format('alter table planning.%I enable row level security', t);
    execute format('alter table planning.%I force row level security', t);
    execute format(
      'create policy %I on planning.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on planning.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on planning.%I to pie_app', t);
  end loop;
end
$$;
