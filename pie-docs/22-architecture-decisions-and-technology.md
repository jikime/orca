# 아키텍처 결정과 기술 기준

## 목적

구현 중 반복해서 다시 열릴 결정을 한곳에서 관리한다. 이 문서는 ADR의 인덱스 역할을 하며, 실제
코드 변경 전에는 중요한 항목을 `docs/adr`의 개별 기록과 executable contract로 옮긴다.

## 채택한 기본 결정

| ID | 결정 | 상태 | 이유와 제약 |
|---|---|---|---|
| DEC-001 | 데스크톱은 Electron을 유지한다. | 기준 | 기존 Workspace, PTY, Git, SSH, AI 기능의 회귀 위험을 줄이고 제품 수직 흐름을 먼저 검증한다. |
| DEC-002 | Control Plane은 TypeScript 모듈형 단일 서비스로 시작한다. | 기준 | 초기 분산 transaction과 운영 복잡도를 줄이되 identity, domain, ingest, worker 경계는 코드 모듈과 지표로 분리한다. |
| DEC-003 | 외부 API는 HTTPS JSON `/v1`과 OpenAPI 3.1 계열로 기술한다. | 기준 | 언어 독립 계약, client 생성, schema review와 contract test를 같은 문서에서 수행한다. |
| DEC-004 | 공통 payload는 JSON Schema 2020-12로 검증한다. | 기준 | HTTP, IPC, Runtime과 event fixture에 같은 validation 의미를 적용한다. |
| DEC-005 | HTTP 오류는 RFC 9457 Problem Details를 사용한다. | 기준 | 상태 코드와 안정적인 Pie 오류 코드를 분리하고 내부 stack·SQL·경로는 노출하지 않는다. |
| DEC-006 | 수정 경쟁은 entity version과 strong `ETag`/`If-Match`로 탐지한다. | 기준 | multi-device와 offline 편집에서 lost update를 조용히 덮어쓰지 않는다. |
| DEC-007 | 이벤트 envelope는 CloudEvents 1.0 의미와 호환한다. | 기준 | `id`, `source`, `type`, `time`, `dataschema`의 공통 의미를 유지하고 Pie 문맥은 extension/data에 둔다. |
| DEC-008 | 서비스 trace는 W3C Trace Context를 전파한다. | 기준 | Electron 요청, API, DB outbox, Worker를 하나의 trace로 연결한다. AI event의 업무 correlation과 운영 trace는 별도 ID다. |
| DEC-009 | 중앙 권위 저장소는 PostgreSQL이다. | 기준 | 업무 transaction, 관계 무결성, 감사와 RLS defense-in-depth를 제공한다. |
| DEC-010 | 큰 원문과 binary는 S3 호환 Object Storage에 둔다. | 기준 | DB에는 object ID, hash, size, classification과 lineage만 저장한다. 특정 cloud 공급자 API를 도메인에 노출하지 않는다. |
| DEC-011 | 초기 비동기 처리는 PostgreSQL transactional outbox + worker로 시작한다. | 기준 | 사용자 transaction과 event 발행의 유실을 막는다. 독립 broker는 측정된 처리량이나 격리 요구가 생길 때 ADR로 추가한다. |
| DEC-012 | Realtime은 변경 통지이고 REST snapshot/delta가 복구 권위자다. | 기준 | 연결 단절과 메시지 유실을 정상 상태로 취급하고 raw transcript·terminal stream을 보내지 않는다. |
| DEC-013 | 로컬 event 수집은 SQLite outbox를 사용한다. | 기준 | 단일 writer와 짧은 transaction을 유지하고 손상 검사, quota, backup, version gate를 구현해야 한다. |
| DEC-014 | MCP와 자동 telemetry를 분리한다. | 기준 | MCP는 LLM의 명시적 업무 도구이고 Hook·transcript·observer가 수집을 담당한다. |
| DEC-015 | 로컬 Pie MCP는 `stdio`가 기본이다. | 기준 | 로컬 HTTP listener와 장기 사용자 token 노출을 피한다. Remote MCP는 별도 OAuth·Origin 정책을 요구한다. |
| DEC-016 | 조직·프로젝트·업무 ID는 opaque UUID를 사용한다. | 기준 | ID에 시간·tenant·경로 의미를 넣지 않는다. 정렬과 누락 탐지는 서버 sequence와 stream sequence로 해결한다. |
| DEC-017 | 검색 projection은 원본이 아니며 삭제 lineage를 공유한다. | 기준 | 권한·보존 변경 시 재생성할 수 있어야 하고 검색 결과만으로 원문 존재를 확정하지 않는다. |
| DEC-018 | 중앙 query 계층은 Kysely와 `pg`, schema 변경은 SQL 중심 Kysely migration을 사용한다. | 기준 | RLS transaction 문맥과 PostgreSQL 기능을 명시적으로 유지하면서 TypeScript query type을 제공한다. |
| DEC-019 | 하나의 PostgreSQL 16+ database를 고정 schema로 나누고 tenant 관계는 `organization_id` 복합 FK와 RLS로 강제한다. | 기준 | 초기 분산 transaction을 피하고 query 누락과 잘못된 tenant relation을 DB에서도 차단한다. |
| DEC-020 | SaaS와 Self-hosted 연결은 Control Plane bootstrap URL 하나와 `/.well-known/pie` discovery를 사용한다. | 기준 | Desktop에 DB·Object Storage credential과 개별 service 설정을 노출하지 않고 instance별 token·cache를 격리한다. |
| DEC-021 | Control Plane은 Node.js 24·Fastify 5 모듈형 모놀리스와 별도 API·Worker process로 시작한다. | 기준 | domain transaction을 유지하면서 request와 background workload의 lifecycle을 분리한다. |
| DEC-022 | Keycloak이 인증을 담당하고 Pie가 Organization·Membership·RBAC를 소유한다. | 기준 | credential과 federation을 직접 구현하지 않되 업무 권한을 IdP role에 종속시키지 않는다. |
| DEC-023 | wire 계약의 권위는 OpenAPI 3.1.2, AsyncAPI 3.0.0과 JSON Schema 2020-12다. | 기준 | Desktop, TypeScript server와 Go data plane이 같은 runtime validation과 compatibility fixture를 사용한다. |
| DEC-024 | Local Docker Object Storage 기본값은 SeaweedFS이며 MinIO는 기존 설치 호환 대상으로만 둔다. | 기준 | S3 adapter를 유지하면서 archived 된 MinIO community server를 신규 기본 운영 의존성에서 제외한다. |
| DEC-025 | 회의 Media SFU는 optional `meeting` profile의 Self-hosted LiveKit을 사용한다. | 기준 | WebRTC media를 직접 구현하지 않고 Core 업무 traffic·readiness와 분리한다. |
| DEC-026 | Self-hosted는 `core`, `support`, `meeting`, `observability` profile로 구성한다. | 기준 | Project 관리 설치에 Relay·Media·관측 backend를 강제로 요구하지 않는다. |

database 물리 구조와 상세 근거는 [데이터베이스 물리 설계](./30-database-physical-design.md)와
[`ADR-0003`~`ADR-0006`](../docs/adr/README.md), 배포 instance discovery는
[SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md),
[Reference Architecture v1](./32-reference-architecture-v1.md),
[Contract Specification과 변경 관리](./33-contract-specification-governance.md)와
[`ADR-0007`~`ADR-0011`](../docs/adr/README.md)을 따른다.

## 표준 적용 기준

### HTTP와 schema

- OpenAPI는 [OpenAPI Specification 3.1.2](https://spec.openapis.org/oas/v3.1.2.html)를 고정해
  request, response, security scheme과 callback을 기술한다.
- 공통 schema는 [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) dialect를 사용한다.
- Realtime WebSocket은 [AsyncAPI 3.0.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0)으로
  handshake, message, close와 resync 의미를 기술한다.
- 오류 본문은 [RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457)의
  `application/problem+json`을 사용한다.
- 동시 수정은 [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110)의 strong entity tag와
  `If-Match` 조건을 사용한다.
- OpenAPI 문서가 실제 validator 동작과 다르면 서버가 사용한 schema와 테스트 결과를 기준으로
  원인을 수정하고 둘을 방치하지 않는다.

### 인증

- 기본 Identity Provider는 Keycloak이며 organization마다 realm을 만들지 않는다.
- Keycloak은 credential·MFA·Passkey·federation을, Pie는 issuer·subject mapping과 업무 RBAC를 소유한다.
- OIDC 로그인은 [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)에 따라 embedded webview가
  아니라 시스템 브라우저에서 Authorization Code + PKCE로 수행한다.
- loopback callback은 ephemeral port와 loopback IP literal만 사용하고 응답 직후 listener를 닫는다.
- private URI scheme을 쓸 때도 PKCE, exact redirect, `state`, `nonce`, issuer 검증을 생략하지 않는다.
- public Electron binary에 포함된 client secret은 비밀로 취급하지 않는다.
- 구현은 [OAuth 2.0 Security BCP, RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700)의 redirect
  exact match, code flow, PKCE와 token replay 완화를 따른다.

### 이벤트와 관측

- event deduplication key는 CloudEvents가 정의한 `source + id` 의미를 보존한다. Pie ingest에서는
  여기에 organization boundary를 추가해 조회와 unique constraint를 건다.
- `traceparent`는 [W3C Trace Context](https://www.w3.org/TR/trace-context/) 형식으로 전파한다.
- `correlationId`는 업무 명령·감사·이벤트 연결, `traceId`는 운영 요청 추적에 사용한다. 하나를 다른
  하나의 영구 식별자로 재사용하지 않는다.
- OpenTelemetry는 trace·metric·log 수집 구현이며 Agent prompt나 transcript를 자동으로 export하는
  통로가 아니다.

### 테넌트 저장소

- 모든 테넌트 행은 `organization_id`를 가지며 관계의 양쪽 tenant가 일치하는지 DB 제약과 서비스
  정책에서 확인한다.
- PostgreSQL RLS는 defense-in-depth로 사용한다. [공식 RLS 문서](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)가
  설명하듯 table owner와 `BYPASSRLS` 역할은 일반적으로 정책을 우회하므로, 애플리케이션 DB role은
  migration owner와 분리한다.
- request transaction 시작 시 검증된 tenant와 actor 문맥을 `SET LOCAL` 계열로 전달하고 connection
  pool 반환 전에 transaction이 끝났는지 보장한다.
- RLS가 있다고 service-level authorization, field redaction, Object Storage tenant 검증을 생략하지
  않는다.

### 로컬 SQLite

- `node:sqlite`의 `DatabaseSync`는 동기 API이므로 Renderer와 latency-sensitive Main handler에서 긴
  query를 실행하지 않는다. Runtime 또는 전용 utility process가 저장 책임을 가진다.
- WAL을 사용하면 DB, `-wal`, `-shm`을 하나의 상태로 취급한다. 실행 중 DB 파일만 복사하거나 WAL을
  임의 삭제하지 않는다.
- [SQLite WAL 문서](https://sqlite.org/wal.html)에 따라 checkpoint starvation, WAL 크기, busy와
  종료 시나리오를 계측한다.
- 2026년 공개된 WAL-reset 동시성 문제 때문에 SQLite `3.51.3+`, `3.50.7+`, `3.44.6+` 중 해당
  수정이 포함된 버전만 다중 연결 WAL에 허용한다. 그보다 낮은 번들에서는 outbox를 단일 connection,
  단일 writer로 제한하고 동시 checkpoint를 금지하거나 수정 버전으로 올린다.
- 현재 개발 shell의 Node 22.19.0은 SQLite 3.50.4, 설치된 Electron 43.1.0 main process는 SQLite
  3.53.1을 보고한다. Electron 쪽은 수정 기준을 충족하지만 test Node와 앱 runtime이 다르므로
  packaged runtime의 `process.versions.sqlite`를 CI와 앱 진단에서 계속 검사한다.

### MCP

- 구현 기준 protocol은 `2025-11-25`로 고정하고 연결 시 capability를 협상한다.
- 표준 transport는 [MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)의
  `stdio`와 Streamable HTTP만 사용한다.
- remote server는 Origin 검증, localhost binding 기본값, HTTPS와 인증을 적용한다.
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)에
  따라 token audience/resource를 검증하고 token passthrough를 금지한다.
- stream 연결 종료를 작업 취소로 해석하지 않는다. 변경 도구는 별도 idempotency key와 상태 조회를
  제공한다.
- tool annotation은 신뢰 경계가 아니며 실제 permission, target, side effect를 서버에서 검증한다.

## 초기 Control Plane 형태

```text
Fastify HTTP API process
├── identity adapter
├── authorization policy
├── project/work domain
├── agent ingest
├── artifact metadata
├── audit writer
└── realtime publisher

Worker process
├── transactional outbox claim
├── projection
├── notification
├── webhook
└── retention/deletion
```

같은 repository와 schema package를 공유할 수 있지만 API와 Worker는 별도 process로 실행한다.
Worker가 outbox를 claim할 때 PostgreSQL `FOR UPDATE SKIP LOCKED`를 사용할 수 있다. 이 방식은
일반 조회에 일관된 view를 제공하지 않으므로 queue-like table에만 제한한다.

## 아직 선택하지 않는 기술

| 항목 | 현재 방침 | 결정 시점 |
|---|---|---|
| 별도 message broker | PostgreSQL outbox 처리량과 격리 한계를 측정한 뒤 선택 | R5 이후 또는 부하 기준 초과 시 |
| 전용 search engine | PostgreSQL metadata 검색과 권한 회수 SLO를 먼저 측정 | R5 이후 |
| policy engine | 코드 기반 permission이 설명 가능성과 성능 요구를 못 채울 때 검토 | R3 이후 |
| 원격 데스크톱 엔진 | 플랫폼 권한, 입력 주입, 재부팅, 품질과 라이선스를 sidecar prototype으로 비교 | R8 시작 전 |
| 비밀·KMS 구현 | cloud KMS와 Self-hosted secret manager의 key lifecycle을 비교 | production 배포 전 |
| Kubernetes | 단일 서비스 운영·복구 요구가 확인되기 전 기본 전제 아님 | 배포 ADR |
| multi-region active-active | 데이터 주권과 계약 SLO가 요구할 때 검토 | 엔터프라이즈 단계 |

## 반드시 별도 ADR이 필요한 변경

- Electron에서 Tauri로의 전환 또는 Renderer에 직접 Node 권한 부여
- 서비스 분리와 독립 데이터베이스 도입
- event broker, search engine, policy engine의 신규 운영 의존성
- raw transcript 기본 수집 또는 기본 보존 기간 변경
- E2EE가 적용되는 데이터 범위와 server-side 검색의 변경
- 원격 명령이 allowlist 밖의 shell을 실행하도록 하는 변경
- tenant key, RLS, Object Storage namespace 규칙의 변경
- MCP protocol 버전과 remote transport의 변경
