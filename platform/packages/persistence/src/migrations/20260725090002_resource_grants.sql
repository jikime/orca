-- R3 slice 5: ResourceGrant (doc 01:165-181). The step-5 the RBAC evaluator
-- deferred: a role grants a permission org-wide, but a grant NARROWS the actual
-- scope (removes the permission on a specific resource) or exceptionally WIDENS it
-- (adds a permission on a specific resource the role would not otherwise allow).
-- Default-deny still holds; explicit deny still beats widen.
create table identity.resource_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references identity.organizations (id),
  -- The user the grant applies to (member of the org).
  user_id uuid not null references identity.user_accounts (id),
  resource_type text not null,
  resource_id uuid not null,
  grant_kind text not null,
  permission text not null,
  created_at timestamptz not null default now(),
  constraint resource_grants_kind_check check (grant_kind in ('narrow', 'widen')),
  constraint resource_grants_type_check
    check (resource_type in (
      'customer', 'project', 'work_item', 'agent_session', 'artifact',
      'repository', 'asset', 'ticket', 'remote_session'
    ))
);

create index resource_grants_lookup_idx
  on identity.resource_grants (organization_id, user_id, resource_type, resource_id);

alter table identity.resource_grants enable row level security;
alter table identity.resource_grants force row level security;

create policy resource_grants_tenant_isolation on identity.resource_grants
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy resource_grants_tenant_boundary_guard on identity.resource_grants
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update, delete on identity.resource_grants to pie_app;
