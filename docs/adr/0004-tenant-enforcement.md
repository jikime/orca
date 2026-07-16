# ADR-0004: Tenant key, 복합 FK와 RLS

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture and Security
- 관련 문서: `pie-docs/11-security-administration.md`, `pie-docs/24-security-threat-model.md`,
  `pie-docs/30-database-physical-design.md`

## 맥락

Pie의 한 설치와 Control Plane은 여러 개인·회사 조직, 고객, 협력사와 게스트를 처리한다. URL이나
API payload의 resource ID, application query filter와 UI 메뉴만으로 tenant를 격리하면 누락된 조건
하나가 다른 조직의 프로젝트, transcript, 계약 또는 원격 세션을 노출할 수 있다.

동시에 RLS 하나에 모든 Project membership과 field visibility를 구현하면 policy가 복잡해지고 service
authorization과 의미가 분리될 수 있다. database는 조직 경계와 관계 무결성을 강제하고, 세부 action과
field projection은 application policy가 담당해야 한다.

## 결정

1. `identity.user_accounts` 같은 명시적인 global table을 제외한 모든 tenant row는
   `organization_id uuid not null`을 가진다.
2. tenant resource는 `id` primary key 외에 `(organization_id, id)` unique constraint를 가진다.
3. tenant 간 FK는 `(organization_id, resource_id)`를 함께 참조한다. optional relation은
   `resource_id`만 null일 수 있고 값이 있으면 같은 organization의 대상만 허용한다.
4. tenant query index는 `organization_id`를 leading equality column으로 둔다. 예외는 측정과 query
   contract를 ADR 또는 schema comment에 남긴다.
5. app role은 tenant table owner가 아니며 `SUPERUSER`와 `BYPASSRLS`를 갖지 않는다. migration owner,
   app, ingest, worker, readonly operations와 break-glass role을 분리한다.
6. tenant table은 RLS를 `ENABLE`하고 `FORCE`한다. 같은 organization을 허용하는 permissive policy와
   organization 경계를 고정하는 restrictive guard가 row의 `organization_id`와 transaction-local
   `pie.organization_id`를 비교한다.
7. 모든 tenant repository 접근은 `withTenantTransaction` 계열의 좁은 API 안에서 수행한다. wrapper는
   검증된 organization, actor와 request ID를 `SET LOCAL`로 설정한다.
8. tenant context가 없거나 잘못되면 default deny한다. pool에서 session-level tenant 설정을 사용하지
   않는다.
9. RLS는 조직 격리의 defense-in-depth다. resource action, customer/internal visibility, entitlement와
   field redaction은 service authorization과 response projection에서 다시 확인한다.
10. Worker의 cross-tenant queue claim은 범용 RLS 우회 role 대신 좁은 security-definer claim 함수 또는
    queue 전용 grant로 처리한다. 실제 업무 처리는 claim된 organization별 transaction으로 돌아간다.
11. direct SQL app-role test, API cross-tenant test, search/cache/recent route leak test를 release gate로 둔다.

PostgreSQL에서 table owner와 `BYPASSRLS` role은 일반적으로 row policy를 우회하고 policy가 없으면
default deny가 적용된다. 이 동작은
[PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)를
기준으로 한다. `SET LOCAL`은 transaction 종료 시 사라지므로 pooled connection의 request context에
사용한다([PostgreSQL SET](https://www.postgresql.org/docs/16/sql-set.html)).

## RLS policy 형태

RLS policy는 가능한 한 현재 row만 검사한다. PostgreSQL은 restrictive policy만으로 row를 허용하지
않으므로 동일 tenant를 허용하는 permissive policy를 두고, 이후 policy의 OR 결합이 tenant 경계를
넓히지 않도록 같은 조건의 restrictive guard를 함께 둔다.

```sql
create policy tenant_access on delivery.projects
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

membership, role 또는 customer relation을 읽는 복잡한 subquery를 모든 table policy에 넣지 않는다.
필요한 경우 검토된 security-definer function과 concurrency test를 사용하고 일반 규칙의 예외로 기록한다.

## 검토한 대안

### Application filter만 사용

query, export, background worker와 새 endpoint에서 filter 누락을 database가 막지 못하므로 선택하지 않는다.

### Tenant별 PostgreSQL schema

tenant 수에 비례해 migration, pool, backup과 search 운영이 복잡해지고 cross-tenant 운영 query가
어려워지므로 선택하지 않는다.

### Tenant별 database

최상위 enterprise isolation 옵션으로는 남기지만 초기 제품의 transaction, migration과 운영 비용이
과도하므로 기본 topology로 선택하지 않는다.

### 모든 authorization을 RLS에 구현

field redaction, time-bound grant, entitlement와 업무 action을 SQL policy에 중복시키면 설명 가능성과
테스트 경계가 나빠지므로 선택하지 않는다.

## 결과와 제약

- 모든 tenant FK와 index가 더 넓어지고 migration 작성 비용이 증가한다.
- global user와 tenant membership을 명확히 구분해야 한다.
- cross-tenant 운영 작업은 일반 app query보다 좁고 감사 가능한 별도 경로가 필요하다.
- unique/FK 오류가 다른 tenant resource 존재를 암시하지 않도록 API 오류를 정규화해야 한다.
- RLS policy 변경은 보안 변경으로 취급하고 migration owner만 적용한다.

## 검증

- 같은 ID 형태로 organization만 바꾼 direct SQL allow·deny matrix
- app role의 table owner·`BYPASSRLS` 부재 검사
- connection pool concurrency와 transaction 종료 후 context reset test
- cross-tenant FK insert·update 거부 test
- customer, partner, guest의 internal field·search·cache leak test
- worker queue claim 후 organization별 재인가 test
- backup role에서 RLS로 row가 누락되지 않는 restore rehearsal
