-- R4 slice 3: delivery.comments + the My Work read index (doc 30:242-257, 352-354).
-- Comments are a work-item child in the same tenant model (composite same-tenant FK).
-- The My Work index backs the assignee-keyed read WITHOUT a giant OR query (doc 30:353).

create table delivery.comments (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  work_item_id uuid not null,
  author_id uuid not null,
  body text not null,
  -- who may see the comment; an external role sees only 'customer' (TEN-004).
  visibility text not null default 'project',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint comments_visibility_check
    check (visibility in ('internal', 'project', 'customer')),
  constraint comments_work_item_fk
    foreign key (organization_id, work_item_id) references delivery.work_items (organization_id, id)
    on delete cascade
);

create index comments_work_item_idx
  on delivery.comments (organization_id, work_item_id, created_at, id);

-- My Work: assignee-keyed, org-scoped, active items ordered by board sort. Targeted
-- index (doc 30:352) so My Work never falls back to a full-tenant scan or an OR.
create index work_items_assignee_idx
  on delivery.work_items (organization_id, assignee_id, state_id, sort_key, id)
  where archived_at is null and assignee_id is not null;

-- === RLS: the standard tenant pair on delivery.comments ===
alter table delivery.comments enable row level security;
alter table delivery.comments force row level security;
create policy comments_tenant_isolation on delivery.comments
  as permissive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy comments_tenant_boundary_guard on delivery.comments
  as restrictive
  for all
  to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on delivery.comments to pie_app;
