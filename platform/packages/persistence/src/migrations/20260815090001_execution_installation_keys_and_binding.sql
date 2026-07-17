-- R5 slice 2b: SIGNED ExecutionContext trust bootstrap (doc 14 §R5, doc 24 anti-forgery).
-- Two additive parts on the execution authority: (a) the per-installation Ed25519 PUBLIC key
-- registry the Control Plane verifies signatures against, and (b) the SIGNED SessionBinding
-- recorded on the agent session (host discrimination — native/wsl/ssh — lives HERE). This is
-- additive to R5 s1 identity-based ingest: execution.agent_events.trust_domain and its check are
-- LEFT UNTOUCHED so per-event trust stays back-compatible.
--
-- Same tenant model as the rest of execution: composite (organization_id, id) key + the
-- permissive tenant_isolation + restrictive tenant_boundary_guard + FORCE RLS pair keyed on
-- pie.organization_id, so one org can never read or verify against another org's key.

-- (a) installation_public_keys: the registered SPKI PEM per (org, user, installation). The
-- producer registers its public key (trust bootstrap); the private key never leaves the host.
-- Upsert on (org, user, installation) rotates the key in place (rotation_count bumps) so a
-- rotated key is detectable via its distinct public_key_id fingerprint.
create table execution.installation_public_keys (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references identity.user_accounts (id),
  installation_id uuid not null,
  public_key text not null,
  public_key_id text not null,
  algorithm text not null default 'ed25519',
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotation_count integer not null default 0,
  primary key (organization_id, id),
  constraint installation_public_keys_algorithm_check check (algorithm = 'ed25519'),
  -- One key row per producer installation: a re-register rotates this row, never a second.
  constraint installation_public_keys_identity_unique
    unique (organization_id, user_id, installation_id)
);

-- Verification lookup is keyed on (org, user, installation) via the unique above; this second
-- index serves lookups that scope by installation alone within the org.
create index installation_public_keys_installation_idx
  on execution.installation_public_keys (organization_id, installation_id);

alter table execution.installation_public_keys enable row level security;
alter table execution.installation_public_keys force row level security;
create policy installation_public_keys_tenant_isolation on execution.installation_public_keys
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy installation_public_keys_tenant_boundary_guard on execution.installation_public_keys
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update on execution.installation_public_keys to pie_app;

-- (b) The SIGNED SessionBinding on the session. binding_trust_domain defaults to
-- 'local_observed' (the R5 s1 identity-only state); a verified signed context promotes it to
-- 'installation_signed' and stamps the host identity (native/wsl/ssh) + workspace + expiry. Two
-- DIFFERENT sessions at the same workspacePath keep their own bindings; re-binding ONE session to
-- a different host identity is the conflict the store rejects (BINDING_HOST_MISMATCH).
alter table execution.agent_sessions
  add column binding_trust_domain text not null default 'local_observed',
  add column binding_installation_id uuid,
  add column binding_host_type text,
  add column binding_host_id uuid,
  add column binding_workspace_path text,
  add column binding_not_after timestamptz;

alter table execution.agent_sessions
  add constraint agent_sessions_binding_trust_domain_check
    check (binding_trust_domain in ('local_observed', 'installation_signed')),
  add constraint agent_sessions_binding_host_type_check
    check (binding_host_type is null or binding_host_type in ('native', 'wsl', 'ssh'));
