-- R3 slice 4: organization invitations (doc 01:81-94). The raw invite token is
-- delivered to the invitee ONCE (email/deep link); the server stores ONLY its
-- hash (doc 01:88) so a DB read never yields a usable token. Single-use, bound to
-- org + target email, role/scope fixed by the invite (not the acceptor).
create table identity.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references identity.organizations (id),
  -- The target identity: only this email may accept (verified via the token
  -- subject's email claim). Case-insensitive match is enforced in app code.
  email text not null,
  user_type text not null,
  -- Role template fixed by the invite; role ids validated vs the manifest in app
  -- code (custom roles may be cloned later — no schema enum).
  role_ids text[] not null default '{}',
  -- Resource scope is the LATER authorization slice; nullable placeholders now.
  customer_scope uuid,
  project_scope uuid,
  token_hash text not null,
  status text not null default 'pending',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references identity.user_accounts (id),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invitations_status_check
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  constraint invitations_token_hash_key unique (token_hash)
);

create index invitations_organization_id_idx on identity.invitations (organization_id);
create index invitations_email_idx on identity.invitations (organization_id, lower(email));

alter table identity.invitations enable row level security;
alter table identity.invitations force row level security;

-- Org-scoped like memberships: an admin reads/creates/revokes invites under their
-- org context. Acceptance runs on the PRIVILEGED path (withoutTenantContext),
-- authorized by possession of the token hash, because the acceptor is not yet a
-- member of the org.
create policy invitations_tenant_isolation on identity.invitations
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

create policy invitations_tenant_boundary_guard on identity.invitations
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update on identity.invitations to pie_app;
