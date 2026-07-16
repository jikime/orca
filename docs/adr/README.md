# Architecture Decision Records

ADR은 Pie의 구현과 운영을 제한하는 중요한 결정을 기록한다. 같은 항목이 충돌하면 승인된 ADR,
version이 고정된 schema, 보안·데이터 계약, 제품 문서 순으로 적용한다.

## 상태

- `Proposed`: 검토 중이며 구현을 고정하지 않는다.
- `Accepted`: 구현 기준이다.
- `Superseded`: 새 ADR로 대체되었으며 이력만 유지한다.
- `Deprecated`: 새 구현에 사용하지 않지만 대체 결정이 없을 수 있다.

## 규칙

- 번호는 재사용하지 않는다.
- 결정을 바꾸면 기존 파일을 지우지 않고 새 ADR에서 `Supersedes`를 명시한다.
- `Accepted` ADR에는 검증 방법과 영향 받는 문서를 적는다.
- library와 protocol은 lockfile·contract에서 실제 사용 version을 고정한다.
- 보안, tenant key, 원문 보존과 호환성 변경은 구현 PR만으로 바꾸지 않는다.

## 인덱스

| ADR | 상태 | 결정 |
|---|---|---|
| [0003](./0003-local-sqlite-outbox.md) | Accepted | 로컬 SQLite cache·capture outbox와 single-writer 소유권 |
| [0004](./0004-tenant-enforcement.md) | Accepted | `organization_id` 복합 FK, transaction context와 RLS |
| [0005](./0005-control-plane-persistence.md) | Accepted | PostgreSQL 16+, Kysely·`pg`와 SQL 중심 migration |
| [0006](./0006-object-storage-boundary.md) | Accepted | 대형 원문·binary의 Object Storage 분리와 immutable revision |
| [0007](./0007-instance-discovery-and-connection-profiles.md) | Accepted | Control Plane 단일 URL discovery와 instance별 연결 프로필 격리 |
| [0008](./0008-control-plane-modular-monolith.md) | Accepted | Fastify 기반 Control Plane 모듈형 모놀리스와 API·Worker process 분리 |
| [0009](./0009-identity-provider-and-application-authorization.md) | Accepted | Keycloak 인증과 Pie Organization·RBAC authorization 분리 |
| [0010](./0010-contract-first-wire-specifications.md) | Accepted | OpenAPI·AsyncAPI·JSON Schema contract-first 권위와 생성물 관리 |
| [0011](./0011-self-hosted-platform-dependencies.md) | Accepted | SeaweedFS·LiveKit과 Core·Support·Meeting optional 배포 profile |
