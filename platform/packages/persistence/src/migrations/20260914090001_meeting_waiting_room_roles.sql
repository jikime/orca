-- M4 keeps admission and media privileges as server-owned participant state.
alter table meetings.participants
  drop constraint participants_role_check;

alter table meetings.participants
  add constraint participants_role_check
  check (role in ('host', 'co_host', 'presenter', 'participant'));

alter table meetings.participants
  drop constraint meeting_participants_access_status_check;

alter table meetings.participants
  add constraint meeting_participants_access_status_check
  check (access_status in ('invited', 'waiting', 'admitted', 'denied', 'blocked'));
