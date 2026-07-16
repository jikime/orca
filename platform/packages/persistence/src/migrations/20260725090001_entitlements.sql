-- R3 slice 5: entitlement model (doc 11:47-60, contracts/manifests/entitlements.json).
-- RBAC decides what a USER may do; entitlement decides what the ORGANIZATION has
-- purchased/activated. The two are separate axes with DISTINCT denial reasons
-- (doc 11:52 order: organization entitlement → user permission → resource grant).

-- Plan catalog, SEEDED from the manifest with a checksum (entitlement-manifest-
-- seed.ts), like the role catalog. Global reference data. limit_value NULL means
-- unlimited (the enterprise plan); boolean_value carries the boolean entitlements.
create table identity.entitlement_plans (
  id text primary key
);

create table identity.plan_entitlements (
  plan_id text not null references identity.entitlement_plans (id) on delete cascade,
  entitlement_id text not null,
  enforcement text not null,
  limit_value bigint,
  boolean_value boolean,
  primary key (plan_id, entitlement_id)
);

create table identity.entitlement_manifest_seed (
  id boolean primary key default true,
  checksum text not null,
  seeded_at timestamptz not null default now(),
  constraint entitlement_manifest_seed_singleton check (id = true)
);

-- One subscription per org selecting a plan. Absent = unmetered (billing assigns
-- a plan; new-org subscription creation is a billing concern, R4+).
create table identity.subscriptions (
  organization_id uuid primary key references identity.organizations (id),
  plan_id text not null references identity.entitlement_plans (id),
  deployment_type text not null default 'saas',
  status text not null default 'active',
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Usage meters for the limit-enforced entitlements that are not a live count
-- (storage bytes, monthly sessions, ...). core.members is enforced from a LIVE
-- count of active memberships instead, which is always accurate.
create table identity.usage_meters (
  organization_id uuid not null references identity.organizations (id),
  entitlement_id text not null,
  current_value bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (organization_id, entitlement_id)
);

-- === RLS ===
-- Plan catalog: global read-only for pie_app (resolve org grants). Writes are the
-- privileged seed loader only.
alter table identity.entitlement_plans enable row level security;
alter table identity.entitlement_plans force row level security;
create policy entitlement_plans_read on identity.entitlement_plans
  as permissive for select to pie_app using (true);

alter table identity.plan_entitlements enable row level security;
alter table identity.plan_entitlements force row level security;
create policy plan_entitlements_read on identity.plan_entitlements
  as permissive for select to pie_app using (true);

-- subscriptions + usage_meters: org-scoped tenant isolation like every org table.
alter table identity.subscriptions enable row level security;
alter table identity.subscriptions force row level security;
create policy subscriptions_tenant_isolation on identity.subscriptions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy subscriptions_tenant_boundary_guard on identity.subscriptions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

alter table identity.usage_meters enable row level security;
alter table identity.usage_meters force row level security;
create policy usage_meters_tenant_isolation on identity.usage_meters
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy usage_meters_tenant_boundary_guard on identity.usage_meters
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select on identity.entitlement_plans to pie_app;
grant select on identity.plan_entitlements to pie_app;
grant select, insert, update on identity.subscriptions to pie_app;
grant select, insert, update on identity.usage_meters to pie_app;
