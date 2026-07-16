-- R3 slice 3 fix: a security-audit stream for authorization denials that is NOT
-- tenant-scoped and has NO foreign key to identity.organizations.
--
-- Why no FK: a denial can reference an org the caller has no relationship to —
-- including a NON-EXISTENT org id (the "다른 조직 ID를 직접 요청" attack, doc 14
-- exit criterion). Keying the denial audit on identity.organizations would FK-fail
-- (23503) for such a request, turning a clean 403 into a 500 AND dropping the very
-- security event an operator needs. This table records the requested org id as
-- plain data. Written only by the privileged authorization path.
create table audit.authorization_denials (
  id uuid primary key default gen_random_uuid(),
  -- As requested by the caller; may not exist. Deliberately NO FK.
  requested_organization_id uuid,
  -- The Pie user if the subject has provisioned; NO FK (denials for unprovisioned
  -- subjects are exactly what we must record).
  actor_user_id uuid,
  issuer text,
  subject text,
  permission text not null,
  reason text not null,
  request_id text,
  occurred_at timestamptz not null default now()
);

create index authorization_denials_requested_org_idx
  on audit.authorization_denials (requested_organization_id);
create index authorization_denials_occurred_idx
  on audit.authorization_denials (occurred_at);

-- FORCE RLS with NO pie_app policy/grant: application requests never read or write
-- this stream directly. The privileged authorization path (withoutTenantContext)
-- writes it; operators read it out of band. Default-deny for the app roles.
alter table audit.authorization_denials enable row level security;
alter table audit.authorization_denials force row level security;
