# 데이터베이스 물리 설계

## 목적과 권위

Pie의 프로젝트 포털, CRM, 서비스 데스크, 협업과 AI 작업 기록을 저장하는 물리 구조를 정의한다.
도메인 의미는 [도메인 데이터 모델](./13-domain-data-model.md), API concurrency와 event 의미는
[API·이벤트·동기화 계약](./23-api-event-sync-contracts.md)을 따른다. 이 문서와 ADR이 충돌하면 승인된
ADR이 우선하며 실제 구현에서는 version이 고정된 migration과 schema contract가 최종 권위자다.

관련 결정은 다음 ADR에 기록한다.

- [`ADR-0003`](../docs/adr/0003-local-sqlite-outbox.md): 로컬 SQLite cache와 outbox
- [`ADR-0004`](../docs/adr/0004-tenant-enforcement.md): tenant key, 복합 FK와 RLS
- [`ADR-0005`](../docs/adr/0005-control-plane-persistence.md): PostgreSQL과 query·migration 계층
- [`ADR-0006`](../docs/adr/0006-object-storage-boundary.md): 원문·binary와 Object Storage 경계
- [`ADR-0011`](../docs/adr/0011-self-hosted-platform-dependencies.md): SeaweedFS 기본값과 S3 adapter 범위

## 저장소 구성

```text
Pie Electron
├── portal-cache.sqlite
│   ├── 제한된 서버 projection
│   ├── UI draft와 recent route
│   └── sync checkpoint
├── capture.sqlite                 host별 Pie Runtime 소유
│   ├── normalized capture event
│   ├── delivery lease와 ack
│   ├── provider cursor
│   └── object upload checkpoint
└── orchestration.sqlite           기존 Agent task 실행 상태

Control Plane
├── PostgreSQL 16+
│   ├── 권위 있는 업무·권한 metadata
│   ├── idempotency와 transactional outbox
│   └── audit·검색 projection metadata
├── S3-compatible Object Storage
│   └── transcript, tool output, artifact, attachment, recording
└── Derived Search Projection
    └── PostgreSQL 검색부터 시작하고 필요 시 전용 engine으로 재생성
```

Renderer, LLM child process와 Relay가 PostgreSQL 또는 Object Storage credential을 직접 갖지 않는다.
업무 데이터는 Control Plane API, 로컬 실행 데이터는 Main이 중개하는 Runtime contract를 통해서만
접근한다.

## PostgreSQL 지원 기준

- 최소 major는 PostgreSQL 16이며 지원되는 최신 minor release를 사용한다.
- PostgreSQL major 지원 종료 12개월 전까지 다음 지원 major로 복구 rehearsal과 upgrade를 완료한다.
- cloud와 on-prem 설치가 같은 migration과 contract test를 통과해야 한다.
- 초기에는 mandatory extension을 요구하지 않는다. `pg_trgm`, vector extension 등은 측정 결과와 ADR
  없이 core schema에 추가하지 않는다.
- 하나의 물리 database와 하나의 migration stream으로 시작한다. tenant별 database, 서비스별 database와
  cross-database transaction은 사용하지 않는다.
- Keycloak은 같은 PostgreSQL cluster를 사용할 수 있지만 별도 database, credential과 migration
  lifecycle을 가진다. Pie application은 Keycloak table을 직접 query하지 않는다.

PostgreSQL은 major version을 5년간 지원하고 current minor 사용을 권장한다. 지원 기준은
[PostgreSQL Versioning Policy](https://www.postgresql.org/support/versioning/)를 따른다.

## 논리 schema

tenant별 PostgreSQL schema를 만들지 않는다. bounded context를 표현하는 고정 schema를 사용한다.

| schema | 책임 | 대표 table |
|---|---|---|
| `identity` | 계정, 조직, membership, session과 RBAC | `user_accounts`, `organizations`, `memberships`, `roles`, `resource_grants` |
| `delivery` | Team, Project, WorkItem과 실행 계획 | `teams`, `projects`, `work_items`, `cycles`, `initiatives`, `intake_items` |
| `crm` | 고객, 영업, 견적과 계약 | `customer_accounts`, `contacts`, `opportunities`, `quotes`, `contracts` |
| `service` | 티켓, SLA, 자산과 원격지원 | `tickets`, `sla_policies`, `assets`, `remote_sessions` |
| `collaboration` | 채널, 메시지와 회의 metadata | `channels`, `messages`, `meetings`, `participants` |
| `agent` | AI session, run, turn metadata와 artifact | `agent_sessions`, `agent_runs`, `agent_turns`, `artifacts`, `objects` |
| `integration` | 외부 reference, webhook와 sync cursor | `connections`, `external_references`, `webhook_inbox`, `sync_cursors` |
| `operations` | idempotency, outbox와 background operation | `idempotency_records`, `outbox_events`, `operations`, `projection_checkpoints` |
| `audit` | 변경·열람·승인·관리 감사 | `audit_events`, `access_events`, `deletion_tombstones` |

`public` schema의 일반 객체 생성 권한은 회수한다. migration owner만 DDL을 실행하며 애플리케이션 role은
명시적으로 grant된 schema와 table에만 접근한다.

## 이름과 공통 column

- database identifier는 `snake_case`, table은 복수형, foreign key는 `<resource>_id`를 사용한다.
- API의 `camelCase`와 database의 `snake_case` 변환은 persistence adapter 경계에서 한 번만 수행한다.
- 모든 row는 primary key를 가진다. resource ID는 의미를 해석하지 않는 `uuid`다.
- global identity table을 제외한 tenant row는 `organization_id uuid not null`을 가진다.
- mutable aggregate는 `version bigint not null default 1`을 가진다.
- 시각은 `timestamptz`, 업무상 날짜는 `date`, 기간은 단위가 이름에 포함된 정수를 사용한다.
- 일반 resource는 `created_at`, `created_by`, `updated_at`, `updated_by`를 가진다.
- archive 가능한 resource는 `archived_at`, `archived_by`를 사용한다. purge와 archive를 같은 동작으로
  취급하지 않는다.
- 금액은 `amount_minor bigint`와 `currency_code char(3)`를 기본으로 한다. 비율·단가는 필요한 정밀도를
  명시한 `numeric(p,s)`를 사용한다.
- dynamic Workflow 상태는 table relation으로 표현한다. 자주 바뀌는 업무 상태를 PostgreSQL enum에
  고정하지 않는다.
- `jsonb`는 provider 원문 metadata, schema version이 있는 설정과 확장 payload에만 사용한다. 핵심 FK,
  permission, 상태와 검색 필드를 JSON에 숨기지 않는다.

## Tenant key와 관계 무결성

global table인 `identity.user_accounts`를 제외한 tenant table은 다음 모양을 기본으로 한다.

```sql
create table delivery.projects (
  id uuid primary key,
  organization_id uuid not null,
  name text not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id)
    references identity.organizations (id)
);

create table delivery.work_items (
  id uuid primary key,
  organization_id uuid not null,
  project_id uuid,
  title text not null,
  version bigint not null default 1,
  unique (organization_id, id),
  foreign key (organization_id, project_id)
    references delivery.projects (organization_id, id)
);
```

- tenant resource를 참조하는 FK는 `(organization_id, resource_id)`를 함께 참조한다.
- optional relation은 `resource_id`만 null일 수 있고 `organization_id`는 항상 유지한다. `resource_id`가
  있으면 복합 FK가 같은 tenant의 대상만 허용한다.
- 핵심 관계를 `resource_type + resource_id` polymorphic pair로 대체하지 않는다. 범용 activity 대상처럼
  불가피한 경우에는 대상별 typed join table 또는 검증된 reference registry를 사용한다.
- FK는 tenant 격리뿐 아니라 삭제·복원·migration 순서를 보장하므로 애플리케이션 검사만으로 대체하지
  않는다.
- FK의 referencing column에는 실제 join과 delete 검사에 필요한 index를 별도로 둔다.

복합 PK·FK와 tenant column 유지의 세부 의미는
[PostgreSQL Constraints](https://www.postgresql.org/docs/16/ddl-constraints.html)를 기준으로 한다.

## RLS와 database role

### Role

| role | 책임 | 제한 |
|---|---|---|
| `pie_migration_owner` | schema와 policy 변경 | 앱 요청 처리 금지, 별도 credential |
| `pie_app` | 사용자 API transaction | table owner 아님, `BYPASSRLS` 없음 |
| `pie_ingest` | 검증된 ingest transaction | ingest table과 함수만 grant |
| `pie_worker` | outbox·projection·retention | queue claim 함수와 필요한 table만 grant |
| `pie_readonly_ops` | 제한된 운영 진단 | 원문·secret column 기본 제외 |
| `pie_break_glass` | 사고 대응 | 평시 비활성, step-up·시간 제한·전수 감사 |

### Request transaction

모든 tenant query는 transaction 안에서 실행한다.

```sql
begin;
set local pie.organization_id = '...';
set local pie.actor_id = '...';
set local pie.request_id = '...';
-- tenant query
commit;
```

`SET LOCAL` 값은 transaction 종료 시 사라진다. connection pool에서 이전 요청 문맥이 남지 않도록
tenant-aware transaction wrapper 밖에서는 tenant repository를 호출할 수 없게 한다.

### Policy

```sql
alter table delivery.projects enable row level security;
alter table delivery.projects force row level security;

create policy tenant_isolation on delivery.projects
  as permissive
  for all
  to pie_app
  using (
    organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid
  );

create policy tenant_boundary_guard on delivery.projects
  as restrictive
  for all
  to pie_app
  using (
    organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid
  );
```

- tenant RLS는 현재 row의 `organization_id`만 비교하는 permissive access policy와 restrictive boundary
  guard를 함께 둔다. guard는 이후 다른 permissive policy가 추가되어도 organization 경계를 넓히지 못하게
  한다.
- Project membership, customer visibility와 field redaction은 서비스 authorization과 projection에서
  처리한다. 복잡한 membership subquery를 모든 RLS policy에 복제하지 않는다.
- table owner와 `BYPASSRLS` role은 일반적으로 RLS를 우회하므로 앱 role과 migration owner를 분리하고
  tenant table에 `FORCE ROW LEVEL SECURITY`를 적용한다.
- request context가 없으면 default deny가 되어야 한다.
- Worker의 cross-tenant claim은 범용 `BYPASSRLS`가 아니라 좁은 queue claim 함수 또는 전용 grant를
  사용하고, claim 후 각 organization transaction으로 실제 업무를 처리한다.

근거는 [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)와
[`SET LOCAL`](https://www.postgresql.org/docs/16/sql-set.html)이다.

## 핵심 table catalog

이 표는 첫 migration 묶음의 최소 물리 책임을 정의한다. 세부 column은 OpenAPI와 도메인 schema를
동시에 작성하면서 확정한다.

### Identity

| table | 핵심 key와 constraint |
|---|---|
| `identity.user_accounts` | `id`, normalized login identity unique, lifecycle status |
| `identity.organizations` | `id`, `slug` unique, status, policy version |
| `identity.memberships` | `(organization_id, id)`, `(organization_id, user_account_id)` unique |
| `identity.roles` | tenant role과 system role 구분, `(organization_id, key)` unique |
| `identity.permissions` | stable action key unique |
| `identity.role_permissions` | role·permission join |
| `identity.membership_roles` | membership·role join, 같은 organization 복합 FK |
| `identity.resource_grants` | subject, typed resource, action, allow/deny, expiry |
| `identity.auth_sessions` | token family hash, device, expiry, revoke reason |
| `identity.invitations` | one-time token hash, intended identity, expiry, consumed transaction |

마지막 owner invariant는 owner membership 변경 transaction에서 row lock과 constraint 검증으로
보호한다. refresh token 원문, MFA secret과 provider client secret은 일반 업무 column이나 로그에 넣지
않는다.

### Delivery

| table | 핵심 key와 constraint |
|---|---|
| `delivery.teams` | `(organization_id, key)` unique, workflow owner |
| `delivery.team_counters` | team별 다음 WorkItem sequence, transaction update |
| `delivery.workflow_states` | `(organization_id, team_id, key)` unique, category, sort key |
| `delivery.projects` | customer·contract relation, delivery status, health, period |
| `delivery.project_teams` | Project·Team many-to-many, 같은 tenant 복합 FK |
| `delivery.work_items` | team sequence, display key, state, assignee, Project optional |
| `delivery.work_item_relations` | parent, blocker, duplicate 등 typed relation과 cycle 차단 |
| `delivery.cycles` | Team period, sequence와 상태 |
| `delivery.initiatives` | owner, health, period와 visibility |
| `delivery.initiative_projects` | explicit membership와 sort key |
| `delivery.milestones` | Project scope, target date와 status |
| `delivery.project_updates` | immutable revision, audience와 publish metadata |
| `delivery.intake_items` | source, deduplication key, suggested routing와 status |
| `delivery.intake_resolutions` | accept·decline·duplicate 결과, target WorkItem |
| `delivery.saved_views` | owner, visibility, versioned filter schema |
| `delivery.comments` | WorkItem·Project 대상, visibility와 revision |

WorkItem human key는 Team counter를 transaction에서 증가시켜 생성하며 primary key로 사용하지 않는다.
Intake accept는 WorkItem, source binding, resolution과 outbox를 하나의 idempotent transaction으로 만든다.

### CRM, Service와 Collaboration

| schema | 핵심 table |
|---|---|
| `crm` | `customer_accounts`, `customer_sites`, `contacts`, `opportunities`, `quotes`, `quote_revisions`, `contracts`, `contract_lines` |
| `service` | `tickets`, `ticket_events`, `sla_policies`, `sla_clocks`, `assets`, `asset_relations`, `remote_sessions`, `remote_session_consents` |
| `collaboration` | `channels`, `channel_members`, `messages`, `message_revisions`, `meetings`, `meeting_participants`, `read_cursors` |

Quote, ProjectUpdate, 고객 승인과 증빙은 게시된 revision을 update로 덮어쓰지 않는다. 새 revision을 만들고
당시 audience, approver와 object reference를 보존한다.

### Agent와 Artifact

| table | 핵심 책임 |
|---|---|
| `agent.agent_sessions` | provider session과 Project·WorkItem binding |
| `agent.agent_runs` | 한 실행 시도, host, model policy와 결과 |
| `agent.agent_turns` | role, sequence, object chunk reference와 content hash |
| `agent.capture_events` | 정규 event metadata, producer와 stream sequence |
| `agent.artifacts` | 논리 산출물과 source lineage |
| `agent.artifact_revisions` | immutable object revision, hash, availability와 classification |
| `agent.objects` | tenant object metadata, storage key, size, media type와 retention |
| `agent.evidence_links` | WorkItem·승인·검수와 immutable Artifact revision 연결 |

전체 transcript, 큰 tool output, patch, report, 첨부와 녹화 본문은 PostgreSQL row에 누적하지 않는다.
PostgreSQL에는 object metadata, hash, byte range, parser version, lineage와 권한만 저장한다.

### Integration, Operations와 Audit

| table | 핵심 책임 |
|---|---|
| `integration.connections` | provider account metadata와 credential reference |
| `integration.external_references` | provider-neutral resource binding과 origin version |
| `integration.webhook_inbox` | 서명·replay 검증 결과와 deduplication |
| `operations.idempotency_records` | principal·tenant·route·key, payload hash와 결과 |
| `operations.outbox_events` | aggregate, event envelope, available time, attempt와 claim |
| `operations.operations` | 비동기 명령 상태와 사용자 표시 결과 |
| `operations.projection_checkpoints` | projection별 server sequence |
| `audit.audit_events` | actor, action, target, before/after digest, request와 trace |
| `audit.access_events` | restricted 원문 조회·내보내기·break-glass 접근 |
| `audit.deletion_tombstones` | purge 대상, lineage와 완료 증거 |

감사 row는 일반 update/delete를 허용하지 않는다. 정정은 원본을 참조하는 새 event로 기록한다.

## Transaction 규칙

모든 권위 mutation은 다음을 한 PostgreSQL transaction에서 처리한다.

```text
permission과 expected version 확인
-> aggregate row 변경
-> immutable revision 또는 relation 변경
-> audit event insert
-> operations.outbox_events insert
-> commit
```

- 외부 API, Object Storage upload와 Webhook 전송을 DB transaction 안에서 기다리지 않는다.
- `version` update는 `where id = ? and organization_id = ? and version = ?` 조건과 함께 증가시킨다.
- deadlock 가능성이 있는 다중 aggregate 변경은 resource 종류와 ID의 고정 순서로 lock한다.
- queue consumer만 `FOR UPDATE SKIP LOCKED`를 사용한다. 일반 목록과 업무 상태 조회에는 사용하지 않는다.
- 실패한 side effect는 outbox retry로 복구하며 업무 transaction을 되돌아간 것처럼 표시하지 않는다.

## Outbox와 idempotency

`operations.outbox_events`의 최소 column은 다음과 같다.

```text
id, organization_id, aggregate_type, aggregate_id, aggregate_version,
event_type, event_schema_version, payload, occurred_at,
available_at, claimed_by, claim_expires_at, attempt_count, published_at, last_error_code
```

권장 claim index는 queue 상태에만 적용하는 partial index다.

```sql
create index outbox_pending_claim_idx
  on operations.outbox_events (available_at, id)
  where published_at is null;
```

`operations.idempotency_records`는 authenticated principal, organization, method, canonical route와
idempotency key의 unique constraint를 가진다. 같은 key의 다른 payload hash는 거부하고 처리 중 lease,
완료 status와 재생 가능한 응답 reference를 저장한다.

## Index 기준

- tenant query index는 `organization_id`를 선두 equality column으로 둔다.
- keyset pagination은 `(organization_id, sort_value desc, id desc)`처럼 stable tie-breaker를 포함한다.
- archive 가능한 목록은 `where archived_at is null` partial index를 우선 검토한다.
- Project Board 기본 index는 `(organization_id, project_id, workflow_state_id, sort_key, id)`다.
- My Work는 assignee, reviewer와 approval projection별 읽기 패턴을 측정해 별도 index 또는 projection을
  둔다. 하나의 거대한 OR query를 기본으로 만들지 않는다.
- FK referencing column, unread cursor, external deduplication key와 active lease에는 명시적 index를 둔다.
- 낮은 cardinality status column 하나만으로 B-tree index를 만들지 않는다.
- 모든 JSONB에 GIN index를 자동 생성하지 않는다. 승인된 query와 size budget이 있는 path만 색인한다.
- production 유사 cardinality와 tenant skew로 `EXPLAIN (ANALYZE, BUFFERS)` 회귀를 검증한다.

다중 B-tree index의 왼쪽 column이 효율에 미치는 기준은
[PostgreSQL Multicolumn Indexes](https://www.postgresql.org/docs/16/indexes-multicolumn.html)를 따른다.

## Object Storage metadata

- object key는 `organization_id` namespace와 무작위 object ID를 포함한다. global content hash 하나로
  tenant 간 object를 deduplicate하지 않는다.
- SHA-256은 무결성과 같은 tenant 안의 deduplication 후보에 사용하며 authorization identity가 아니다.
- presigned URL과 multipart upload ID는 API resource ID가 아니며 짧은 수명을 가진다.
- object는 `staging -> available | quarantined | rejected -> deleting -> deleted` 상태를 가진다.
- Artifact와 Evidence는 `available` immutable revision만 참조한다.
- object delete는 metadata, search, cache, backup policy와 legal hold를 확인하는 비동기 workflow다.
- Object Storage bucket 목록 권한을 client에 주지 않고 server가 tenant·classification·retention을 검증한다.

## 로컬 SQLite 설계

### 파일과 owner

| file | owner | 내용 |
|---|---|---|
| `portal-cache.sqlite` | Main이 관리하는 utility process | projection cache, draft, recent route와 sync checkpoint |
| `capture.sqlite` | 해당 host의 Pie Runtime | capture event, provider cursor, delivery와 object upload |
| `orchestration.sqlite` | Pie Runtime | Agent task DAG, message, decision gate와 dispatch |

DB 파일을 하나로 합쳐 high-write capture가 UI cache와 orchestration을 block하게 하지 않는다. provider가
소유한 Claude Code, Codex와 OpenCode DB를 Pie DB로 사용하거나 migration하지 않는다.

### Capture table

| table | 책임 |
|---|---|
| `capture_event` | immutable normalized metadata, stream sequence와 content hash |
| `outbox_delivery` | pending lease, retry, ack와 permanent rejection |
| `provider_cursor` | provider file identity와 byte/opaque cursor |
| `stream_checkpoint` | contiguous local·server sequence와 gap |
| `capture_policy_cache` | 만료가 있는 capture·retention policy |
| `object_upload` | encrypted staging chunk, part와 finalize checkpoint |

- transcript parse, event insert와 provider cursor advance는 한 SQLite transaction이다.
- network와 Object Storage upload는 transaction 밖에서 실행한다.
- Runtime은 single writer와 짧은 transaction을 유지한다.
- WAL을 사용할 때 DB, `-wal`, `-shm`을 하나의 상태로 취급하고 임의 삭제하지 않는다.
- schema version과 sequential migration을 기록하고 migration 실패 시 이전 schema로 traffic을 처리하지
  않는다.
- byte quota를 metadata, encrypted staging과 전송 완료 보존으로 나눠 계측한다.
- quota 초과 시 미전송 원문을 조용히 버리지 않고 capture pause 또는 metadata-only 상태를 표시한다.
- raw payload는 SQLite BLOB에 장기 보관하지 않고 암호화된 staging object로 둔다.
- OS key store나 승인된 host key source가 없으면 raw capture를 비활성화하고 metadata-only로 동작한다.
- native, WSL, SSH와 Relay Runtime은 `host_id`와 DB를 공유하지 않는다. 로컬 절대 경로를 중앙 ID로
  전송하지 않는다.

## Cache와 오프라인

- cache row는 `organization_id`, resource ID, server version, fetched sequence, expiry와 visibility class를
  가진다.
- 사용자·조직 전환 시 cache key와 query namespace를 분리한다.
- permission revoke, logout과 capture kill switch를 받으면 새 write·upload를 fail closed하고 cache를
  잠그거나 삭제한다.
- WorkItem description과 comment draft는 로컬 저장할 수 있지만 상태 이동, 승인, 고객 게시, 원격 실행은
  offline mutation queue에 넣지 않는다.
- cache migration 실패가 local terminal과 Git 작업까지 막지 않도록 Portal cache 복구와 Workspace
  실행 복구를 분리한다.

## Migration과 schema 배포

중앙 migration은 Kysely migrator가 실행하는 순서 고정 migration을 사용하며 SQL이 물리 schema의
권위자다.

```text
services/control-plane/src/database/
├── migrations/
│   ├── 202607150900_identity_foundation.ts
│   ├── 202607150910_tenant_rls.ts
│   └── 202607150920_operations_outbox.ts
├── generated/
│   └── database-types.ts
├── tenant-transaction.ts
└── migration-runner.ts
```

- migration 이름은 UTC timestamp와 구체적인 목적을 가진다.
- migration은 현재 domain code를 import하지 않고 frozen-in-time 상태를 유지한다.
- DDL, RLS, function, index와 backfill은 검토 가능한 명시적 SQL을 허용한다.
- production rollback은 자동 `down`보다 forward repair를 기본으로 한다.
- 한 deployment만 advisory lock을 획득해 migration을 실행한다.
- 변경은 `expand -> backfill -> switch -> contract` 순서를 지키며 구버전 API, Worker와 Electron의
  compatibility window를 문서화한다.
- 큰 table의 default, not-null, index와 type 변경은 lock과 WAL budget을 측정한 뒤 단계적으로 수행한다.
- CI는 빈 DB migration, 이전 release upgrade, schema fingerprint, generated Kysely type drift, RLS deny와
  downgrade 불가 표기를 검사한다.

Kysely migration은 migration이 현재 애플리케이션 코드에 의존하지 않아야 한다고 명시한다.
[Kysely Migrations](https://kysely.dev/docs/migrations)을 구현 기준으로 사용한다.

## Backup, 복원과 보존

- PostgreSQL은 point-in-time recovery가 가능한 base backup과 WAL 보존을 사용한다.
- Object Storage versioning·retention과 PostgreSQL metadata backup의 시점을 correlation한다.
- SQLite outbox는 서버 backup 대상이 아니다. 미전송 event는 host 복구 절차와 transcript reconciliation로
  보완한다.
- restore test는 별도 organization과 격리 환경에서 FK, RLS, object hash, outbox와 search rebuild를
  검증한다.
- Search projection은 PostgreSQL과 Object Storage에서 재생성 가능해야 한다.
- 삭제 tombstone과 legal hold는 backup 만료·복구 Runbook에도 적용한다.

## 구현 단계

1. PostgreSQL 16+ 개발 container와 migration runner를 추가한다.
2. database role, 고정 schema, `identity.organizations`와 임시 actor를 만든다.
3. tenant transaction wrapper, RLS와 direct SQL negative test를 만든다.
4. `operations.idempotency_records`와 `outbox_events`를 구현한다.
5. Organization mutation에서 `DB -> outbox -> Worker -> Realtime invalidation` 수직 흐름을 검증한다.
6. R3 identity·RBAC schema와 R4 Team·Project·WorkItem schema를 순차 추가한다.
7. `capture.sqlite` schema와 ingest batch를 연결한다.
8. Object upload intent·finalize와 Artifact immutable revision을 연결한다.
9. backup restore, expand-contract upgrade와 tenant isolation 부하 시험을 release gate에 넣는다.

## 완료 기준

- app role로 tenant context 없이 조회·삽입하면 결과가 없거나 거부된다.
- URL, body, cached organization을 바꿔도 복합 FK와 RLS가 cross-tenant relation을 차단한다.
- 동일 mutation transaction에 aggregate, audit와 outbox가 모두 있거나 모두 없다.
- Worker concurrency에서 outbox event가 중복 전달되어도 업무 side effect는 하나다.
- 구버전 API·Worker가 실행 중인 상태에서 expand-contract migration과 rollback rehearsal이 성공한다.
- transcript와 큰 tool output이 PostgreSQL row에 누적되지 않고 Object Storage lineage로 검증된다.
- capture DB 손상·quota·재시작·네트워크 단절 후 cursor와 contiguous ack가 복구된다.
- native, WSL, SSH와 Relay host의 SQLite state와 local path가 서로 섞이지 않는다.
- 고객·협력사·게스트 query, search, cache와 recent route에서 제한 field와 resource가 노출되지 않는다.
