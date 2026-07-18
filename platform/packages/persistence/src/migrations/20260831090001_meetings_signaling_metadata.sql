-- R7 slice: MEETING METADATA PLANE. Carries the R7 scope line "화상회의, 화면 공유, 자막, 녹화 동의 /
-- 녹화·전사·AI 회의록" (doc 14 §R7) and the exit conditions "대화와 회의 결과가 프로젝트·티켓 문맥에
-- 보존된다" (a meeting is scoped to a project/ticket and its result is retrievable there) and "AI 문서는
-- 출처와 검토 상태를 가지며 모델 출력이 승인을 대체하지 않는다" (AI meeting-minutes need human review before
-- they may be finalized).
--
-- media-plane-is-infra: the actual audio/video transport (LiveKit SFU / WebRTC, screen share, live
-- caption media) needs external infrastructure and is deliberately NOT modeled here. This migration is
-- the SIGNALING / METADATA / CONSENT / RECORDING-REF / TRANSCRIPT / MINUTES data plane only — object_ref
-- is an OPAQUE pointer to a storage object whose upload is an infra concern.
--
-- Dedicated `meetings` schema so scope_id / meeting_id / object_ref are genuine OPAQUE cross-schema ids
-- — no cross-schema FK, same-tenant integrity via the shared organization_id (mirrors knowledge.* /
-- automation.*).
create schema if not exists meetings;
grant usage on schema meetings to pie_app;
grant usage on schema meetings to pie_worker;

-- meetings.meetings: a meeting (the signaling/metadata record; media transport is infra).
--   scope_kind + scope_id are the OPAQUE project/ticket context the meeting result is preserved in
--     (scope_kind='none' means unscoped; a scope_id is required iff scope_kind is not 'none').
--   status walks scheduled → live → ended (or → cancelled); a status change is the OCC :transition.
--   version is the OCC counter.
create table meetings.meetings (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  title text not null,
  scope_kind text not null default 'none',
  scope_id uuid,
  host_user_id uuid not null,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text not null default 'scheduled',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint meetings_scope_kind_check check (scope_kind in ('project', 'ticket', 'none')),
  constraint meetings_status_check check (status in ('scheduled', 'live', 'ended', 'cancelled')),
  -- A scoped meeting must name its scope id; an unscoped one must not.
  constraint meetings_scope_id_presence
    check ((scope_kind = 'none' and scope_id is null) or (scope_kind <> 'none' and scope_id is not null))
);

-- Scope-filtered listing (the context-preservation read): a project/ticket's meetings, most-recent first.
create index meetings_scope_idx on meetings.meetings (organization_id, scope_kind, scope_id, id);

-- meetings.participants: a member's presence + recording consent in a meeting.
--   meeting_id is the OPAQUE id of the meeting (no FK).
--   consent_recording is the 녹화 동의 — recording is refused unless every currently-joined participant
--     (joined_at is set, left_at is null) has consented.
--   role host|participant; version is the OCC counter.
create table meetings.participants (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  user_id uuid not null,
  role text not null default 'participant',
  consent_recording boolean not null default false,
  joined_at timestamptz,
  left_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint participants_role_check check (role in ('host', 'participant')),
  unique (organization_id, meeting_id, user_id)
);

create index participants_meeting_idx on meetings.participants (organization_id, meeting_id, id);

-- meetings.recordings: a recording reference (the media upload is infra).
--   meeting_id is OPAQUE (no FK). object_ref is the OPAQUE storage object id, set at :finalize.
--   status walks pending → available (or → failed). duration_seconds is set at :finalize.
--   version is the OCC counter.
create table meetings.recordings (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  object_ref uuid,
  status text not null default 'pending',
  duration_seconds integer,
  started_at timestamptz not null default now(),
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint recordings_status_check check (status in ('pending', 'available', 'failed'))
);

create index recordings_meeting_idx on meetings.recordings (organization_id, meeting_id, id);

-- meetings.transcripts: a caption/transcript for a meeting.
--   meeting_id is OPAQUE (no FK). content (plain text) OR segments (jsonb timed segments) — at least one.
--   source records provenance (live_caption | post_recording | ai). version is the OCC counter.
create table meetings.transcripts (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  content text,
  segments jsonb,
  source text not null,
  language text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint transcripts_source_check check (source in ('live_caption', 'post_recording', 'ai')),
  constraint transcripts_body_presence check (content is not null or segments is not null)
);

create index transcripts_meeting_idx on meetings.transcripts (organization_id, meeting_id, id);

-- meetings.minutes: AI/human meeting minutes.
--   meeting_id is OPAQUE (no FK). summary is markdown.
--   source_type manual|ai records provenance; review_status + reviewed_by + reviewed_at is the human
--     review record. status walks draft → finalized. version is the OCC counter.
create table meetings.minutes (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  summary text not null,
  source_type text not null default 'manual',
  review_status text not null default 'unreviewed',
  reviewed_by uuid,
  reviewed_at timestamptz,
  status text not null default 'draft',
  author_user_id uuid not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint minutes_source_type_check check (source_type in ('manual', 'ai')),
  constraint minutes_review_status_check check (review_status in ('unreviewed', 'approved', 'rejected')),
  constraint minutes_status_check check (status in ('draft', 'finalized')),
  -- ai-minutes-need-review: model-authored minutes may not be finalized while unreviewed. Enforced in
  -- the store (→ 422 MINUTES_REVIEW_REQUIRED); this CHECK is the last-line safety net so the invariant
  -- cannot be violated even by a direct write. "모델 출력이 승인을 대체하지 않는다."
  constraint minutes_ai_review_before_finalize
    check (not (source_type = 'ai' and status = 'finalized' and review_status <> 'approved'))
);

create index minutes_meeting_idx on meetings.minutes (organization_id, meeting_id, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
alter table meetings.meetings enable row level security;
alter table meetings.meetings force row level security;
create policy meetings_tenant_isolation on meetings.meetings as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meetings_tenant_boundary_guard on meetings.meetings as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.meetings to pie_app;

alter table meetings.participants enable row level security;
alter table meetings.participants force row level security;
create policy participants_tenant_isolation on meetings.participants as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy participants_tenant_boundary_guard on meetings.participants
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.participants to pie_app;

alter table meetings.recordings enable row level security;
alter table meetings.recordings force row level security;
create policy recordings_tenant_isolation on meetings.recordings as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy recordings_tenant_boundary_guard on meetings.recordings as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.recordings to pie_app;

alter table meetings.transcripts enable row level security;
alter table meetings.transcripts force row level security;
create policy transcripts_tenant_isolation on meetings.transcripts as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy transcripts_tenant_boundary_guard on meetings.transcripts as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.transcripts to pie_app;

alter table meetings.minutes enable row level security;
alter table meetings.minutes force row level security;
create policy minutes_tenant_isolation on meetings.minutes as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy minutes_tenant_boundary_guard on meetings.minutes as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on meetings.minutes to pie_app;
