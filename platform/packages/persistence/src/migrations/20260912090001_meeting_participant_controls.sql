-- A removed participant must not obtain a fresh media token after LiveKit revokes the active one.
alter table meetings.participants
  add column access_status text not null default 'invited';

alter table meetings.participants
  add constraint meeting_participants_access_status_check
  check (access_status in ('invited', 'admitted', 'blocked'));

update meetings.participants
set access_status = 'admitted'
where role = 'host';
