-- R8 slice A2: scoped short-lived capability tokens (doc 34 §데이터모델 CapabilityToken,
-- §보안 제약 #3 scoped/audience/expiry/nonce · #4 control = step-up MFA · #7 consent-revoke /
-- policy-expiry must invalidate). A capability token is NOT a whole-session token — it is a
-- single-use, audience-bound, short-lived grant to perform ONE action in ONE session, bound to
-- ONE participant. The control plane owns issuance + redemption authority; the Relay/host redeem
-- (later phases). Same tenant model as A1: composite (organization_id, id) keys, composite
-- same-tenant FKs, and the permissive tenant_isolation + restrictive tenant_boundary_guard +
-- FORCE RLS pair keyed on pie.organization_id.
create table support.remote_session_capabilities (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  -- Composite same-tenant FK: a capability can never reference another org's session, and it
  -- cascades away when the session is deleted (doc 34 §보안 제약 #3: 세션 종료 후 제어 토큰 폐기).
  session_id uuid not null,
  -- The token is bound to a specific participant (the actor who will wield it); cascades with the
  -- roster row so a removed participant's outstanding capabilities vanish.
  participant_id uuid not null,
  capability text not null,
  -- The opaque target this token is valid for (a specific host/stream id, e.g.). Redemption must
  -- present a matching audience — this is the doc 07 대상 제한 (audience binding).
  audience text not null,
  -- Single-use secret the redeemer presents. Unique per session so a nonce identifies exactly one
  -- capability within a session.
  nonce text not null,
  -- Short-lived: the store clamps ttl to a small maximum on issue.
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  -- doc 34 §보안 제약 #4: a control capability requires step-up MFA. Enforced at issue time.
  requires_step_up boolean not null default false,
  issued_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint remote_session_capabilities_capability_check
    check (capability in ('view', 'terminal_control', 'desktop_control', 'file_transfer')),
  constraint remote_session_capabilities_session_fk
    foreign key (organization_id, session_id)
    references support.remote_sessions (organization_id, id) on delete cascade,
  constraint remote_session_capabilities_participant_fk
    foreign key (organization_id, participant_id)
    references support.remote_session_participants (organization_id, id) on delete cascade,
  -- A nonce is single-use per session: at most one capability row per (org, session, nonce).
  constraint remote_session_capabilities_nonce_unique
    unique (organization_id, session_id, nonce)
);

-- Redemption and audit/UI listing both scan by (org, session) and care about expiry ordering.
create index remote_session_capabilities_session_idx
  on support.remote_session_capabilities (organization_id, session_id, expires_at);

alter table support.remote_session_capabilities enable row level security;
alter table support.remote_session_capabilities force row level security;
create policy remote_session_capabilities_tenant_isolation on support.remote_session_capabilities
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy remote_session_capabilities_tenant_boundary_guard on support.remote_session_capabilities
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on support.remote_session_capabilities to pie_app;
