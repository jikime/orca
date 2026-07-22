-- Meeting capture governance: per-purpose consent, retention/legal hold, and durable deletion work.
create table meetings.governance (
  organization_id uuid not null references identity.organizations (id),
  meeting_id uuid not null,
  policy_version bigint not null default 1,
  purpose text not null default 'Record and process this meeting for recap and follow-up work.',
  retention_days integer default 90,
  retention_until timestamptz,
  legal_hold boolean not null default false,
  capture_status text not null default 'idle',
  active_capture_types text[] not null default array[]::text[],
  deletion_status text not null default 'active',
  deletion_requested_at timestamptz,
  deletion_requested_by uuid,
  deletion_reason text,
  deletion_completed_at timestamptz,
  deletion_attempts integer not null default 0,
  deletion_available_at timestamptz,
  deletion_leased_until timestamptz,
  deletion_worker_id text,
  deletion_last_error text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, meeting_id),
  constraint meeting_governance_meeting_fk
    foreign key (organization_id, meeting_id)
    references meetings.meetings (organization_id, id) on delete cascade,
  constraint meeting_governance_policy_version_check check (policy_version >= 1),
  constraint meeting_governance_purpose_check check (length(btrim(purpose)) between 1 and 2000),
  constraint meeting_governance_retention_check
    check (retention_days is null or retention_days between 1 and 3650),
  constraint meeting_governance_capture_status_check
    check (capture_status in ('idle', 'active', 'paused', 'stopped')),
  constraint meeting_governance_capture_types_check check (
    active_capture_types <@ array[
      'recording', 'transcription', 'ai_notes', 'presentation_screenshot'
    ]::text[]
  ),
  constraint meeting_governance_deletion_status_check
    check (deletion_status in ('active', 'queued', 'processing', 'completed', 'failed')),
  constraint meeting_governance_deletion_attempts_check check (deletion_attempts >= 0)
);

create index meeting_governance_deletion_claim_idx
  on meetings.governance (
    deletion_status,
    deletion_available_at,
    deletion_leased_until,
    retention_until,
    meeting_id
  );

create table meetings.capture_consents (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  participant_id uuid not null,
  capture_type text not null,
  policy_version bigint not null,
  purpose text not null,
  status text not null default 'pending',
  granted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint meeting_capture_consents_participant_fk
    foreign key (organization_id, participant_id)
    references meetings.participants (organization_id, id) on delete cascade,
  constraint meeting_capture_consents_meeting_fk
    foreign key (organization_id, meeting_id)
    references meetings.meetings (organization_id, id) on delete cascade,
  constraint meeting_capture_consents_unique
    unique (organization_id, meeting_id, participant_id, capture_type),
  constraint meeting_capture_consents_type_check check (
    capture_type in ('recording', 'transcription', 'ai_notes', 'presentation_screenshot')
  ),
  constraint meeting_capture_consents_status_check
    check (status in ('pending', 'granted', 'denied', 'revoked')),
  constraint meeting_capture_consents_policy_version_check check (policy_version >= 1),
  constraint meeting_capture_consents_purpose_check check (length(btrim(purpose)) between 1 and 2000)
);

create index meeting_capture_consents_meeting_idx
  on meetings.capture_consents (organization_id, meeting_id, participant_id, capture_type);

-- Existing recording consent covered recording, transcription, and AI notes as one legacy choice.
insert into meetings.governance (organization_id, meeting_id)
select organization_id, id from meetings.meetings
on conflict (organization_id, meeting_id) do nothing;

insert into meetings.capture_consents (
  organization_id,
  meeting_id,
  participant_id,
  capture_type,
  policy_version,
  purpose,
  status,
  granted_at
)
select
  participant.organization_id,
  participant.meeting_id,
  participant.id,
  capture.capture_type,
  governance.policy_version,
  governance.purpose,
  case
    when participant.consent_recording and capture.capture_type <> 'presentation_screenshot'
      then 'granted'
    else 'pending'
  end,
  case
    when participant.consent_recording and capture.capture_type <> 'presentation_screenshot'
      then participant.updated_at
    else null
  end
from meetings.participants participant
join meetings.governance governance
  on governance.organization_id = participant.organization_id
  and governance.meeting_id = participant.meeting_id
cross join (
  values ('recording'), ('transcription'), ('ai_notes'), ('presentation_screenshot')
) as capture(capture_type)
on conflict (organization_id, meeting_id, participant_id, capture_type) do nothing;

alter table meetings.recordings
  add column capture_types text[] not null
    default array['recording', 'transcription', 'ai_notes']::text[];

alter table meetings.recordings
  add constraint meeting_recordings_capture_types_check check (
    capture_types <@ array[
      'recording', 'transcription', 'ai_notes', 'presentation_screenshot'
    ]::text[]
    and 'recording' = any(capture_types)
    and ('ai_notes' <> all(capture_types) or 'transcription' = any(capture_types))
  );

drop index if exists meetings.recordings_one_pending_per_meeting_idx;
create unique index recordings_one_active_per_meeting_idx
  on meetings.recordings (organization_id, meeting_id)
  where status = 'pending' and stopped_at is null;

alter table meetings.governance enable row level security;
alter table meetings.governance force row level security;
create policy meeting_governance_tenant_isolation on meetings.governance
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_governance_tenant_boundary_guard on meetings.governance
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_governance_worker_select on meetings.governance
  as permissive for select to pie_worker using (true);
create policy meeting_governance_worker_update on meetings.governance
  as permissive for update to pie_worker using (true) with check (true);

alter table meetings.capture_consents enable row level security;
alter table meetings.capture_consents force row level security;
create policy meeting_capture_consents_tenant_isolation on meetings.capture_consents
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_capture_consents_tenant_boundary_guard on meetings.capture_consents
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update, delete on meetings.governance to pie_app;
grant select, insert, update, delete on meetings.capture_consents to pie_app;
grant select, update on meetings.governance to pie_worker;
