-- R3 slice 4: Pie-side session records for revocation propagation (doc 01:150-163,
-- ADR-0009). Keycloak owns credentials + the actual refresh-token rotation; Pie
-- owns the session METADATA + the revoke DECISION. Each record is keyed on the
-- Keycloak session id (the access token's `sid` claim), so the token verifier can
-- reject a revoked session at the NEXT request even before the token expires
-- (AUT-005). A token family groups rotations; presenting a rotated-away marker
-- revokes the whole family (AUT-002).
create table identity.device_sessions (
  id uuid primary key default gen_random_uuid(),
  -- The Keycloak session id (`sid`); unique so the verifier looks it up directly.
  session_id text not null,
  family_id uuid not null default gen_random_uuid(),
  user_id uuid not null references identity.user_accounts (id),
  issuer text not null,
  subject text not null,
  status text not null default 'active',
  -- Pie-side rotation marker; a refresh presenting a stale value is a reuse attack.
  rotation_counter integer not null default 0,
  revoked_reason text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint device_sessions_status_check check (status in ('active', 'revoked')),
  constraint device_sessions_session_id_key unique (session_id)
);

create index device_sessions_subject_idx on identity.device_sessions (issuer, subject);
create index device_sessions_family_idx on identity.device_sessions (family_id);

-- Global (a session belongs to a user, not an org). Written/read only on the
-- privileged path (withoutTenantContext): login creates it, the verifier consults
-- it, revoke updates it. FORCE RLS + no pie_app grant = default-deny for the app
-- role; nothing reads raw session rows through a tenant request.
alter table identity.device_sessions enable row level security;
alter table identity.device_sessions force row level security;
