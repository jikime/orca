# Contract Specification과 변경 관리

## 목표

Electron, Runtime, Control Plane, Worker, Relay와 Edge Agent가 서로 다른 시점에 배포되어도 같은
요청·이벤트·실패 의미를 사용하게 한다. TypeScript type만 공유하는 방식이 아니라 version이 고정된
언어 독립 schema, fixture와 compatibility test를 구현의 권위로 둔다.

Reference topology는 [Reference Architecture v1](./32-reference-architecture-v1.md), 결정 근거는
[`ADR-0010`](../docs/adr/0010-contract-first-wire-specifications.md)을 따른다.

## 권위 순서

동일한 계약이 충돌하면 다음 순서로 해결한다.

1. Accepted ADR
2. version이 고정된 OpenAPI·AsyncAPI·JSON Schema
3. valid·invalid·compatibility fixture와 contract test
4. SQL migration과 database constraint
5. generated TypeScript type과 client
6. 구현 코드와 설명 문서

generated type이 schema와 다르면 generated type을 수동 수정하지 않고 schema 또는 generator를
수정한다. 문서 예시가 fixture와 다르면 fixture를 기준으로 예시를 바로잡는다.

## 저장소 구조

```text
contracts/
├── openapi/
│   └── pie-control-plane-v1.yaml
├── asyncapi/
│   └── pie-realtime-v1.yaml
├── schemas/
│   ├── common/
│   ├── discovery/
│   ├── events/
│   ├── resources/
│   ├── ipc/
│   ├── runtime/
│   └── mcp/
├── fixtures/
│   ├── valid/
│   ├── invalid/
│   └── compatibility/
├── manifests/
│   ├── permissions.json
│   ├── roles.json
│   ├── entitlements.json
│   ├── capabilities.json
│   ├── protocol-support.json
│   ├── error-codes.json
│   ├── mcp-tools.json
│   ├── security-gates.json
│   ├── support-matrix.json
│   ├── source-baselines.json
│   └── kroot-capability-migration.json
└── scripts/
    ├── contract-file-io.mjs
    ├── schema-fixture-verification.mjs
    ├── wire-spec-verification.mjs
    ├── manifest-verification.mjs
    └── verify-contracts.mjs
```

- schema 파일은 안정적인 `$id`를 갖는다.
- 상대 경로 `$ref`는 repository 내부에서 해석 가능해야 한다.
- 외부 URL의 mutable schema를 build 중 자동으로 내려받지 않는다.
- fixture는 secret, 실제 고객 정보와 개발자의 로컬 절대 경로를 포함하지 않는다.
- 생성물 위치는 소비 package가 결정하지만 생성 원본은 `contracts`에만 둔다.
- 타입 생성기는 서버 skeleton을 추가할 때 도입하고, 생성 결과의 drift 검증도 같은 단계에서 CI에 연결한다.
- 공개 예시 host와 schema·error namespace는 `pielab.ai`만 사용한다.

## 표준과 고정 버전

| 경계                | 권위 형식                 | 고정 버전          |
| ------------------- | ------------------------- | ------------------ |
| Control Plane HTTP  | OpenAPI                   | 3.1.2              |
| 공통 payload        | JSON Schema               | 2020-12            |
| Realtime WebSocket  | AsyncAPI                  | 3.0.0              |
| 영속 event envelope | CloudEvents               | 1.0                |
| HTTP 오류           | Problem Details           | RFC 9457           |
| HTTP 수정 경쟁      | ETag·If-Match             | RFC 9110           |
| 분산 trace          | Trace Context             | W3C Recommendation |
| MCP                 | Model Context Protocol    | 2025-11-25         |
| OIDC native app     | Authorization Code + PKCE | RFC 8252·RFC 9700  |

OpenAPI에는 3.2가 존재하지만 첫 구현은 toolchain과 generator 호환 범위가 넓은 3.1.2로 고정한다.
변경은 문법 이점만으로 하지 않고 validator, generator와 Desktop compatibility fixture를 통과한 ADR로
진행한다. 공식 version 목록은 [OpenAPI Specification](https://spec.openapis.org/oas/)을 따른다.

AsyncAPI는 protocol-independent message contract와 WebSocket binding을 기술한다. 형식은
[AsyncAPI 3.0.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0)을 따른다.

## HTTP 계약

### OpenAPI 책임

OpenAPI는 다음 항목을 모두 포함한다.

- canonical path와 HTTP method
- path, query, header와 body schema
- 성공 response와 안정적인 error code
- OIDC security scheme과 요구 scope
- `Idempotency-Key`, `If-Match`, version과 trace header
- pagination, sorting과 filter 표현
- operation ID와 deprecated 시점

API base는 `/v1`이다. organization resource는 path에 명시하고 authenticated subject와 Membership을
서버에서 다시 대조한다.

### Runtime validation

- Fastify는 `contracts/schemas`의 같은 JSON Schema를 request와 response validation에 사용한다.
- schema는 build 시 compile하며 사용자 입력으로 runtime schema를 등록하지 않는다.
- validation 뒤 필요한 DB 조회와 authorization은 `preHandler` 또는 application service에서 수행한다.
- production response validation 정책은 성능 측정 후 정하더라도 CI contract test에서는 항상 검증한다.
- RFC 9457 변환 전에 내부 exception과 SQL 정보를 제거한다.

### Client generation

- Main용 TypeScript DTO와 API client type을 OpenAPI에서 생성한다.
- Renderer는 generated network client를 직접 사용하지 않고 좁은 preload view model을 사용한다.
- generated client는 refresh token, retry와 organization 선택을 임의로 구현하지 않는다. Main session
  broker가 이를 소유한다.
- code generator와 option은 lockfile과 generation manifest에 고정한다.
- 생성 후 작업 tree drift가 있으면 CI를 실패시킨다.

## Realtime 계약

AsyncAPI는 connection handshake, client command, server notification, heartbeat와 close reason을
기술한다.

```text
connect
-> authenticate profile and organization
-> negotiate protocol and capabilities
-> subscribe with last cursor
-> notification(resourceRef, version, eventCursor)
-> client REST delta or snapshot refresh
```

- durable 업무 생성과 수정은 Realtime message만으로 확정하지 않는다.
- notification payload는 resource 본문 전체보다 resource ID, version, change kind와 cursor를 기본으로 한다.
- typing과 presence는 ephemeral이며 history 복구 대상이 아니다.
- 권한·세션 폐기 event는 해당 connection과 cache를 즉시 무효화한다.
- buffer overflow, cursor expiry와 schema mismatch는 명시적 resync reason을 보낸다.
- raw transcript, PTY output, desktop frame과 media packet은 이 계약에서 금지한다.

## 영속 Event 계약

영속 event는 CloudEvents 1.0 의미와 호환되는 envelope를 사용한다.

- `source + id`는 organization 경계 안에서 deduplication key다.
- `type`은 namespace와 incompatible schema major를 포함한다.
- `time`, capture time과 server receive time을 구분한다.
- `correlationId`, `causationId`와 trace ID를 같은 식별자로 재사용하지 않는다.
- payload가 크면 object ID, hash와 size를 참조하고 presigned URL을 영구 저장하지 않는다.
- event schema가 unknown이면 process를 crash하지 않고 정책에 따라 quarantine한다.

Transactional outbox row와 external CloudEvent는 동일한 업무 사실을 표현할 수 있지만 database row
구조를 wire format으로 그대로 노출하지 않는다.

## IPC와 Runtime 계약

### Renderer와 Main

- command와 subscription은 domain별 namespace를 갖는다.
- 모든 request, response와 event를 JSON Schema로 검증한다.
- schema에는 sender identity를 넣어 신뢰하지 않고 Main이 호출 BrowserWindow에서 결정한다.
- 범용 `execute`, 임의 shell, 임의 URL fetch와 임의 file read 명령을 만들지 않는다.
- subscription은 unsubscribe와 window destruction 수명주기를 명시한다.

### Main과 Runtime

- Electron type을 포함하지 않는 local RPC envelope를 사용한다.
- request ID, protocol version, capability, deadline, cancel과 stream backpressure를 포함한다.
- file path는 wire에서 문자열일 수 있지만 실행 host가 native, WSL, SSH 또는 relay인지 함께 전달한다.
- Runtime reconnect 후 재개 가능한 operation과 반드시 실패시킬 operation을 구분한다.
- Git command capability는 host별 Git 2.25 baseline과 fallback 상태를 포함할 수 있다.

## MCP 계약

- local Pie MCP는 child-process `stdio`가 기본이다.
- tool input과 output schema는 `contracts/schemas/mcp`에 둔다.
- read tool과 side-effect tool을 구분하고 write에는 idempotency key와 expected version을 요구한다.
- LLM이 보낸 organization, user, permission과 project binding을 신뢰하지 않는다.
- Main Session Broker가 현재 session과 binding을 확인하고 scoped server command로 변환한다.
- remote MCP는 Streamable HTTP, HTTPS, Origin과 OAuth resource·audience 검증을 별도 profile로 요구한다.
- MCP 연결 종료를 이미 시작한 server operation의 취소로 간주하지 않는다.

## Discovery와 Capability 계약

`/.well-known/pie` schema는 `contracts/schemas/discovery`에서 관리한다.

- `schemaVersion`, `instanceId`, public endpoint, protocol, minimum client version과 expiry를 포함한다.
- endpoint 존재와 기능 사용 가능 여부를 capability로 구분한다.
- capability는 로그인 후 permission·entitlement 판정을 대체하지 않는다.
- unknown optional capability는 무시한다.
- 필수 protocol major 불일치, instance identity 변경과 non-loopback HTTP는 연결을 거부한다.

## Versioning 규칙

### 호환 변경

- optional response field 추가
- 새 endpoint 또는 새 event type 추가
- 기존 enum을 open enum으로 정의한 경우 unknown value 추가
- 새 optional capability 추가

호환 변경이라도 구버전 client fixture와 unknown field test를 통과해야 한다.

### 비호환 변경

- required field 추가
- field type, 단위 또는 의미 변경
- 기존 error code의 의미 변경
- event type의 기존 payload 의미 변경
- authorization 범위를 조용히 넓히는 변경
- identifier의 identity 또는 tenant scope 변경

비호환 변경은 새 endpoint version, schema major, message type 또는 protocol major를 사용한다. 기존 계약은
사용량, 지원 종료일과 client minimum version을 확인한 뒤 제거한다.

### 버전 축

다음 버전을 하나로 합치지 않는다.

| 버전              | 의미                               |
| ----------------- | ---------------------------------- |
| Product version   | Electron 또는 server release       |
| API version       | HTTP resource와 command 세대       |
| Schema version    | 개별 payload 의미                  |
| Protocol version  | Realtime, Runtime, Relay handshake |
| Parser version    | provider transcript 해석 구현      |
| Migration version | database 물리 구조                 |

## Database와 Contract

- OpenAPI DTO를 database row type으로 직접 사용하지 않는다.
- SQL migration이 table, RLS, FK와 index의 권위자다.
- persistence adapter가 API `camelCase`와 DB `snake_case`를 변환한다.
- migration 적용 DB에서 Kysely type을 생성하고 schema drift를 검사한다.
- API와 event schema 변경이 expand-contract migration 순서와 호환되는지 release test를 실행한다.
- Keycloak schema는 Keycloak release가 소유하며 Pie migration에 포함하지 않는다.

## Contract CI

모든 contract 변경 PR은 다음 gate를 통과한다.

1. OpenAPI, AsyncAPI와 JSON Schema syntax lint
2. `$id`, `$ref`, operation ID와 error code 중복 검사
3. valid fixture accept와 invalid fixture reject
4. server request·response validator contract test
5. generated type·client drift 검사
6. current, minimum supported와 previous fixture compatibility test
7. unknown optional field와 unknown event type test
8. authorization allow·deny와 cross-tenant negative test
9. sensitive field, token, local path와 presigned query leak 검사
10. API·migration expand-contract upgrade test

문서 링크나 예제만 바꾼 PR도 executable fixture 의미와 충돌하지 않는지 확인한다.

R0에서는 `pnpm check:contracts`를 root lint에 연결했다. 이 검증은 schema strict compile, 모든 fixture의
index·validity, 로컬 경로·token·presigned query 누출, OpenAPI mutation header와 오류 응답, AsyncAPI
필수 message, permission·role·entitlement 참조, MCP write 안전 조건, P0 위협 gate와 support matrix를
검사한다. server validator와 generated client drift는 소비 코드가 생기는 R2부터 같은 명령에 추가한다.

## R0 지원 기준선

지원 조합의 권위는 `contracts/manifests/support-matrix.json`이다. Electron 43 기준 최소 제품 범위는
macOS 12 arm64/x64, Windows 10 x64, Ubuntu 22.04 x64의 X11·Wayland다. Electron 43 이후 macOS 최소
버전과 Linux build 기준은
[Electron 43.1.1 platform support](https://github.com/electron/electron/tree/v43.1.1#platform-support)를
따른다.

Git 회귀선은 2.25.0, 2.39.0과 2026-07-15 기준 current stable 2.55.0으로 고정한다. current stable 근거는
[Git 공식 release](https://git-scm.com/)다. provider 수집기는 R0 개발 환경에서 확인한 Claude Code
2.1.206과 Codex CLI 0.144.1을 첫 fixture 기준으로 삼되, 해당 버전만 허용하는 의미는 아니다. 각 parser는
known, unknown additive, breaking fixture를 R5 gate에서 함께 검증한다.

## 변경 Review 항목

contract 변경 설명에는 다음을 기록한다.

- 변경한 resource, command, event와 permission
- 영향을 받는 Desktop, Main, Runtime, API, Worker, Relay와 Edge Agent
- 최소 지원 version과 rollout 순서
- offline outbox와 retry 중인 operation 처리
- 기존 데이터와 migration 필요 여부
- tenant, classification, audit와 retention 영향
- downgrade와 rollback 가능 여부
- compatibility fixture와 관측 지표

## 첫 작성 순서

1. 공통 ID, timestamp, pagination, Problem Details와 request header schema
2. `/.well-known/pie` discovery와 protocol support manifest
3. session state, organization, membership와 permission response
4. Project, Team, WorkItem CRUD와 ETag·idempotency
5. Realtime handshake, resource changed, session revoked와 resync
6. Runtime handshake와 Renderer session IPC
7. Agent event envelope, batch ingest와 object upload intent
8. MCP의 project/work-item read·write tool
9. RemoteSession control과 Relay handshake
10. Meeting control과 LiveKit token request

## 완료 기준

- schema 한 곳의 변경으로 server validator와 Main type을 재생성할 수 있다.
- Renderer가 network DTO와 token을 직접 소유하지 않는다.
- current와 최소 지원 client가 같은 compatibility suite를 통과한다.
- malformed, unknown, duplicate, reordered와 unauthorized payload의 실패 의미가 고정된다.
- OpenAPI, AsyncAPI, database migration과 문서 사이 drift가 CI에서 탐지된다.
- SaaS와 Self-hosted 구현이 같은 contract fixture를 사용한다.
