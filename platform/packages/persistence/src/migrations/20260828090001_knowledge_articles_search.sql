-- R7 slice: KNOWLEDGE BASE + PERMISSION-AWARE SEARCH. Carries the R7 scope line
-- "지식베이스와 권한 인식 검색 / 해결 티켓과 원격 세션의 지식화" (doc 14 §R7) and the exit conditions
-- "권한 회수가 ... 검색 색인에 반영된다" (search filters at query time, never a stale precomputed index)
-- and "AI 문서는 출처와 검토 상태를 가지며 모델 출력이 승인을 대체하지 않는다" (an AI-authored article
-- requires human review before it may be published).
--
-- Dedicated `knowledge` schema so source_id (the ticket / remote-session an article was distilled from)
-- and project_id (an optional scope) are genuine OPAQUE cross-schema ids — no cross-schema FK, same-tenant
-- integrity via the shared organization_id (mirrors governance.* / qa.*).
create schema if not exists knowledge;
grant usage on schema knowledge to pie_app;
grant usage on schema knowledge to pie_worker;

-- knowledge.articles: a knowledge-base document.
--   status walks draft → in_review → published | archived (a status change is the OCC :transition).
--   visibility internal|customer is the read-tier the search filter re-evaluates per query.
--   source_type records provenance (manual | ticket | remote_session | ai); source_id is the OPAQUE
--     id of the ticket/session it was distilled from (no FK).
--   review_status (unreviewed|approved|rejected) + reviewed_by + reviewed_at is the human review record.
--   version is the OCC counter.
--   tsv is a STORED generated tsvector kept in sync by Postgres on every write; 'simple' is deliberate —
--     the corpus is mixed Korean/English and English stemming mangles CJK (mirrors messages.search_tsv).
create table knowledge.articles (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  title text not null,
  body text not null,
  status text not null default 'draft',
  visibility text not null default 'internal',
  source_type text not null default 'manual',
  source_id uuid,
  review_status text not null default 'unreviewed',
  reviewed_by uuid,
  reviewed_at timestamptz,
  author_user_id uuid not null,
  project_id uuid,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', title || ' ' || body)) stored,
  primary key (organization_id, id),
  constraint articles_status_check
    check (status in ('draft', 'in_review', 'published', 'archived')),
  constraint articles_visibility_check check (visibility in ('internal', 'customer')),
  constraint articles_source_type_check
    check (source_type in ('manual', 'ticket', 'remote_session', 'ai')),
  constraint articles_review_status_check
    check (review_status in ('unreviewed', 'approved', 'rejected')),
  -- ai-requires-review-before-publish: a model-authored article may not be published while unreviewed.
  -- Enforced in the store (→ 422 AI_REVIEW_REQUIRED); this CHECK is the last-line safety net so the
  -- invariant cannot be violated even by a direct write. "모델 출력이 승인을 대체하지 않는다."
  constraint articles_ai_review_before_publish
    check (not (source_type = 'ai' and status = 'published' and review_status <> 'approved'))
);

-- Listing by optional project scope, most-recent first within a tenant.
create index articles_project_idx on knowledge.articles (organization_id, project_id, id);

-- GIN index serving the @@ tsquery match only (a GIN index cannot usefully lead with the scalar
-- organization_id — org filtering rides the RLS tenant predicate; mirrors messages_search_tsv_idx).
create index articles_tsv_idx on knowledge.articles using gin (tsv);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
alter table knowledge.articles enable row level security;
alter table knowledge.articles force row level security;
create policy articles_tenant_isolation on knowledge.articles as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy articles_tenant_boundary_guard on knowledge.articles as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on knowledge.articles to pie_app;
