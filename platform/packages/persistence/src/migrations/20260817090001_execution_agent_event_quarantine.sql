-- R5 OPS-001: server-side QUARANTINE (dead-letter) for poison agent events (doc 20 OPS-001).
-- A poison event (schema-invalid / provenance-invalid / oversized / mis-routed) is per-item
-- rejected by the ingest loop so its valid batch siblings still commit (progress-around-poison);
-- this table gives the rejected event a durable, operator-visible record so a poison is not just
-- a transient per-item status. It mirrors operations.dead_letter_events (the R2 outbox pattern):
-- a parked/recoverable row with a status trail, RLS pair + FORCE, and INSERT/SELECT/UPDATE grant.
--
-- METADATA ONLY: the poison body is NEVER stored verbatim (it may carry a secret or be huge). We
-- keep the event identity, the reason, a content HASH, and the byte SIZE — enough to triage and
-- correlate without re-leaking the payload. Unlike the execution/* logs this table is FK-FREE:
-- the poison event is never inserted into agent_events and its session may not exist, so a
-- composite same-tenant FK would fail — the best-effort quarantine write must never do that.
create table execution.agent_event_quarantine (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  -- The poison event's client identity (its retry-stable eventId). UNIQUE per org so a replayed
  -- batch re-rejecting the same poison is a no-op insert — a poison is never double-quarantined.
  event_id uuid not null,
  -- Opaque event-scope identity for triage (NO FK — the event was rejected, not stored, and its
  -- session may not exist in this org).
  agent_session_id uuid not null,
  stream_id uuid not null,
  sequence bigint not null,
  reason_code text not null,
  -- sha256 of the serialized payload body (or null when the event carried no body) and its byte
  -- size — the metadata-only fingerprint that stands in for the never-stored raw poison content.
  content_hash text,
  payload_size_bytes integer not null,
  status text not null default 'quarantined',
  resolved_by uuid references identity.user_accounts (id),
  resolved_at timestamptz,
  version bigint not null default 1,
  quarantined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  -- Idempotency: one quarantine row per rejected event per org.
  constraint agent_event_quarantine_event_unique unique (organization_id, event_id),
  constraint agent_event_quarantine_reason_check
    check (reason_code in (
      'schema_invalid', 'provenance_invalid', 'oversized',
      'producer_mismatch', 'session_not_found', 'session_closed', 'org_mismatch'
    )),
  constraint agent_event_quarantine_status_check
    check (status in ('quarantined', 'recovered', 'discarded')),
  constraint agent_event_quarantine_size_check check (payload_size_bytes >= 0),
  -- A resolved row (recovered/discarded) must record who/when; a quarantined row must not.
  constraint agent_event_quarantine_resolution_coherent
    check (
      (status = 'quarantined') = (resolved_by is null and resolved_at is null)
    )
);

-- Operator queue read, newest-first, keyset-paged by (quarantined_at, id); status-filtered.
create index agent_event_quarantine_recent_idx
  on execution.agent_event_quarantine (organization_id, quarantined_at desc, id);
create index agent_event_quarantine_status_idx
  on execution.agent_event_quarantine (organization_id, status, quarantined_at desc, id);

alter table execution.agent_event_quarantine enable row level security;
alter table execution.agent_event_quarantine force row level security;
create policy agent_event_quarantine_tenant_isolation on execution.agent_event_quarantine
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy agent_event_quarantine_tenant_boundary_guard on execution.agent_event_quarantine
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
-- pie_app INSERTs a quarantine row on rejection and UPDATEs its status on operator recovery; the
-- immutable trail of quarantined/recovered/discarded lives in audit.audit_events.
grant select, insert, update on execution.agent_event_quarantine to pie_app;
