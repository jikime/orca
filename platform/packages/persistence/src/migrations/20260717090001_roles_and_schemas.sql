-- Roles and bounded-context schemas for the Control Plane foundation.
-- Frozen once merged: edit by adding a new migration, never by changing this file.

-- Database roles are cluster-global; create idempotently. They are NOLOGIN
-- privilege roles — login + passwords are provisioned per deployment (and for
-- local dev by the compose superuser), never baked into a committed migration.
-- pie_app and pie_worker are NOBYPASSRLS so row-level security always applies.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pie_migration_owner') then
    create role pie_migration_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pie_app') then
    create role pie_app nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pie_worker') then
    create role pie_worker nologin noinherit nobypassrls;
  end if;
end
$$;

-- The migration/bootstrap role must be able to SET ROLE into the app roles so a
-- single connection can drop to least privilege for tenant work and worker claims.
grant pie_migration_owner to current_user;
grant pie_app to current_user;
grant pie_worker to current_user;

-- Fixed bounded-context schemas (only the ones this slice needs).
create schema if not exists identity;
create schema if not exists operations;
create schema if not exists audit;

-- Lock down public: application roles never create ad-hoc objects.
revoke create on schema public from public;

-- App roles may enter their schemas but own nothing in them; table grants are
-- issued per table in later migrations.
grant usage on schema identity to pie_app;
grant usage on schema operations to pie_app;
grant usage on schema audit to pie_app;
grant usage on schema operations to pie_worker;
