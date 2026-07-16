-- Chat slice 4: direct messages. Design-reference-only. Core decision: a DM is an
-- ORDINARY channel with kind='dm' — NOT a separate entity. DM privacy comes from the
-- channel_members roster (no dedicated dm.view permission). Everything from slices
-- 1-3 (messages, threads, reactions, mentions, read cursors, notifications) works in
-- a DM unchanged because a DM is a channel.

-- kind distinguishes a normal channel from a DM. Existing rows default to 'channel'.
alter table collaboration.channels
  add column kind text not null default 'channel';
alter table collaboration.channels
  add constraint channels_kind_check check (kind in ('channel', 'dm'));

-- dm_key makes "start or find a DM" deterministic and idempotent WITHOUT a lookup
-- race: it is the sorted participant user-ids joined, so createDm(A,B) and
-- createDm(B,A) resolve to the same key. Unique only among DMs (partial index) so
-- normal channels (dm_key NULL) are unconstrained.
alter table collaboration.channels
  add column dm_key text;

create unique index channels_dm_key_unique
  on collaboration.channels (organization_id, dm_key)
  where kind = 'dm';
