-- R5 slice 5a: CAPTURE MODE + per-scope VISIBILITY enforcement + SERVER-SIDE REDACTION
-- (doc 14 §R5 "project capture mode / 기록 표시·pause / local·server redaction" +
-- "turn·tool output·Artifact별 내부·프로젝트·고객 visibility"; doc 19 :327 "AgentSession 전체와
-- 개별 turn·artifact는 서로 다른 visibility를 가질 수 있다"; doc 24 CAP-002 server-side half).
--
-- This slice is ADDITIVE + backfill-safe on the merged R5 backbone. It (1) constrains the
-- previously free-string per-event visibility/classification vocabulary with CHECK constraints
-- after backfilling any legacy value to the MOST-RESTRICTIVE tier (default-deny), (2) adds a
-- per-session capture_mode + a project-level default it inherits, and (3) adds an append-only
-- capture-gap tombstone so a PAUSED session shows an explicit gap on the timeline rather than a
-- silent false-complete.

-- (1) Constrain the per-event visibility + classification vocabulary. The columns already exist
-- as free strings (s1); harden them AFTER coercing any out-of-vocabulary legacy row to the most
-- restrictive tier so no existing data is weakened and the CHECK can never fail on backfill.
-- Unknown visibility → 'internal' (Pie-internal, the narrowest audience). Unknown classification
-- → 'restricted' (the most sensitive tier, always redacted on read). The migration role bypasses
-- the append-only pie_app grant, so this one-time backfill is allowed here and nowhere else.
update execution.agent_events
  set visibility = 'internal'
  where visibility not in ('internal', 'project', 'customer');
update execution.agent_events
  set classification = 'restricted'
  where classification not in ('public', 'internal', 'project_confidential', 'restricted');

alter table execution.agent_events
  add constraint agent_events_visibility_check
    check (visibility in ('internal', 'project', 'customer'));
alter table execution.agent_events
  add constraint agent_events_classification_check
    check (classification in ('public', 'internal', 'project_confidential', 'restricted'));

-- (2) capture_mode on the session — the INGEST enforcement point (doc 14 alpha bullet
-- "metadata-only와 full capture 정책"). full = store the event payload; metadata_only = keep the
-- envelope metadata but drop the payload body before insert; paused = drop the event entirely
-- except a capture-gap tombstone. Default 'full' keeps every existing session's behavior.
alter table execution.agent_sessions
  add column capture_mode text not null default 'full';
alter table execution.agent_sessions
  add constraint agent_sessions_capture_mode_check
    check (capture_mode in ('full', 'metadata_only', 'paused'));

-- The project-level default a new session inherits (a policy default; the session-side column is
-- the authoritative enforcement value). Same vocabulary; default 'full' preserves behavior.
alter table delivery.projects
  add column default_capture_mode text not null default 'full';
alter table delivery.projects
  add constraint projects_default_capture_mode_check
    check (default_capture_mode in ('full', 'metadata_only', 'paused'));

-- (3) agent_capture_gaps: an append-only tombstone that a capture-paused event was intentionally
-- dropped at (stream_id, sequence). Recording it means a paused window is an EXPLICIT gap on the
-- timeline, never a silent loss that reads as a false-complete (doc 14 "기록 표시·pause"). It
-- carries the dropped event's own visibility so the same per-scope read filter hides an
-- internal-only gap from a customer-scoped reader. event_id is the client idempotency key: a
-- replayed paused event re-marks the same gap, never a second tombstone.
create table execution.agent_capture_gaps (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  agent_session_id uuid not null,
  stream_id uuid not null,
  sequence bigint not null,
  turn_id uuid,
  visibility text not null,
  reason text not null default 'capture_paused',
  occurred_at timestamptz not null,
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint capture_gaps_event_id_unique unique (organization_id, event_id),
  constraint capture_gaps_session_fk
    foreign key (organization_id, agent_session_id)
    references execution.agent_sessions (organization_id, id),
  constraint capture_gaps_sequence_check check (sequence >= 1),
  constraint capture_gaps_visibility_check check (visibility in ('internal', 'project', 'customer')),
  constraint capture_gaps_reason_check check (reason in ('capture_paused'))
);

create index agent_capture_gaps_session_idx
  on execution.agent_capture_gaps (organization_id, agent_session_id, stream_id, sequence);

alter table execution.agent_capture_gaps enable row level security;
alter table execution.agent_capture_gaps force row level security;
create policy agent_capture_gaps_tenant_isolation on execution.agent_capture_gaps
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_capture_gaps_tenant_boundary_guard on execution.agent_capture_gaps
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
-- Append-only: a tombstone is written once and never mutated (a resumed capture is a new event,
-- not an edit of the gap).
grant select, insert on execution.agent_capture_gaps to pie_app;
