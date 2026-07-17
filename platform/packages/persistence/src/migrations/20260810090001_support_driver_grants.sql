-- R8 slice A3: single-driver arbitration + takeover audit (doc 34 §슬라이스 A3,
-- §보안 제약 #2 승인자≠조작자 = approver≠operator + all takeover audited, doc 07
-- "한 명만 조작 가능한 자원은 현재 드라이버를 명시한다" / "조작권 전달·회수"). Exactly ONE
-- participant may hold the driver role for a session's controllable resource at a
-- time. The CURRENT driver stays denormalized on remote_session_participants.is_driver;
-- this table is the driver-change HISTORY/audit — every grant is a row, a handoff
-- revokes the prior grant, and a revoke stamps revoked_at. Same tenant model as A1/A2:
-- composite (organization_id, id) keys, composite same-tenant FKs, and the permissive
-- tenant_isolation + restrictive tenant_boundary_guard + FORCE RLS pair keyed on
-- pie.organization_id.
create table support.remote_session_driver_grants (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  -- Composite same-tenant FK: a grant can never reference another org's session, and it
  -- cascades away when the session is deleted (doc 34 §보안 제약: 세션 종료 후 조작권 폐기).
  session_id uuid not null,
  -- The operator this grant hands the driver role to; cascades with the roster row.
  operator_participant_id uuid not null,
  -- Who granted the driver role (host/admin). doc 34 §보안 제약 #2: this MUST differ from
  -- the operator's user (approver≠operator) — enforced in the store, not by a CHECK
  -- (a CHECK cannot cross to the participant's user_id).
  approver_user_id uuid not null references identity.user_accounts (id),
  -- App-level ref to the A2 capability that authorized this control (doc 34 §보안 제약 #4
  -- control=step-up). Nullable; NO cross-schema FK — capabilities are a sibling concern.
  capability_id uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  primary key (organization_id, id),
  constraint remote_session_driver_grants_session_fk
    foreign key (organization_id, session_id)
    references support.remote_sessions (organization_id, id) on delete cascade,
  constraint remote_session_driver_grants_operator_fk
    foreign key (organization_id, operator_participant_id)
    references support.remote_session_participants (organization_id, id) on delete cascade
);

-- At most ONE active (non-revoked) driver grant per session — the single-operator
-- invariant at the history level. A handoff must revoke the prior grant in the same tx
-- before inserting the next, or this index rejects the second active row.
create unique index remote_session_driver_grants_single_active_idx
  on support.remote_session_driver_grants (organization_id, session_id)
  where revoked_at is null;

-- getActiveDriver and audit/UI listings scan by (org, session), newest first.
create index remote_session_driver_grants_session_idx
  on support.remote_session_driver_grants (organization_id, session_id, granted_at desc, id);

alter table support.remote_session_driver_grants enable row level security;
alter table support.remote_session_driver_grants force row level security;
create policy remote_session_driver_grants_tenant_isolation on support.remote_session_driver_grants
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy remote_session_driver_grants_tenant_boundary_guard on support.remote_session_driver_grants
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on support.remote_session_driver_grants to pie_app;

-- Belt-and-braces for the denormalized flag: the roster can never show two drivers for
-- one session even if a store bug set is_driver twice (mirrors the grant single-active
-- index, one level down).
create unique index remote_session_participants_single_driver_idx
  on support.remote_session_participants (organization_id, session_id)
  where is_driver;
