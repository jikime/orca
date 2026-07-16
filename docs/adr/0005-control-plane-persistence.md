# ADR-0005: Control Plane persistence와 migration 계층

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture
- 관련 문서: `pie-docs/12-electron-system-architecture.md`,
  `pie-docs/22-architecture-decisions-and-technology.md`, `pie-docs/30-database-physical-design.md`

## 맥락

Pie는 organization, RBAC, Project, WorkItem, 고객, 티켓, AI session metadata, audit와 outbox를
transaction으로 연결해야 한다. 초기 팀은 TypeScript Control Plane과 Worker를 운영하며 cloud와
on-prem PostgreSQL을 같은 contract로 지원해야 한다.

물리 설계에는 RLS, transaction-local request context, 복합 FK, partial index, advisory lock,
`FOR UPDATE SKIP LOCKED`와 명시적인 expand-contract migration이 필요하다. persistence 도구가 이 SQL
기능을 숨기거나 schema를 자동 동기화해서는 안 된다.

## 결정

1. Pie 업무 도메인의 중앙 권위 저장소는 하나의 PostgreSQL database다. 외부 Identity Provider가
   소유하는 database는 이 범위에 포함하지 않으며 Pie가 직접 query하지 않는다.
2. 최소 지원 major는 PostgreSQL 16이며 지원되는 최신 minor를 사용한다.
3. bounded context는 고정 PostgreSQL schema로 분리하고 tenant별 schema나 서비스별 database를 만들지
   않는다.
4. TypeScript query 계층은 `Kysely`와 PostgreSQL `pg` driver를 사용한다.
5. domain module은 전역 database handle을 직접 import하지 않는다. request context가 설정된 transaction
   또는 명시적인 system transaction을 주입받는다.
6. 모든 tenant transaction은 같은 pooled connection에서 `BEGIN`, `SET LOCAL`, query, `COMMIT` 또는
   `ROLLBACK`을 수행한다.
7. migration은 Kysely migrator가 순서대로 실행하는 timestamp 이름의 frozen migration이다. 물리
   schema, RLS, function, partial index와 backfill은 검토 가능한 명시적 SQL을 사용할 수 있다.
8. migration이 현재 domain code나 generated database type을 import하지 않게 한다.
9. SQL migration이 schema의 권위자다. Kysely database type은 migration을 적용한 임시 DB에서 생성하고
   CI가 drift를 검사한다.
10. production에서 runtime `push`, schema auto-sync와 destructive automatic `down` migration을 사용하지
    않는다. rollback은 compatibility가 유지되는 code rollback 또는 forward repair가 기본이다.
11. schema 변경은 `expand -> backfill -> switch -> contract` 순서를 사용하고 이전 API·Worker·Electron의
    compatibility window가 끝나기 전 contract migration을 실행하지 않는다.
12. API transaction은 aggregate, audit와 transactional outbox를 함께 commit한다. 별도 broker는
    처리량·격리 기준을 넘기 전 도입하지 않는다.

Kysely는 PostgreSQL dialect에서 `pg`를 사용하고 typed query, raw SQL, transaction과 migration을
제공한다([Kysely Getting Started](https://kysely.dev/docs/getting-started)). Kysely migration 문서는
migration이 변화하는 현재 app code에 의존하지 않고 frozen-in-time이어야 한다고 명시한다
([Kysely Migrations](https://kysely.dev/docs/migrations)).

## Schema와 process

```text
PostgreSQL
├── identity
├── delivery
├── crm
├── service
├── collaboration
├── agent
├── integration
├── operations
└── audit

API process  ---- tenant transaction ----+
Ingest       ---- ingest transaction ----+--> PostgreSQL
Worker       ---- claim/system + tenant -+
Migration    ---- owner connection ------+
```

API, Ingest, Worker와 Migration은 credential과 grant가 다르다. Migration process는 애플리케이션 요청을
처리하지 않는다.

## Query layer 규칙

- repository 입력과 반환은 domain type이며 Kysely row type을 API DTO로 직접 노출하지 않는다.
- SQL identifier는 compile-time query builder 또는 allowlist로만 구성한다. filter 값을 identifier에
  보간하지 않는다.
- raw SQL은 RLS, migration, lock, optimized report처럼 SQL 의미가 핵심인 곳에 허용하고 parameter
  binding과 module ownership을 유지한다.
- transaction을 시작한 connection과 query connection이 같아야 한다. pool-level query로 transaction
  문맥을 우회하지 않는다.
- system transaction은 이름, 목적, 허용 schema와 audit requirement를 명시한다.
- N+1, unbounded list와 large JSON aggregate를 repository 기본값으로 허용하지 않는다.

## 검토한 대안

### `pg`만 직접 사용

SQL 통제는 높지만 반복적인 row type, query composition과 result typing 비용이 커지므로 기본 계층으로
선택하지 않는다. Kysely raw SQL로 필요한 제어를 유지한다.

### Drizzle ORM

RLS와 migration을 지원하는 유효한 후보지만 Pie는 SQL migration을 물리 schema의 단일 권위자로 두고
얇은 typed query builder를 사용하려 한다. declarative application schema를 별도 권위로 두지 않기 위해
선택하지 않는다.

### Prisma

CRUD 생산성보다 RLS transaction context, SQL-first migration, queue claim과 partial index의 명시성이
우선이므로 선택하지 않는다.

### 서비스별 database

초기 Intake·Project·WorkItem·Artifact transaction과 운영 복잡도를 증가시키므로 선택하지 않는다.
서비스 분리가 필요해지면 outbox와 ownership 측정 결과를 근거로 별도 ADR을 작성한다.

## 결과와 제약

- 개발자는 PostgreSQL과 SQL migration을 이해해야 한다.
- generated Kysely type과 schema drift CI가 추가된다.
- TypeScript type은 database constraint와 runtime validation을 대체하지 않는다.
- 단일 DB의 blast radius를 backup, role, connection budget과 restore rehearsal로 관리해야 한다.
- Kysely와 `pg` version은 server package lockfile에서 고정하고 upgrade 시 transaction·type·migration
  contract test를 실행한다.

## 검증

- 빈 PostgreSQL 16+에서 전체 migration과 schema fingerprint test
- 이전 release snapshot에서 expand-contract upgrade test
- tenant transaction wrapper 밖의 repository 호출 compile/runtime 차단 test
- pool connection 재사용과 `SET LOCAL` reset concurrency test
- aggregate·audit·outbox atomicity fault test
- Worker `SKIP LOCKED` claim, lease expiry와 duplicate side-effect test
- generated database type drift와 migration ordering CI
- cloud와 on-prem PostgreSQL 호환 contract suite
