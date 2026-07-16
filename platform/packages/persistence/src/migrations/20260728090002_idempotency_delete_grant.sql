-- R4 slice 3b: delivery mutations reserve an Idempotency-Key BEFORE running, then
-- release it (delete the in-progress row) when the mutation fails a business rule
-- (entitlement 402, key-taken 409) so the key can be retried. That release is the
-- first DELETE against the ledger — the original grant was insert/update/select
-- only — so pie_app needs DELETE here. RLS still scopes it to the tenant.
grant delete on operations.idempotency_records to pie_app;
