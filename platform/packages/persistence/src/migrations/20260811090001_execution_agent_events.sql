-- R5 slice 1: Control-Plane AGENT-EVENT INGEST + SESSION/TURN TIMELINE PROJECTION
-- (doc 14 §R5, doc 19 AgentEventEnvelope :203-236, doc 20 CAP-001..008). This is the
-- authority layer for AI execution tracking: the Control Plane is the sole source of
-- truth for agent sessions, the append-only event log, and the projected turn timeline.
-- The Electron SQLite outbox/cursor/quota (R5 s2), Hooks + transcript reconciler (s3),
-- and file/Artifact/commit provenance (s4) are LATER slices that FEED this backbone.
--
-- Same tenant model as the collaboration/support verticals: composite
-- (organization_id, id) keys + composite same-tenant FKs so a child can never reference
-- another org's session, and the permissive tenant_isolation + restrictive
-- tenant_boundary_guard + FORCE RLS pair keyed on pie.organization_id.
create schema if not exists execution;
grant usage on schema execution to pie_app;
grant usage on schema execution to pie_worker;

-- agent_sessions: one Claude Code / Codex agent session (doc 19). work_item_id is an
-- OPAQUE forward link with NO cross-schema FK (mirrors message_work_item_links) — the
-- unassigned-session search + assign flow is s4. status gates ingest: a closed/terminated
-- session accepts no further events. provider is the agent tool; provider_session_id is
-- the tool's own id. host_id/launch_id are the client-observed origin (opaque uuids).
create table execution.agent_sessions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  work_item_id uuid,
  provider text not null,
  provider_session_id text,
  host_id uuid not null,
  launch_id uuid,
  status text not null default 'active',
  visibility text not null,
  classification text not null,
  created_by uuid not null references identity.user_accounts (id),
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint agent_sessions_provider_check
    check (provider in ('claude_code', 'codex', 'opencode', 'other')),
  constraint agent_sessions_status_check
    check (status in ('active', 'closed', 'terminated')),
  constraint agent_sessions_visibility_check
    check (visibility in ('internal', 'project', 'customer')),
  constraint agent_sessions_classification_check
    check (classification in ('public', 'internal', 'project_confidential', 'restricted'))
);

create index agent_sessions_org_idx
  on execution.agent_sessions (organization_id, created_at desc, id);
create index agent_sessions_work_item_idx
  on execution.agent_sessions (organization_id, work_item_id)
  where work_item_id is not null;

alter table execution.agent_sessions enable row level security;
alter table execution.agent_sessions force row level security;
create policy agent_sessions_tenant_isolation on execution.agent_sessions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_sessions_tenant_boundary_guard on execution.agent_sessions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update on execution.agent_sessions to pie_app;

-- agent_events: the append-only envelope log (doc 19 :203). event_id is the client's
-- retry-stable idempotency key — UNIQUE (organization_id, event_id) makes a replayed
-- event a no-op (doc 19 :231, CAP-003). stream_id + sequence is for per-stream GAP
-- DETECTION only; we NEVER synthesize a cross-host global order from client time, so
-- occurred_at (envelope time), captured_at (client), and received_at (server-stamped)
-- are kept distinct (CAP-007 clock skew). assertion is persisted verbatim so a caller
-- can never silently treat `declared` as `observed` (doc 19 :218-220). trust_domain /
-- producer_type are kept distinct from server verification: a `client_observed` event
-- means "this client installation observed it", NOT server-verified (doc 19 :224-226).
-- content_hash (when present in payload) is what finalizes a turn revision.
create table execution.agent_events (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  agent_session_id uuid not null,
  schema_version integer not null default 1,
  stream_id uuid not null,
  sequence bigint not null,
  type text not null,
  source_uri text not null,
  subject text not null,
  producer_id uuid not null,
  producer_type text not null,
  provider text not null,
  parser_version text not null,
  trust_domain text not null,
  assertion text not null,
  classification text not null,
  visibility text not null,
  agent_run_id uuid,
  turn_id uuid,
  -- subagentId is doc 19 envelope field; the sub-agent reconciler is s3, so it is
  -- persisted but not yet populated. TODO(pie-r5): s3 fills this from the reconciler.
  subagent_id uuid,
  occurred_at timestamptz not null,
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  content_hash text,
  payload jsonb,
  payload_object jsonb,
  correlation_id uuid,
  causation_id uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- Idempotency key per org: a replayed eventId never creates a duplicate row.
  constraint agent_events_event_id_unique unique (organization_id, event_id),
  constraint agent_events_session_fk
    foreign key (organization_id, agent_session_id)
    references execution.agent_sessions (organization_id, id),
  constraint agent_events_sequence_check check (sequence >= 1),
  constraint agent_events_producer_type_check
    check (producer_type in ('hook', 'transcript_reconciler', 'runtime_observer', 'mcp')),
  constraint agent_events_assertion_check
    check (assertion in ('observed', 'declared', 'verified')),
  constraint agent_events_trust_domain_check
    check (trust_domain in ('client_observed', 'provider_asserted', 'server_verified')),
  -- Exactly one payload carrier (doc 19: `payload or payloadObjectId`).
  constraint agent_events_payload_present
    check ((payload is not null) <> (payload_object is not null))
);

-- Per-stream ordering + gap-detection index (order within a stream by sequence).
create unique index agent_events_stream_sequence_idx
  on execution.agent_events (organization_id, agent_session_id, stream_id, sequence);
create index agent_events_turn_idx
  on execution.agent_events (organization_id, agent_session_id, turn_id, sequence)
  where turn_id is not null;

alter table execution.agent_events enable row level security;
alter table execution.agent_events force row level security;
create policy agent_events_tenant_isolation on execution.agent_events
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_events_tenant_boundary_guard on execution.agent_events
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
-- Append-only (doc 19 :203, mirrors agent.artifact_revisions): pie_app may INSERT + SELECT
-- only, never UPDATE/DELETE. Corrections are new events, not mutations of history.
grant select, insert on execution.agent_events to pie_app;

-- agent_turns: the projected timeline (doc 19 :235-236, CAP-004). A streaming event with a
-- turnId makes/updates a PROVISIONAL turn; a confirmed content_hash (from an `observed`/
-- `verified` event) finalizes the turn to an IMMUTABLE revision. Only `observed`/`verified`
-- may finalize — `declared`/`inferred` is never evidence of completion (doc 19 :218-220).
-- This is a projection over the append-only log, so it is mutable (provisional→finalized)
-- but a finalized turn's content_hash is never overwritten (enforced in the store).
create table execution.agent_turns (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  agent_session_id uuid not null,
  turn_id uuid not null,
  status text not null default 'provisional',
  content_hash text,
  first_sequence bigint not null,
  last_sequence bigint not null,
  first_stream_id uuid not null,
  revision integer not null default 0,
  event_count integer not null default 0,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- One projected turn per logical turnId per session.
  constraint agent_turns_logical_unique unique (organization_id, agent_session_id, turn_id),
  constraint agent_turns_session_fk
    foreign key (organization_id, agent_session_id)
    references execution.agent_sessions (organization_id, id),
  constraint agent_turns_status_check check (status in ('provisional', 'finalized'))
);

create index agent_turns_session_idx
  on execution.agent_turns (organization_id, agent_session_id, first_sequence, id);

alter table execution.agent_turns enable row level security;
alter table execution.agent_turns force row level security;
create policy agent_turns_tenant_isolation on execution.agent_turns
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_turns_tenant_boundary_guard on execution.agent_turns
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update on execution.agent_turns to pie_app;
