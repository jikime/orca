-- R6 slice 3: SERVICE TICKET + SLA bounded context (doc 14 §R6 "서비스 티켓, 담당자, SLA,
-- 공개 답변과 내부 메모" + "티켓에서 기존 R5 Workspace·AgentSession 흐름 재사용"). A NEW `service`
-- schema — kept SEPARATE from `support` (which is remote-session-specific) because a ticket is a
-- distinct aggregate that merely LINKS to a remote session, it is not one. Same tenant model as
-- crm/delivery/support: composite (organization_id, id) keys + composite same-tenant FKs (a reply
-- can never reference another org's ticket), and the permissive tenant_isolation + restrictive
-- tenant_boundary_guard + FORCE RLS pair keyed on pie.organization_id.
--
-- Cross-schema links (account_id, reporter_contact_id, project_id, contract_id, agent_session_id,
-- remote_session_id) are OPAQUE ids — deliberately NO cross-schema FK (mirrors crm.contract_projects
-- and support.remote_sessions.ticket_id). The R5 agent-session + R8 remote-session reuse is recorded
-- by storing their opaque ids on the ticket; those sessions are created by their own existing flows.
create schema if not exists service;
grant usage on schema service to pie_app;
grant usage on schema service to pie_worker;

-- service.sla_policies: per-org SLA policy. targets is a jsonb map priority → {response, resolution}
-- in MINUTES (a small JSON of per-priority targets, not one row per priority). A ticket may reference
-- a policy; when none is set the store falls back to DEFAULT_SLA_TARGETS. is_default marks the policy
-- a create should pick when the caller names no policy (at most one per org enforced by the store).
create table service.sla_policies (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  targets jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id)
);

-- service.tickets: the customer service ticket. account_id/reporter_contact_id are OPAQUE crm ids;
-- project_id/contract_id are OPAQUE delivery/crm ids; agent_session_id/remote_session_id are the
-- OPAQUE R5/R8 reuse links (nullable until the ticket opens a workspace/remote session). sla_policy_id
-- is a same-schema (nullable) reference. *_due_at are computed at create from the priority's SLA
-- target (calendar-time; business-hours is a documented future refinement — see service-sla.ts).
-- first_responded_at is stamped by the first public_reply; resolved_at by the resolve transition.
create table service.tickets (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  reporter_contact_id uuid,
  subject text not null,
  body text not null default '',
  status text not null default 'new',
  priority text not null default 'normal',
  assignee_user_id uuid,
  project_id uuid,
  contract_id uuid,
  -- The R5/R8 reuse links (opaque ids into execution.agent_sessions / support.remote_sessions).
  agent_session_id uuid,
  remote_session_id uuid,
  sla_policy_id uuid,
  first_response_due_at timestamptz,
  resolution_due_at timestamptz,
  first_responded_at timestamptz,
  resolved_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint tickets_status_check
    check (status in ('new', 'open', 'pending', 'on_hold', 'resolved', 'closed')),
  constraint tickets_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint tickets_sla_policy_fk
    foreign key (organization_id, sla_policy_id)
    references service.sla_policies (organization_id, id) on delete set null
);

create index tickets_account_idx on service.tickets (organization_id, account_id, created_at desc, id);
create index tickets_status_idx on service.tickets (organization_id, status, created_at desc, id);
create index tickets_assignee_idx on service.tickets (organization_id, assignee_user_id, created_at desc, id);
create index tickets_created_idx on service.tickets (organization_id, created_at desc, id);

-- service.ticket_replies: APPEND-ONLY (INSERT + SELECT only — no update/delete grant). kind splits a
-- customer-facing 공개 답변 (public_reply) from an internal 내부 메모 (internal_memo); visibility carries
-- the delivery/crm scope vocabulary so a customer-scoped read filters on it exactly like delivery
-- comments. The store keeps kind↔visibility consistent (public_reply→customer, internal_memo→internal).
create table service.ticket_replies (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  kind text not null,
  visibility text not null,
  author_user_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint ticket_replies_kind_check check (kind in ('public_reply', 'internal_memo')),
  constraint ticket_replies_visibility_check
    check (visibility in ('internal', 'project', 'customer')),
  constraint ticket_replies_ticket_fk
    foreign key (organization_id, ticket_id)
    references service.tickets (organization_id, id) on delete cascade
);

create index ticket_replies_ticket_idx
  on service.ticket_replies (organization_id, ticket_id, created_at asc, id);

-- === RLS: the standard tenant pair on every service table ===
do $$
declare
  t text;
  append_only boolean;
begin
  foreach t in array array['sla_policies', 'tickets', 'ticket_replies']
  loop
    execute format('alter table service.%I enable row level security', t);
    execute format('alter table service.%I force row level security', t);
    execute format(
      'create policy %I on service.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on service.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    -- ticket_replies is append-only: no UPDATE/DELETE grant so an internal memo can never be edited
    -- into a public reply (or vice versa) after the fact — the split is immutable evidence.
    append_only := t = 'ticket_replies';
    if append_only then
      execute format('grant select, insert on service.%I to pie_app', t);
    else
      execute format('grant select, insert, update, delete on service.%I to pie_app', t);
    end if;
  end loop;
end
$$;
