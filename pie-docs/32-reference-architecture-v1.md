# Reference Architecture v1

## 문서 상태

- 상태: 기준
- 버전: 1.0
- 기준일: 2026-07-15
- 범위: Pie Electron, Runtime, Control Plane, Data Plane, Self-hosted 배포

이 문서는 Pie의 첫 운영 가능한 구조를 고정한다. 기능별 문서는 이 구조 안에서 구현하며, process
경계, 권위 저장소, 인증 책임 또는 wire contract 권위를 바꾸려면 새 ADR이 필요하다.

관련 결정은 [`ADR-0008`](../docs/adr/0008-control-plane-modular-monolith.md),
[`ADR-0009`](../docs/adr/0009-identity-provider-and-application-authorization.md),
[`ADR-0010`](../docs/adr/0010-contract-first-wire-specifications.md),
[`ADR-0011`](../docs/adr/0011-self-hosted-platform-dependencies.md)을 따른다.

## 아키텍처 목표

- 기존 Orca의 Git, Worktree, PTY, SSH, LLM과 로컬 파일 기능을 보존한다.
- 프로젝트·업무·고객·티켓·대화·AI 기록의 중앙 권위와 로컬 실행을 분리한다.
- 하나의 Electron binary가 SaaS, Local Docker와 On-prem instance에 연결된다.
- Core 프로젝트 관리가 Relay, Media 또는 전용 Search 장애에 종속되지 않게 한다.
- 초기 운영 복잡도를 제한하되 process와 contract 경계는 향후 수평 확장할 수 있게 한다.
- macOS, Windows, Linux와 native, WSL, SSH, Relay host를 동일한 실행 문맥으로 다룬다.

## 핵심 불변식

1. Renderer는 token, DB credential, Object Storage credential과 임의 Node 권한을 갖지 않는다.
2. 사용자 업무 데이터의 권위자는 Control Plane과 PostgreSQL이다.
3. 로컬 Runtime은 실행과 수집을 담당하지만 조직 권한이나 중앙 업무 상태를 최종 확정하지 않는다.
4. 인증은 OIDC Identity Provider가, 조직·Membership·RBAC는 Pie Control Plane이 담당한다.
5. 업무 명령, Realtime, Relay, Media와 Object transfer는 서로 다른 트래픽 등급으로 분리한다.
6. 대형 원문과 binary는 Object Storage에, 관계·권한·감사 metadata는 PostgreSQL에 둔다.
7. 모든 tenant resource는 `organization_id`와 server-side authorization을 통과한다.
8. capability는 기능 존재를 알릴 뿐 permission이나 entitlement를 대신하지 않는다.
9. Realtime event는 복구의 권위자가 아니다. REST snapshot 또는 delta로 항상 재동기화할 수 있다.
10. SaaS와 Self-hosted는 같은 API, event, auth adapter와 Object Storage contract test를 통과한다.

## 전체 구성

```text
Pie Electron
├── Renderer
├── Preload Contract
├── Electron Main
└── Pie Runtime
    ├── Local execution
    ├── AI collector and MCP
    └── SQLite cache and outbox
             |
             | HTTPS / WSS / scoped data streams
             v
Public Gateway
├── Instance discovery
├── Auth utility routing
├── Control Plane API
├── Realtime Gateway
├── Object transfer public endpoint
├── Relay public endpoint
└── Media public endpoint
             |
             v
Pie Platform
├── Control Plane API process
├── Worker process
├── Relay service
└── Edge Agent control
             |
             v
Platform Dependencies
├── Keycloak or compatible OIDC provider
├── PostgreSQL
├── S3-compatible Object Storage
├── LiveKit SFU when meeting profile is enabled
└── OpenTelemetry backend or collector
```

## Desktop Plane

### Renderer

- React 기반 Portal, Workspace, CRM, Service Desk, Chat와 설정 UI를 제공한다.
- Main이 제공한 session state, permission과 capability만 사용한다.
- Control Plane access token이나 refresh token을 읽지 않는다.
- local file, PTY, SSH와 remote command를 범용 API로 호출하지 않는다.

### Electron Main

- instance discovery, OIDC PKCE, token lifecycle과 OS key store를 소유한다.
- Renderer sender와 IPC payload를 검증한다.
- Control Plane, Realtime, Runtime과 Relay 연결을 중개한다.
- Runtime이나 Relay에 사용자 token 대신 대상과 수명이 제한된 capability를 전달한다.
- organization 또는 instance 전환 시 이전 구독, cache와 pending privileged request를 종료한다.

### Pie Runtime

- Git, Worktree, PTY, SSH, WSL, 파일, LLM process와 transcript observer를 소유한다.
- Main과 local socket 또는 OS pipe 기반의 typed contract로 통신한다.
- SQLite single-writer가 cache, capture cursor와 outbox를 관리한다.
- native, WSL, SSH와 relay connection마다 `ExecutionContext`를 분리한다.
- 자동 수집은 Hook·transcript reconciler·observer가 담당하고 MCP는 명시적 업무 도구로 유지한다.

기존 `src/relay`는 Runtime이 원격 host에서 실행 기능을 제공하는 adapter다. 중앙 public Relay
service와 이름이 같더라도 배포 책임은 다르며 wire contract 없이 직접 import하지 않는다.

## Control Plane

### 배포 형태

Control Plane은 TypeScript 모듈형 모놀리스로 구현하고 두 process entrypoint로 시작한다.

```text
Control Plane API process
├── discovery and compatibility
├── identity adapter and session mapping
├── authorization policy
├── delivery and project
├── CRM and contract
├── service desk and support control
├── collaboration and meeting control
├── agent ingest and artifact metadata
├── integration
├── audit
└── realtime publisher

Worker process
├── transactional outbox claim
├── projection and notification
├── webhook and integration delivery
├── object scan and finalize
├── retention and deletion
└── report materialization
```

- API와 Worker는 같은 domain·contract package를 사용할 수 있지만 별도 process와 DB credential을 가진다.
- HTTP framework는 Node.js 24와 Fastify 5를 사용한다.
- API module은 Fastify plugin 경계와 domain module 경계를 일치시킨다.
- module은 다른 module의 table을 임의로 갱신하지 않고 application service 또는 명시적 port를 사용한다.
- 초기에는 서비스별 database, message broker, distributed transaction을 도입하지 않는다.

Fastify는 JSON Schema validation과 plugin encapsulation을 제공한다. 세부 API는
[Fastify 공식 문서](https://fastify.dev/docs/latest/Reference/)를 기준으로 한다.

### 논리 모듈

| 모듈 | 소유 책임 | PostgreSQL schema |
|---|---|---|
| Identity Adapter | issuer·subject mapping, Pie session, device | `identity` |
| Authorization | Membership, Role, Permission, Grant | `identity` |
| Delivery | Team, Initiative, Project, WorkItem, Cycle | `delivery` |
| CRM | Customer, Contact, Opportunity, Quote, Contract | `crm` |
| Service | Ticket, SLA, Asset, RemoteSession control | `service` |
| Collaboration | Channel, Message, Meeting metadata | `collaboration` |
| Agent | AgentSession, Run, Turn, Artifact metadata | `agent` |
| Integration | Connection, ExternalReference, Webhook | `integration` |
| Operations | Idempotency, Outbox, Operation, Projection | `operations` |
| Audit | AuditEvent, access evidence, tombstone | `audit` |

모듈은 논리 경계이며 초기 network service 경계가 아니다. 독립 배포는 부하, 장애 격리, 팀 소유권과
transaction 손실을 측정한 뒤 새 ADR로 결정한다.

## Identity와 Authorization

### Identity Provider

- 기본 Identity Provider는 Keycloak이다.
- Electron은 시스템 브라우저에서 Authorization Code + PKCE로 로그인한다.
- 하나의 Pie instance는 기본적으로 하나의 realm을 사용하며 organization마다 realm을 만들지 않는다.
- Keycloak은 이메일·비밀번호, 이메일 확인, MFA, Passkey와 외부 OIDC·SAML broker를 담당한다.
- Keycloak 관리자 role과 Pie 업무 role을 서로 매핑해 권한 근거로 사용하지 않는다.

Keycloak은 공식 container image와 OIDC·WebAuthn 기능을 제공한다. 배포와 기능 기준은
[Keycloak container 문서](https://www.keycloak.org/server/containers)와
[Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html)를 따른다.

### Pie 계정 매핑

```text
OIDC issuer + subject
        |
        v
identity.user_accounts
        |
        v
Membership -> Role -> Permission -> ResourceGrant
```

- email은 연락·초대 속성이며 영구 identity key가 아니다.
- 최초 로그인 또는 초대 수락 때 issuer·subject를 Pie account에 연결한다.
- 조직 생성, 초대, Membership, 역할과 리소스 권한은 Pie transaction으로 처리한다.
- IdP token의 일반 group·role claim만으로 tenant resource 접근을 허용하지 않는다.
- Control Plane은 token signature, issuer, audience, expiry와 session 상태를 검증한 뒤 Pie authorization을
  별도로 실행한다.

Self-hosted에서는 같은 PostgreSQL cluster를 사용할 수 있지만 Keycloak은 별도 database와 credential을
사용한다. Pie domain code가 Keycloak table을 query하거나 migration하지 않는다.

## Data Plane

### Realtime

- durable command는 HTTPS API로 저장한 뒤 transaction outbox에서 publish한다.
- WebSocket은 resource 변경, 권한·세션 폐기, typing, presence와 resync 지시를 전달한다.
- 채팅 메시지 생성·수정·삭제는 HTTP command와 PostgreSQL commit이 권위자다.
- reconnect 시 cursor가 유효하면 delta를, 아니면 snapshot과 새 cursor를 받는다.
- raw transcript, terminal output, desktop frame과 media packet을 Realtime에 싣지 않는다.

초기 Realtime Gateway는 API와 같은 codebase의 별도 module로 구현한다. 독립 process는 connection 수와
failure isolation 기준을 넘을 때 활성화할 수 있도록 AsyncAPI contract를 먼저 분리한다.

### Relay

- Control Plane은 RemoteSession, participant, consent, capability, invite와 audit를 소유한다.
- Relay는 control connection과 encrypted data stream을 전달하고 업무 source of truth가 되지 않는다.
- terminal·desktop·file stream은 일반 Realtime과 분리한다.
- host와 participant는 단기 audience 제한 token과 device/host proof를 사용한다.
- Relay가 payload를 해석하지 않아도 frame size, rate, stream ownership과 backpressure를 강제한다.

`cli-relay`의 room, participant, driver와 reconnect 개념은 참고하되 현재의 shared HS256 secret,
`sub`만을 이용한 pairing, query token과 영속 감사 부재를 production contract로 채택하지 않는다.
Orca의 host proof와 E2EE relay 구현을 우선 근거로 삼고 compatibility fixture를 통해 필요한 기능만
이관한다.

### Media

- 회의의 room, participant permission, 녹화 동의와 업무 문맥은 Control Plane이 소유한다.
- audio, video와 screen share는 LiveKit SFU가 처리한다.
- Control Plane은 room과 participant가 제한된 짧은 LiveKit token을 발급한다.
- 녹화 object와 transcript는 Object Storage와 Pie metadata에 귀속한다.
- Media profile이 꺼져 있으면 meeting capability만 비활성화하고 Core API는 정상 동작한다.

LiveKit은 Apache 2.0 server와 Self-hosted 배포를 제공한다. 운영 기준은
[LiveKit Self-hosting](https://docs.livekit.io/transport/self-hosting/)을 따른다.

원격 데스크톱 화면 전송 엔진은 Media SFU와 동일시하지 않는다. 플랫폼 권한, 입력 주입, 재부팅과
unattended access를 별도 sidecar contract로 감싸고 엔진 선택은 prototype과 라이선스 검토 후 결정한다.

## 저장소

### PostgreSQL

- Pie 중앙 권위 저장소는 PostgreSQL 16+의 단일 database다.
- 고정 schema, `organization_id` 복합 FK, RLS와 application authorization을 함께 사용한다.
- Kysely와 `pg`, SQL 중심 frozen migration을 사용한다.
- API transaction은 aggregate, audit와 outbox를 함께 commit한다.
- Keycloak database는 같은 cluster에 둘 수 있지만 Pie database와 lifecycle을 공유하지 않는다.

### Object Storage

- domain은 S3-compatible adapter만 의존한다.
- Local Docker 기본 구현은 SeaweedFS다.
- SaaS는 AWS S3 또는 contract를 통과한 호환 storage를 사용할 수 있다.
- 기존 MinIO 설치는 호환 대상이지만 신규 기본 배포로 제공하지 않는다.
- client는 root credential 없이 upload intent와 짧은 presigned URL을 사용한다.

MinIO community repository는 2026-04-25 archived 되었으므로 신규 기본값에서 제외한다
([MinIO repository](https://github.com/minio/minio)). SeaweedFS는 Apache 2.0과 S3 Docker 실행을
제공한다([SeaweedFS repository](https://github.com/seaweedfs/seaweedfs)).

### Queue와 Search

- 업무 queue는 PostgreSQL outbox와 lease 기반 operation table로 시작한다.
- Redis, Kafka, NATS와 RabbitMQ는 Core 의존성으로 사용하지 않는다.
- LiveKit 같은 외부 subsystem이 자체 scale-out용 Redis를 요구할 수 있으나 Pie 업무 queue와 분리한다.
- 초기 검색은 PostgreSQL full-text와 필요한 제한적 trigram index를 사용한다.
- 전용 search engine은 권한 회수 지연, corpus 크기와 query SLO를 측정한 뒤 adapter 뒤에 추가한다.

## 배포 프로필

| profile | 필수 구성 | 제공 기능 |
|---|---|---|
| `core` | Gateway, Keycloak, API, Worker, PostgreSQL, SeaweedFS | 인증, Portal, Project, CRM, Ticket, AI metadata, Artifact |
| `support` | `core` + Relay | 원격 터미널, 원격지원 session, file stream |
| `meeting` | `core` + LiveKit·TURN, 필요 시 media 전용 Redis | 음성·영상·화면 공유 |
| `observability` | OpenTelemetry Collector와 선택한 backend | 중앙 trace, metric, log |

- Local Docker 기본 설치는 `core`다.
- `support`, `meeting`, `observability`는 Compose profile로 선택한다.
- SaaS는 같은 image와 configuration schema를 사용하되 process를 독립 scale할 수 있다.
- image tag와 digest를 고정하며 production manifest에 `latest`를 사용하지 않는다.
- Core readiness는 optional profile 장애 때문에 실패하지 않는다.

상세 public/internal URL과 Desktop connection은
[SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md)을 따른다.

## 트래픽과 복구 권위

| 트래픽 | transport | 권위 | 복구 |
|---|---|---|---|
| 업무 조회·명령 | HTTPS REST | PostgreSQL transaction | ETag, idempotency, snapshot/delta |
| 변경 통지·presence | WSS Realtime | REST resource와 outbox | cursor 또는 snapshot 재조회 |
| AI 수집 | HTTPS batch + Object upload | ingest record와 object metadata | local SQLite outbox 재전송 |
| MCP 명령 | local `stdio`, remote Streamable HTTP | 해당 Control Plane command | idempotency와 operation 조회 |
| Terminal·Desktop | Relay encrypted stream | RemoteSession control state | 재승인·새 capability로 reconnect |
| Audio·Video | LiveKit WebRTC | Meeting control metadata | room 재참여와 새 media token |
| 대용량 object | HTTPS presigned transfer | PostgreSQL object state | multipart resume·finalize·sweeper |

## Repository 경계

현재 Electron package와 lockfile을 한 번에 재구성하지 않고 다음 경계를 사용한다.

```text
contracts/                       # 언어 독립 wire specification과 fixture
platform/
├── pnpm-workspace.yaml
├── apps/
│   ├── control-plane-api/
│   └── control-plane-worker/
└── packages/
    ├── application/
    ├── domain/
    ├── persistence/
    ├── identity-adapter/
    ├── object-storage-adapter/
    └── observability/
services/
├── relay/                       # public Relay service, Go 후보
└── edge-agent/                  # 장비 sidecar, Go 후보
deploy/
└── compose/                     # core/support/meeting/observability profile
src/                             # 기존 Electron, Runtime과 local relay execution
```

- `contracts`는 특정 package manager에 종속되지 않는다.
- `platform`은 독립 pnpm workspace와 lockfile을 사용해 Desktop native dependency를 오염시키지 않는다.
- generated client는 생성 명령으로 재현하며 원본 schema와 drift test를 함께 관리한다.
- Relay·Edge Agent 언어는 wire contract와 threat test를 통과하는 범위에서 Go를 우선 검토한다.

## 비기능 기준

### Availability

- Core API, Realtime, Relay, Media와 Object transfer health를 분리한다.
- Worker 중단 중에도 read와 동기 command는 가능한 범위에서 유지하고 outbox backlog를 표시한다.
- optional profile 장애를 capability degraded 상태로 표현한다.

### Security

- non-loopback은 HTTPS·WSS만 허용한다.
- secret은 image, discovery, Renderer와 진단 bundle에 포함하지 않는다.
- privileged 명령은 온라인 permission, target, consent, expiry와 nonce를 검증한다.
- audit는 허용과 거부의 근거를 남기되 secret과 원문 전체를 기본 기록하지 않는다.

### Compatibility

- protocol version과 제품 version을 분리한다.
- additive field는 minor 호환으로 처리하고 unknown optional field를 무시한다.
- 필수 의미 변경은 새 endpoint, message type 또는 protocol major를 만든다.
- server는 최소 Desktop·Runtime·Relay·Edge Agent version과 capability를 discovery에 게시한다.

### Observability

- W3C `traceparent`를 Main, API, DB, outbox와 Worker까지 전달한다.
- OpenTelemetry는 운영 signal만 자동 export하며 prompt, transcript와 terminal 원문은 별도 동의 없이
  telemetry로 보내지 않는다.
- tenant와 actor label은 고카디널리티 metric에 직접 넣지 않는다.

## 아직 고정하지 않는 구현

다음은 Architecture v1 경계를 바꾸지 않으므로 검증 시점까지 adapter 뒤에 둔다.

- production reverse proxy 제품
- SMTP와 transactional email 공급자
- cloud KMS와 Self-hosted secret manager
- 원격 데스크톱 capture·input sidecar 엔진
- 전용 Search engine
- 별도 message broker와 policy engine
- Kubernetes와 multi-region active-active topology

## Architecture v1 완료 기준

- Desktop, API, Worker, Relay, Media와 저장소의 권위·실패 경계가 contract에 반영된다.
- Keycloak subject와 Pie Membership·RBAC가 분리되어 있다.
- `core` profile만으로 인증과 Project·WorkItem 수직 흐름이 동작한다.
- optional Relay·Media 장애가 Core readiness를 실패시키지 않는다.
- SaaS, SeaweedFS Local Docker와 외부 S3 fixture가 같은 Object Storage contract를 통과한다.
- API·Realtime·event·IPC·Runtime·MCP schema가 CI에서 구현과 함께 검증된다.
- 서비스 분리나 provider 교체가 domain ID, permission과 wire contract를 바꾸지 않는다.
