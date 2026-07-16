-- Artifact + object storage metadata (doc 30 agent/artifact sections, ADR-0006).
-- Objects live in S3-compatible storage; PostgreSQL holds the authoritative
-- metadata, tenant-namespaced key, hash/size/type, and lifecycle status.

create schema if not exists agent;
grant usage on schema agent to pie_app;

-- Composite unique keys make every cross-table FK tenant-scoped (doc 30 :130):
-- a child can only reference a parent in the SAME organization.

-- agent.objects: one immutable stored blob. status follows the ADR-0006 lifecycle.
create table agent.objects (
  id uuid primary key,
  organization_id uuid not null references identity.organizations (id),
  storage_key text not null,
  sha256 text not null,
  size_bytes bigint not null,
  content_type text not null,
  classification text not null,
  status text not null default 'staging',
  created_at timestamptz not null default now(),
  constraint objects_storage_key_key unique (storage_key),
  constraint objects_org_id_key unique (organization_id, id),
  constraint objects_sha256_check check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint objects_status_check
    check (status in ('staging', 'available', 'quarantined', 'rejected', 'deleting', 'deleted'))
);
create index objects_organization_id_idx on agent.objects (organization_id);

-- agent.artifacts: the logical artifact; current_revision points at the latest
-- available immutable revision.
create table agent.artifacts (
  id uuid primary key,
  organization_id uuid not null references identity.organizations (id),
  project_id uuid not null,
  work_item_id uuid,
  name text not null,
  classification text not null,
  visibility text not null,
  status text not null default 'pending_upload',
  current_revision integer not null default 0,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifacts_org_id_key unique (organization_id, id),
  constraint artifacts_classification_check
    check (classification in ('public', 'internal', 'project_confidential', 'restricted')),
  constraint artifacts_visibility_check check (visibility in ('internal', 'project', 'customer')),
  constraint artifacts_status_check
    check (status in ('pending_upload', 'available', 'quarantined', 'rejected'))
);
create index artifacts_organization_id_idx on agent.artifacts (organization_id);

-- agent.artifact_revisions: immutable revision pointing at an available object.
-- Append-only (doc 30) — pie_app gets SELECT + INSERT only, never UPDATE/DELETE.
create table agent.artifact_revisions (
  id uuid primary key,
  organization_id uuid not null,
  artifact_id uuid not null,
  revision integer not null,
  object_id uuid not null,
  sha256 text not null,
  size_bytes bigint not null,
  status text not null default 'available',
  created_at timestamptz not null default now(),
  constraint artifact_revisions_unique unique (organization_id, artifact_id, revision),
  constraint artifact_revisions_artifact_fk
    foreign key (organization_id, artifact_id) references agent.artifacts (organization_id, id),
  constraint artifact_revisions_object_fk
    foreign key (organization_id, object_id) references agent.objects (organization_id, id),
  constraint artifact_revisions_status_check
    check (status in ('available', 'quarantined', 'rejected'))
);
create index artifact_revisions_artifact_idx
  on agent.artifact_revisions (organization_id, artifact_id);

-- operations.artifact_upload_sessions: short-lived intent linking an artifact to a
-- staging object + presign target until finalize.
create table operations.artifact_upload_sessions (
  id uuid primary key,
  organization_id uuid not null references identity.organizations (id),
  artifact_id uuid not null,
  object_id uuid not null,
  storage_key text not null,
  sha256 text not null,
  size_bytes bigint not null,
  content_type text not null,
  method text not null default 'single',
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint upload_sessions_org_id_key unique (organization_id, id),
  constraint upload_sessions_status_check check (status in ('pending', 'finalized', 'expired'))
);
create index upload_sessions_organization_id_idx
  on operations.artifact_upload_sessions (organization_id);

-- RLS: every table is org-scoped with the permissive isolation + restrictive
-- boundary guard + FORCE pattern used by all tenant tables.
do $$
declare
  target text;
begin
  foreach target in array array[
    'agent.objects',
    'agent.artifacts',
    'agent.artifact_revisions',
    'operations.artifact_upload_sessions'
  ]
  loop
    execute format('alter table %s enable row level security', target);
    execute format('alter table %s force row level security', target);
    execute format(
      'create policy tenant_isolation on %s as permissive for all to pie_app using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      target
    );
    execute format(
      'create policy tenant_boundary_guard on %s as restrictive for all to pie_app using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      target
    );
  end loop;
end
$$;

grant select, insert, update on agent.objects to pie_app;
grant select, insert, update on agent.artifacts to pie_app;
-- Append-only: revisions never change once written.
grant select, insert on agent.artifact_revisions to pie_app;
grant select, insert, update on operations.artifact_upload_sessions to pie_app;
