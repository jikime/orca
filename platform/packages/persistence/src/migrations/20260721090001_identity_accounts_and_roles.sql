-- R3 slice 1: identity foundation — Pie's side of the ADR-0009 boundary.
-- Keycloak owns credentials/verify/MFA; Pie owns issuer+subject mapping,
-- UserAccount, Membership, and the Role/Permission vocabulary. NO passwords or
-- credential material ever live here (clause 6). Frozen once merged.

-- identity.user_accounts: the issuer+subject -> Pie user id mapping (ADR-0009
-- clause 6). GLOBAL table (a user is not owned by one org). No password column
-- ever. email/display_name are convenience copies, NOT the authorization identity
-- (clause 7) — Membership is the authority.
create table identity.user_accounts (
  id uuid primary key default gen_random_uuid(),
  issuer text not null,
  subject text not null,
  email text not null,
  email_verified boolean not null default false,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_accounts_issuer_subject_key unique (issuer, subject)
);

-- identity.memberships: a user's standing in one organization (org-scoped), the
-- authority for Pie authorization. role_ids is a text[] of manifest role ids —
-- validated at the APP layer against contracts/manifests/roles.json (custom roles
-- may be cloned later, so NO schema-level enum / FK to the fixed set).
create table identity.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references identity.organizations (id),
  user_id uuid not null references identity.user_accounts (id),
  status text not null default 'invited',
  role_ids text[] not null default '{}',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_status_check check (status in ('invited', 'active', 'suspended', 'revoked')),
  constraint memberships_org_user_key unique (organization_id, user_id)
);

create index memberships_organization_id_idx on identity.memberships (organization_id);
create index memberships_user_id_idx on identity.memberships (user_id);

-- Role vocabulary, SEEDED from the manifests with a checksum (see role-manifest-
-- seed.ts). GLOBAL and instance-wide: the manifest is the source of truth, these
-- tables are the self-contained, drift-detectable materialization. No org scope.
create table identity.roles (
  id text primary key,
  scope text not null,
  external boolean not null default false
);

create table identity.permissions (
  id text primary key,
  resource text not null,
  action text not null,
  risk text not null
);

create table identity.role_permissions (
  role_id text not null references identity.roles (id) on delete cascade,
  permission_id text not null references identity.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

-- One-row checksum of the seeded manifest, so a fresh DB is self-contained and
-- drift from the manifest source of truth is detectable (see the seed loader).
create table identity.role_manifest_seed (
  id boolean primary key default true,
  checksum text not null,
  seeded_at timestamptz not null default now(),
  constraint role_manifest_seed_singleton check (id = true)
);

-- === RLS ===

alter table identity.user_accounts enable row level security;
alter table identity.user_accounts force row level security;

-- user_accounts is global, so tenant isolation is by SHARED MEMBERSHIP: pie_app
-- may read a user row only if that user is a member of the org in the current
-- tenant context. This blocks cross-tenant user enumeration — a tenant can never
-- read a user who is not a member of its own org. Provisioning and session lookup
-- run WITHOUT tenant context (withoutTenantContext): they are subject-scoped
-- bootstrap paths (org is not known until derived), never exposed to enumerate.
create policy user_accounts_shared_membership on identity.user_accounts
  as permissive
  for select
  to pie_app
  using (
    exists (
      select 1
      from identity.memberships m
      where m.user_id = user_accounts.id
        and m.organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid
    )
  );

alter table identity.memberships enable row level security;
alter table identity.memberships force row level security;

create policy memberships_tenant_isolation on identity.memberships
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy memberships_tenant_boundary_guard on identity.memberships
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

-- The role vocabulary is public read within the instance (not org-scoped): every
-- tenant resolves permissions from the same fixed set. FORCE RLS with a read-all
-- policy keeps writes out of pie_app's reach (only the privileged seed loader
-- writes) while allowing SELECT for permission resolution.
alter table identity.roles enable row level security;
alter table identity.roles force row level security;
create policy roles_read on identity.roles as permissive for select to pie_app using (true);

alter table identity.permissions enable row level security;
alter table identity.permissions force row level security;
create policy permissions_read on identity.permissions as permissive for select to pie_app using (true);

alter table identity.role_permissions enable row level security;
alter table identity.role_permissions force row level security;
create policy role_permissions_read on identity.role_permissions
  as permissive for select to pie_app using (true);

-- === Grants ===
-- pie_app: SELECT on the identity read surface (RLS narrows user_accounts to
-- co-members). Memberships are read+written under tenant context by the app.
-- Provisioning inserts user_accounts/memberships from the PRIVILEGED bootstrap
-- path (withoutTenantContext), so pie_app gets no INSERT on user_accounts.
grant select on identity.user_accounts to pie_app;
grant select, insert, update on identity.memberships to pie_app;
grant select on identity.roles to pie_app;
grant select on identity.permissions to pie_app;
grant select on identity.role_permissions to pie_app;
