-- R8 slice A1: RemoteSession control-plane authority (doc 34 Phase A, doc 07
-- 원격지원 state machine + 권한 등급, doc 32 §Relay — the Control Plane owns
-- RemoteSession/participant/consent/audit; the Relay is only an opaque stream
-- ferry and is NOT built here). The `support` schema is doc 32's home for the
-- RemoteSession control surface. Design-reference-only build modeled on Pie's own
-- docs and the collaboration/delivery tenant template — NOT on GPL mosaic code.
--
-- Same tenant model as collaboration: composite (organization_id, id) keys +
-- composite same-tenant FKs so a participant/consent can never reference another
-- org's session, and the permissive tenant_isolation + restrictive
-- tenant_boundary_guard + FORCE RLS pair keyed on pie.organization_id.
create schema if not exists support;
grant usage on schema support to pie_app;
grant usage on schema support to pie_worker;

-- remote_sessions: one shared terminal/desktop/support session. status is the
-- doc 07 state machine (요청 → 고객동의대기 → 연결중 → 활성 ↔ 일시중지 → 종료 → 검토완료);
-- the legal-transition table is enforced in the store, not here (a CHECK cannot see
-- the prior value). ticket_id is a nullable forward pointer to a later delivery/
-- service linkage slice — intentionally NO cross-schema FK yet.
create table support.remote_sessions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  kind text not null,
  status text not null default 'requested',
  host_user_id uuid not null references identity.user_accounts (id),
  created_by uuid not null references identity.user_accounts (id),
  -- Forward pointer only; a later slice links sessions to delivery/service tickets.
  ticket_id uuid,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint remote_sessions_kind_check check (kind in ('terminal', 'desktop', 'support')),
  constraint remote_sessions_status_check
    check (status in (
      'requested', 'awaiting_consent', 'connecting', 'active', 'paused', 'ended', 'reviewed'
    ))
);

create index remote_sessions_org_idx
  on support.remote_sessions (organization_id, created_at desc, id);

alter table support.remote_sessions enable row level security;
alter table support.remote_sessions force row level security;
create policy remote_sessions_tenant_isolation on support.remote_sessions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy remote_sessions_tenant_boundary_guard on support.remote_sessions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on support.remote_sessions to pie_app;

-- remote_session_participants: the roster. grade is the doc 07 권한 등급, ascending
-- (관전<채팅<터미널조작<데스크톱조작<파일전송<관리자). is_driver marks the single
-- operator of an exclusive resource. A session_id composite FK cascades roster rows
-- with their session. The partial unique key forbids two ACTIVE roster rows for one
-- user in a session (a left participant may rejoin — left rows are excluded).
create table support.remote_session_participants (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null references identity.user_accounts (id),
  grade text not null,
  is_driver boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (organization_id, id),
  constraint remote_session_participants_grade_check
    check (grade in (
      'observer', 'chat', 'terminal_control', 'desktop_control', 'file_transfer', 'admin'
    )),
  constraint remote_session_participants_session_fk
    foreign key (organization_id, session_id)
    references support.remote_sessions (organization_id, id) on delete cascade
);

create unique index remote_session_participants_active_roster_idx
  on support.remote_session_participants (organization_id, session_id, user_id)
  where left_at is null;
create index remote_session_participants_session_idx
  on support.remote_session_participants (organization_id, session_id, joined_at);

alter table support.remote_session_participants enable row level security;
alter table support.remote_session_participants force row level security;
create policy remote_session_participants_tenant_isolation on support.remote_session_participants
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy remote_session_participants_tenant_boundary_guard on support.remote_session_participants
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on support.remote_session_participants to pie_app;

-- remote_session_consents: the customer's (subject's) recorded consent. Revocation
-- sets revoked_at and is NEVER hard-deleted (audit). Doc 07: a revoked consent
-- immediately blocks input and ends the connection — the store forces the session
-- to a safe (ended) state on revoke. session_id composite FK cascades with the session.
create table support.remote_session_consents (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  subject_user_id uuid not null references identity.user_accounts (id),
  scope text not null default 'session',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (organization_id, id),
  constraint remote_session_consents_session_fk
    foreign key (organization_id, session_id)
    references support.remote_sessions (organization_id, id) on delete cascade
);

create index remote_session_consents_session_idx
  on support.remote_session_consents (organization_id, session_id, granted_at desc, id);

alter table support.remote_session_consents enable row level security;
alter table support.remote_session_consents force row level security;
create policy remote_session_consents_tenant_isolation on support.remote_session_consents
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy remote_session_consents_tenant_boundary_guard on support.remote_session_consents
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on support.remote_session_consents to pie_app;

-- remote_session_audit: an FK-FREE best-effort audit stream (mirrors the chat
-- audit.authorization_denials / audit.audit_events pattern). NO FK to sessions so
-- an audit write can never fail the main mutation tx, and an audit row survives its
-- session's deletion. Still org-scoped + RLS so a tenant only reads its own trail.
create table support.remote_session_audit (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  event_type text not null,
  actor_user_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create index remote_session_audit_session_idx
  on support.remote_session_audit (organization_id, session_id, created_at desc, id);

alter table support.remote_session_audit enable row level security;
alter table support.remote_session_audit force row level security;
create policy remote_session_audit_tenant_isolation on support.remote_session_audit
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy remote_session_audit_tenant_boundary_guard on support.remote_session_audit
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on support.remote_session_audit to pie_app;
