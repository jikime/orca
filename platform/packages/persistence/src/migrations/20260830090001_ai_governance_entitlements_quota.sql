-- R7 slice: AI ENTITLEMENT ENFORCEMENT + QUOTA + EVALUATION + PROMPT-INJECTION GUARD LOG. Carries the
-- R7 scope line "AI 모델·도구 entitlement, quota, 평가, prompt injection 방어" (doc 14 §R7): what an org
-- may use (entitlements), how much it has used (quota_usage), how model output scored (evaluations), and
-- what a safety guard caught (guard_events).
--
-- The load-bearing gate is quota CONSUME: a consume is refused unless the org holds an `allowed`
-- entitlement for the resource (route → 403 AI_NOT_ENTITLED), and — when quota_limit is set — it
-- increments quota_usage only if used+amount stays within the limit, else it is refused with NO
-- increment (route → 429 AI_QUOTA_EXCEEDED). The increment+limit-check is atomic (store takes a
-- FOR UPDATE row lock) so concurrent consumes cannot overspend.
--
-- Dedicated `ai` schema so organization_id / subject_id / model resource keys are genuine OPAQUE
-- cross-schema links — no cross-schema FK, same-tenant integrity via the shared organization_id
-- (mirrors automation.* / change.* / governance.*). This does NOT touch identity.entitlement_plans
-- (plan-level catalog); this is the per-org AI RESOURCE entitlement + runtime enforcement.
create schema if not exists ai;
grant usage on schema ai to pie_app;
grant usage on schema ai to pie_worker;

-- ai.entitlements: what an org MAY use. resource_kind is model|tool, resource_key the opaque key
--   (e.g. 'claude-opus-4', 'web_search'). allowed gates access; quota_limit (null = unlimited) caps
--   consumption over quota_period. UNIQUE (org, resource_kind, resource_key). version is the OCC counter.
create table ai.entitlements (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  resource_kind text not null,
  resource_key text not null,
  allowed boolean not null default true,
  quota_limit numeric,
  quota_period text not null default 'month',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint entitlements_resource_kind_check check (resource_kind in ('model', 'tool')),
  constraint entitlements_quota_period_check check (quota_period in ('day', 'month', 'total')),
  constraint entitlements_quota_limit_nonneg check (quota_limit is null or quota_limit >= 0),
  constraint entitlements_resource_unique unique (organization_id, resource_kind, resource_key)
);

create index entitlements_org_idx on ai.entitlements (organization_id, id);

-- ai.quota_usage: consumption counters. period_key names the window ('2026-07' month / '2026-07-18'
--   day / 'all' total). used accumulates; consuming N atomically increments used and enforces the
--   entitlement's quota_limit. UNIQUE (org, resource_kind, resource_key, period_key). version is OCC.
create table ai.quota_usage (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  resource_kind text not null,
  resource_key text not null,
  period_key text not null,
  used numeric not null default 0,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint quota_usage_resource_kind_check check (resource_kind in ('model', 'tool')),
  constraint quota_usage_used_nonneg check (used >= 0),
  constraint quota_usage_period_unique
    unique (organization_id, resource_kind, resource_key, period_key)
);

create index quota_usage_org_idx on ai.quota_usage (organization_id, id);

-- ai.evaluations: APPEND-ONLY eval log. subject_id is the OPAQUE id of what was evaluated (a message /
--   knowledge_article / agent run — no FK, nullable). metric/verdict are checked vocabularies; score is
--   numeric; evaluated_by is a human user id or 'system'. There is no update/delete route (evidence).
create table ai.evaluations (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  subject_id uuid,
  model_key text not null,
  metric text not null,
  score numeric not null,
  verdict text not null,
  notes text,
  evaluated_by text,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint evaluations_verdict_check check (verdict in ('pass', 'warn', 'fail'))
);

create index evaluations_org_idx on ai.evaluations (organization_id, id);

-- ai.guard_events: APPEND-ONLY prompt-injection / safety guard log (evidence). subject_id is the OPAQUE
--   id of what was guarded (no FK, nullable). guard_kind/action are checked vocabularies; detail records
--   what was matched; detected_by names the detector. There is no update/delete route (append-only).
create table ai.guard_events (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  subject_id uuid,
  guard_kind text not null,
  action text not null,
  detail text not null,
  detected_by text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint guard_events_guard_kind_check
    check (guard_kind in ('prompt_injection', 'jailbreak', 'pii', 'secret', 'toxicity')),
  constraint guard_events_action_check check (action in ('blocked', 'flagged', 'allowed'))
);

create index guard_events_org_idx on ai.guard_events (organization_id, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
alter table ai.entitlements enable row level security;
alter table ai.entitlements force row level security;
create policy entitlements_tenant_isolation on ai.entitlements
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy entitlements_tenant_boundary_guard on ai.entitlements
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on ai.entitlements to pie_app;

alter table ai.quota_usage enable row level security;
alter table ai.quota_usage force row level security;
create policy quota_usage_tenant_isolation on ai.quota_usage
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy quota_usage_tenant_boundary_guard on ai.quota_usage
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on ai.quota_usage to pie_app;

alter table ai.evaluations enable row level security;
alter table ai.evaluations force row level security;
create policy evaluations_tenant_isolation on ai.evaluations
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy evaluations_tenant_boundary_guard on ai.evaluations
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on ai.evaluations to pie_app;

alter table ai.guard_events enable row level security;
alter table ai.guard_events force row level security;
create policy guard_events_tenant_isolation on ai.guard_events
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy guard_events_tenant_boundary_guard on ai.guard_events
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on ai.guard_events to pie_app;
