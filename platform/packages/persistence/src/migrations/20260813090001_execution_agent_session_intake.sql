-- R5 slice 4b: UNASSIGNED agent-session INTAKE queue + explicit assign/reclassify + audit
-- (doc 14 §R5, doc 19 :162, doc 24 CAP-001). A session that exists with NO work_item binding
-- (started outside the app, or whose binding failed, or simply never bound) is NEVER
-- auto-attached to a project — CAP-001's mitigation is an UNASSIGNED QUEUE plus EXPLICIT user
-- binding. This table is that queue: exactly one intake row per unbound session, surfaced for a
-- human to assign to a work item (which is the only path that sets session.work_item_id).
--
-- Same tenant model as the rest of execution/*: composite (organization_id, id) key + composite
-- same-tenant FK to agent_sessions so an intake row can never reference another org's session,
-- and the permissive tenant_isolation + restrictive tenant_boundary_guard + FORCE RLS pair keyed
-- on pie.organization_id. Unlike the append-only event/provenance logs, the intake row is a
-- MUTABLE queue projection (pending → assigned/dismissed), so pie_app also gets UPDATE; the
-- immutable trail of who assigned/reclassified/dismissed lives in audit.audit_events.
create table execution.agent_session_intake (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  agent_session_id uuid not null,
  -- The reason this session landed in intake. Extensible; `unassigned_agent_session` is the only
  -- source now (doc 19 :162). Kept as its own column so a future source (e.g. a denied auto-bind)
  -- is additive.
  source_type text not null default 'unassigned_agent_session',
  status text not null default 'pending',
  -- WHY the binding is absent. `no_work_item` is what the server derives today from the absence
  -- of a work_item on create/ingest; `binding_failed`/`started_outside_app` are reclassification
  -- targets for a future client-side signal (TODO pie-r5-s4b-live).
  detected_reason text not null default 'no_work_item',
  -- Capture scope carried for SEARCH/filter (doc 24: host scope). host_id/provider come from the
  -- session; workspace_id from the ingest event context (nullable — a create has no workspace).
  host_id uuid not null,
  workspace_id uuid,
  provider text not null,
  -- The assign target. OPAQUE forward link to a WorkItem in the delivery schema — NO cross-schema
  -- FK (mirrors message_work_item_links / agent_provenance). Set only on an explicit assign; the
  -- work item's existence is validated by a higher layer (follow-up), not here.
  work_item_id uuid,
  assigned_by uuid references identity.user_accounts (id),
  assigned_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- Exactly one intake row per session: the creation hook upserts on this key, so replayed
  -- events / repeated creates never spawn a duplicate intake row (idempotency).
  constraint agent_session_intake_session_unique unique (organization_id, agent_session_id),
  constraint agent_session_intake_session_fk
    foreign key (organization_id, agent_session_id)
    references execution.agent_sessions (organization_id, id),
  constraint agent_session_intake_source_type_check
    check (source_type in ('unassigned_agent_session')),
  constraint agent_session_intake_status_check
    check (status in ('pending', 'assigned', 'dismissed')),
  constraint agent_session_intake_detected_reason_check
    check (detected_reason in ('no_work_item', 'binding_failed', 'started_outside_app')),
  -- An assigned row must carry its binding provenance; a non-assigned row must not claim one.
  constraint agent_session_intake_assigned_coherent
    check (
      (status = 'assigned') =
      (work_item_id is not null and assigned_by is not null and assigned_at is not null)
    )
);

-- Pending-queue read, newest-first, keyset-paged by (created_at, id).
create index agent_session_intake_status_idx
  on execution.agent_session_intake (organization_id, status, created_at desc, id);
-- Search facets (doc 24 host scope): filter the queue by host / workspace / provider.
create index agent_session_intake_host_idx
  on execution.agent_session_intake (organization_id, host_id);
create index agent_session_intake_workspace_idx
  on execution.agent_session_intake (organization_id, workspace_id)
  where workspace_id is not null;
create index agent_session_intake_provider_idx
  on execution.agent_session_intake (organization_id, provider);
-- Assigned-work-item lookup (opaque link).
create index agent_session_intake_work_item_idx
  on execution.agent_session_intake (organization_id, work_item_id)
  where work_item_id is not null;

alter table execution.agent_session_intake enable row level security;
alter table execution.agent_session_intake force row level security;
create policy agent_session_intake_tenant_isolation on execution.agent_session_intake
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_session_intake_tenant_boundary_guard on execution.agent_session_intake
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
-- The queue is mutable (pending → assigned/dismissed with an OCC version bump), so pie_app gets
-- UPDATE here — but the audit trail of the transitions is append-only in audit.audit_events.
grant select, insert, update on execution.agent_session_intake to pie_app;
