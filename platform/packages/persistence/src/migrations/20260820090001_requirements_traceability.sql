-- R6 slice 2: REQUIREMENTS + TRACEABILITY MATRIX — the load-bearing exit condition
-- "요구사항이 작업, 코드, 테스트, 산출물, 검수까지 추적된다" (doc 14 §R6). A requirement traces UP to a
-- crm contract scope line it realizes, and DOWN to the delivery work items that implement it; each
-- work item in turn carries execution.agent_provenance evidence (code/test/build/artifact) and the
-- requirement carries acceptance (검수) records — the full chain a PM can audit for coverage/gaps.
--
-- Dedicated `requirements` schema (NOT crm, NOT delivery): every reference this context makes —
-- project_id → delivery.projects, contract_scope_item_id → crm.contract_scope_items, the linked
-- work_item_id → delivery.work_items, and provenance read via that work_item_id in execution — is a
-- CROSS-schema link. Keeping requirements in their own schema makes all four uniformly OPAQUE ids
-- with NO cross-schema FK (same-tenant integrity via the shared organization_id stands in, mirroring
-- crm.contract_projects and collaboration.message_work_item_links). Only the internal parent→child
-- edges (requirement → its links / acceptances) use same-schema composite FKs. Same tenant model as
-- crm/delivery: composite (organization_id, id) PK + FORCE RLS pair keyed on pie.organization_id.
create schema if not exists requirements;
grant usage on schema requirements to pie_app;
grant usage on schema requirements to pie_worker;

-- requirements.requirements: a requirement belongs to a project (opaque project_id) and OPTIONALLY
-- realizes one contract scope line (opaque contract_scope_item_id into crm — nullable, no FK). code
-- is the human key, unique per project. status walks draft → approved → implemented → verified →
-- accepted (or rejected). version is the OCC concurrency counter (If-Match), also the exposed
-- resource version. source records where the requirement originated (customer/contract/internal).
create table requirements.requirements (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  -- Opaque cross-schema links: no FK to delivery.projects / crm.contract_scope_items.
  project_id uuid not null,
  contract_scope_item_id uuid,
  code text not null,
  title text not null,
  description text,
  status text not null default 'draft',
  priority text not null default 'medium',
  source text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint requirements_code_unique unique (organization_id, project_id, code),
  constraint requirements_status_check
    check (status in ('draft', 'approved', 'implemented', 'verified', 'accepted', 'rejected')),
  constraint requirements_priority_check
    check (priority in ('none', 'low', 'medium', 'high', 'urgent'))
);

create index requirements_project_idx
  on requirements.requirements (organization_id, project_id, created_at, id);

-- requirements.requirement_work_items: the many-to-many trace DOWN to the work items that implement
-- a requirement. work_item_id is an OPAQUE id into delivery.work_items (no cross-schema FK). The link
-- to its OWN requirement is a same-schema composite FK; unique per (req, work_item) makes a re-link
-- idempotent.
create table requirements.requirement_work_items (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  requirement_id uuid not null,
  work_item_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint requirement_work_items_requirement_fk
    foreign key (organization_id, requirement_id)
    references requirements.requirements (organization_id, id)
    on delete cascade,
  constraint requirement_work_items_unique
    unique (organization_id, requirement_id, work_item_id)
);

create index requirement_work_items_requirement_idx
  on requirements.requirement_work_items (organization_id, requirement_id);
create index requirement_work_items_work_item_idx
  on requirements.requirement_work_items (organization_id, work_item_id);

-- requirements.requirement_acceptances: the 검수 record per requirement. APPEND-ONLY like provenance
-- (pie_app gets INSERT + SELECT only, no UPDATE/DELETE) — an acceptance is evidence of a decision, so a
-- change is a NEW revision row, never a mutation. result is pass|fail|conditional; deliverable_ref is
-- an OPAQUE id to the artifact/deliverable the acceptance was made against (no cross-schema FK).
create table requirements.requirement_acceptances (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  requirement_id uuid not null,
  result text not null,
  accepted_by uuid not null,
  accepted_at timestamptz not null default now(),
  notes text,
  deliverable_ref uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint requirement_acceptances_requirement_fk
    foreign key (organization_id, requirement_id)
    references requirements.requirements (organization_id, id)
    on delete cascade,
  constraint requirement_acceptances_result_check
    check (result in ('pass', 'fail', 'conditional')),
  constraint requirement_acceptances_revision_check check (revision >= 1)
);

create index requirement_acceptances_requirement_idx
  on requirements.requirement_acceptances (organization_id, requirement_id, accepted_at, id);

-- === RLS: the standard tenant pair on every requirements table ===
do $$
declare
  t text;
begin
  foreach t in array array[
    'requirements', 'requirement_work_items', 'requirement_acceptances'
  ]
  loop
    execute format('alter table requirements.%I enable row level security', t);
    execute format('alter table requirements.%I force row level security', t);
    execute format(
      'create policy %I on requirements.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on requirements.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
  end loop;
end
$$;

-- requirements + link table are mutable (transitions, link/unlink); acceptances are append-only
-- evidence (INSERT + SELECT only), mirroring execution.agent_provenance.
grant select, insert, update, delete on requirements.requirements to pie_app;
grant select, insert, delete on requirements.requirement_work_items to pie_app;
grant select, insert on requirements.requirement_acceptances to pie_app;
