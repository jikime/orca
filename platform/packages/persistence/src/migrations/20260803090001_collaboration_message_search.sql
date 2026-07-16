-- Chat slice 7: message full-text search. Read-only, per-org, member-scoped search
-- over message bodies. Additive to the slice-1 collaboration.messages table — no new
-- table, so it inherits the existing tenant_isolation + tenant_boundary_guard RLS pair
-- (the column is covered by the table's policies; nothing here weakens them).

-- STORED generated tsvector kept in sync with body by Postgres on every write.
-- 'simple' is deliberate: the corpus is mixed Korean/English. English stemming configs
-- (e.g. 'english') mangle Korean and drop CJK tokens; 'simple' tokenizes without
-- stemming — the safe multilingual default for v1 (ts_rank/language configs are later).
alter table collaboration.messages
  add column search_tsv tsvector
  generated always as (to_tsvector('simple', body)) stored;

-- GIN index on the tsvector alone. A GIN index cannot usefully lead with a scalar
-- btree column (organization_id), so org filtering rides the RLS tenant predicate plus
-- the existing (organization_id, channel_id, created_at, id) btree; this index serves
-- only the @@ tsquery match.
create index messages_search_tsv_idx
  on collaboration.messages using gin (search_tsv);
