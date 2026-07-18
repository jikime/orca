-- R6 slice 5: PLANNING resource allocation + planned-vs-actual effort — the ACTUAL side of
-- R6's exit condition "계획 대비 일정·공수·비용과 인력 과투입을 조회한다" (doc 14 §R6: 인력 배정,
-- 계획/실제 공수(MM), 가동률). Slice 4 built the PLANNED side (WBS + immutable schedule baselines);
-- this slice adds who is assigned (resource_assignments) and what effort was actually logged
-- (effort_entries), so the variance read compares the frozen baseline (planned) against summed
-- actuals, and the utilization read surfaces person over-allocation. Same tenant model as the rest
-- of planning: composite (organization_id, id) keys + the permissive tenant_isolation + restrictive
-- tenant_boundary_guard + FORCE RLS pair keyed on pie.organization_id. project_id / wbs_node_id /
-- work_item_id / user_id are all OPAQUE cross-schema links (identity.users, delivery.*) — NO
-- cross-schema FK, mirroring wbs_nodes.work_item_id and crm.contract_projects.

-- planning.resource_assignments: a person (opaque user_id) committed to a project (and optionally a
-- specific wbs_node) over a period at some % of capacity. Over-allocation is DELIBERATELY not
-- restricted at write — a person CAN be booked past 100% across overlapping assignments; the
-- utilization read is what surfaces that. Only sanity checks are enforced: allocation_pct >= 0 and
-- start_date <= end_date. version is the OCC counter for :update.
create table planning.resource_assignments (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  wbs_node_id uuid,
  user_id uuid not null,
  allocation_pct numeric(6, 2) not null,
  start_date date not null,
  end_date date not null,
  planned_effort_hours numeric(12, 2),
  role_label text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- Sanity only — over-allocation across rows is allowed on purpose (see utilization read).
  constraint resource_assignments_allocation_check check (allocation_pct >= 0),
  constraint resource_assignments_period_check check (start_date <= end_date)
);

create index resource_assignments_project_idx
  on planning.resource_assignments (organization_id, project_id, user_id, start_date);

-- planning.effort_entries: ACTUAL logged effort, timesheet-like and APPEND-ONLY (INSERT + SELECT
-- only in app code — no update/delete route in this slice), mirroring the baseline_entries
-- immutability idiom. A correction is a NEW row (possibly negative-adjusting), so effort_hours is
-- constrained non-zero rather than strictly positive — that lets a later row net-out an over-log
-- without ever mutating history. wbs_node_id / work_item_id are OPTIONAL opaque links (no FK) so an
-- entry survives a node/work-item delete; the variance read joins actuals to a baseline entry by
-- wbs_node_id.
create table planning.effort_entries (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  wbs_node_id uuid,
  work_item_id uuid,
  user_id uuid not null,
  entry_date date not null,
  effort_hours numeric(12, 2) not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- Non-zero (not strictly positive): a correcting row may be negative to net-out a prior over-log.
  constraint effort_entries_hours_check check (effort_hours <> 0)
);

create index effort_entries_project_idx
  on planning.effort_entries (organization_id, project_id, entry_date);
create index effort_entries_node_idx
  on planning.effort_entries (organization_id, wbs_node_id);
create index effort_entries_user_idx
  on planning.effort_entries (organization_id, user_id, entry_date);

-- === RLS: the standard tenant pair on both new planning tables ===
do $$
declare
  t text;
begin
  foreach t in array array['resource_assignments', 'effort_entries']
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
