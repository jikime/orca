-- R5 slice 4a: PROVENANCE projection over the append-only agent-event log (doc 14 §R5,
-- doc 19 :265-271, doc 20 CAP-004/CAP-005). File change, Artifact, commit, PR/MR, and
-- test/build results arrive as ordinary execution.agent_events (source git|test|runtime,
-- assertion observed/declared) — this table is the QUERYABLE projection of that evidence,
-- with the structured columns a raw jsonb payload should not scatter. The agent_events row
-- stays the source of truth; a provenance row is derived from exactly one event.
--
-- Three trust domains that MUST stay separate (doc 19 :216-231, CAP-005):
--   local_observed  — Pie directly observed it (client Hook / Git / test run). First-hand,
--                     but a locally-observed event is NOT server-verified.
--   server_verified — a provider webhook / provider API / signed CI attested it. A distinct,
--                     stronger domain than local_observed.
--   declared        — an agent/user CLAIMED it ("task complete"). NEVER evidence of completion
--                     or approval; stored for the record but read as a claim, not a result.
--
-- Immutability (CAP-004, mirrors agent.artifact_revisions): provenance is evidence, so pie_app
-- gets INSERT + SELECT only — never UPDATE/DELETE. A correction is a NEW revision row that
-- points at the one it supersedes; the prior row is never mutated.
create table execution.agent_provenance (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  -- The agent_events.event_id this projection is derived from. UNIQUE per org makes a replayed
  -- event a no-op at the projection layer too (reuses s1 (org, event_id) idempotency).
  source_event_id uuid not null,
  agent_session_id uuid not null,
  agent_run_id uuid,
  kind text not null,
  trust_domain text not null,
  -- Provider-agnostic Git identity (repo Git-provider-compat rule): PR and MR are ONE
  -- pull_request kind with a `provider` field, never GitHub-only naming. provider is nullable
  -- because file_change/test/build results need not originate from a hosted provider.
  provider text,
  repository text,
  source_revision text,
  commit_sha text,
  -- pull_request (GitHub PR / GitLab MR / other): number+url+state, source→target branch.
  change_request_ref text,
  change_request_url text,
  change_request_state text,
  source_branch text,
  target_branch text,
  -- test_result / build_result (doc 19 :269): command, exec environment, source revision,
  -- exit code, and the parser version that produced the structured result.
  command text,
  exec_environment text,
  exit_code integer,
  result_parser_version text,
  -- file_change: an opaque relative path token (never an absolute host path) + change type.
  file_path text,
  change_type text,
  -- artifact (doc 19 :265): opaque link to agent.artifacts + the content hash. No cross-schema
  -- FK — the artifact lives in the `agent` schema and is referenced by opaque id only.
  artifact_id uuid,
  content_hash text,
  -- Opaque forward link to a WorkItem (assign/intake is R5 s4b). No cross-schema FK.
  work_item_id uuid,
  -- Immutable revision chain: a correction inserts a new row with revision = prior + 1 and
  -- corrects_provenance_id = prior.id; the prior row is left untouched.
  revision integer not null default 1,
  corrects_provenance_id uuid,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- One provenance row per source event (projection idempotency).
  constraint agent_provenance_source_event_unique unique (organization_id, source_event_id),
  -- The projection is bound to a real event in THIS org (a row can never cite another org's
  -- event); the source event in turn is bound to a session in this org.
  constraint agent_provenance_source_event_fk
    foreign key (organization_id, source_event_id)
    references execution.agent_events (organization_id, event_id),
  constraint agent_provenance_session_fk
    foreign key (organization_id, agent_session_id)
    references execution.agent_sessions (organization_id, id),
  constraint agent_provenance_kind_check
    check (kind in ('file_change', 'artifact', 'commit', 'pull_request', 'test_result', 'build_result')),
  -- The three trust domains are a closed set; `declared` is stored but never read as verified.
  constraint agent_provenance_trust_domain_check
    check (trust_domain in ('local_observed', 'server_verified', 'declared')),
  constraint agent_provenance_revision_check check (revision >= 1)
);

-- Read path: a session's provenance ordered newest-first, keyset-paged by (received_at, id).
create index agent_provenance_session_idx
  on execution.agent_provenance (organization_id, agent_session_id, received_at desc, id);
-- Correction lookups follow the supersede pointer.
create index agent_provenance_corrects_idx
  on execution.agent_provenance (organization_id, corrects_provenance_id)
  where corrects_provenance_id is not null;
-- WorkItem-scoped evidence (opaque link; assign flow is s4b).
create index agent_provenance_work_item_idx
  on execution.agent_provenance (organization_id, work_item_id)
  where work_item_id is not null;

alter table execution.agent_provenance enable row level security;
alter table execution.agent_provenance force row level security;
create policy agent_provenance_tenant_isolation on execution.agent_provenance
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_provenance_tenant_boundary_guard on execution.agent_provenance
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
-- Append-only (CAP-004): provenance is evidence, so INSERT + SELECT only — corrections are new
-- revision rows, never mutations of a prior row.
grant select, insert on execution.agent_provenance to pie_app;
