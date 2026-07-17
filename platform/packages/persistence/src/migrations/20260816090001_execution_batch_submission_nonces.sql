-- R5 slice 5: BATCH-level anti-replay for signed-context ingest (doc 24 anti-forgery, EVT-004).
-- The signed ExecutionContext is a per-launch credential reused across MANY batches within its
-- validity TTL, so a nonce on the CONTEXT itself would break legitimate multi-batch reuse. The
-- replay hole is at the BATCH-submission level: a captured authenticated batch envelope can be
-- re-submitted within the TTL. This records a one-time-use per-batch nonce so a consumed
-- (org, installation, nonce) re-presented under a DIFFERENT batchId is rejected (SUBMISSION_REPLAYED),
-- while the SAME batchId stays an idempotent retry (event idempotency already dedups its events).
-- Additive: nonce enforcement runs only for signed-context batches; identity-only ingest is unchanged.
--
-- Same tenant model as the rest of execution: composite key rooted at organization_id + the
-- permissive tenant_isolation + restrictive tenant_boundary_guard + FORCE RLS pair keyed on
-- pie.organization_id, so one org can never observe or collide with another org's nonces.
create table execution.batch_submission_nonces (
  organization_id uuid not null references identity.organizations (id),
  installation_id uuid not null,
  submission_nonce uuid not null,
  -- The batchId the nonce was first consumed under: the SAME batchId is a legit retry, a DIFFERENT
  -- one is a replay of a consumed nonce.
  batch_id uuid not null,
  consumed_at timestamptz not null default now(),
  -- TTL for pruning: the signed context's notAfter. Once past, the nonce can never gate a valid
  -- context again, so it is safe to delete (bounded prune on write — no cron).
  not_after timestamptz not null,
  -- One-time-use: the unique key that makes a second consumption detectable.
  primary key (organization_id, installation_id, submission_nonce)
);

-- Prune scans by (org, expiry); this index keeps the bounded delete on write cheap.
create index batch_submission_nonces_expiry_idx
  on execution.batch_submission_nonces (organization_id, not_after);

alter table execution.batch_submission_nonces enable row level security;
alter table execution.batch_submission_nonces force row level security;
create policy batch_submission_nonces_tenant_isolation on execution.batch_submission_nonces
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy batch_submission_nonces_tenant_boundary_guard on execution.batch_submission_nonces
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
-- INSERT records a consumption, SELECT reads the prior batchId on conflict, DELETE prunes expired.
grant select, insert, delete on execution.batch_submission_nonces to pie_app;
