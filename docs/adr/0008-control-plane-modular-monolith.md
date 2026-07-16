# ADR-0008: Control Plane 모듈형 모놀리스와 process 경계

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture
- 관련 문서: `pie-docs/12-electron-system-architecture.md`,
  `pie-docs/32-reference-architecture-v1.md`

## 맥락

Pie는 인증, 조직, Project, WorkItem, CRM, Ticket, Chat, AI ingest, Artifact와 Audit를 서로 연결해야
한다. 초기 수직 흐름은 여러 bounded context를 하나의 transaction과 outbox로 묶어야 하며 개발·운영
인력은 제한적이다.

반면 기존 Electron Main에 중앙 업무 기능을 계속 추가하면 desktop release와 server lifecycle이
결합되고, 처음부터 서비스별 network API와 database를 만들면 distributed transaction, 배포, 추적과
on-prem 운영 비용이 제품 검증보다 먼저 증가한다.

## 결정

1. Control Plane은 Node.js 24와 TypeScript 기반의 모듈형 모놀리스로 시작한다.
2. HTTP framework는 Fastify 5를 사용한다.
3. 첫 배포 entrypoint는 `control-plane-api`와 `control-plane-worker` 두 process다.
4. API와 Worker는 domain·application·contract package를 공유할 수 있지만 별도 process, health와 DB
   credential을 가진다.
5. bounded context는 Identity Adapter, Authorization, Delivery, CRM, Service, Collaboration, Agent,
   Integration, Operations와 Audit module로 나눈다.
6. HTTP route module은 Fastify plugin encapsulation과 domain module ownership을 일치시킨다.
7. module은 다른 module table을 전역 DB handle로 임의 갱신하지 않는다. 명시적 application service,
   port 또는 같은 transaction에 참여하는 orchestration을 사용한다.
8. Realtime은 처음에는 같은 codebase의 독립 module로 구현한다. WebSocket connection 수, 배포 주기와
   장애 격리 기준을 넘으면 동일 AsyncAPI contract로 별도 process를 실행할 수 있게 한다.
9. Relay, Edge Agent와 Media SFU는 latency·보안·protocol lifecycle이 달라 Control Plane process에
   포함하지 않는다.
10. 초기에는 서비스별 database, 별도 message broker와 distributed transaction을 사용하지 않는다.
11. server 코드는 기존 Desktop package에 섞지 않고 독립 `platform` pnpm workspace와 lockfile을
    사용한다. 언어 독립 wire schema는 repository root의 `contracts`가 소유한다.
12. 서비스 분리는 부하, failure domain, 독립 배포와 팀 소유권을 측정한 뒤 새 ADR로 진행한다.

Fastify는 plugin encapsulation과 JSON Schema 기반 validation·serialization을 제공한다. 구현은
[Fastify Reference](https://fastify.dev/docs/latest/Reference/)를 기준으로 한다.

## Process topology

```text
Gateway
├── Control Plane API
│   ├── HTTP modules
│   └── Realtime module
└── Worker
    ├── outbox consumer
    ├── projection
    ├── notification/webhook
    └── retention/object workflow

Separate data plane
├── Relay
├── Edge Agent
└── LiveKit
```

API는 request transaction에서 aggregate, audit와 outbox를 commit한다. Worker는 queue-like table만
`FOR UPDATE SKIP LOCKED`로 claim하고 실제 tenant mutation은 해당 organization transaction에서
처리한다.

## 검토한 대안

### 처음부터 microservice로 분리

Project, WorkItem, Artifact와 Agent ingest 수직 흐름에 network failure와 distributed consistency를
추가한다. 서비스별 독립 scale 근거가 없으므로 선택하지 않는다.

### Electron Main을 Control Plane으로 사용

multi-user 권위, on-prem server, background Worker와 중앙 audit를 desktop lifecycle에 결합하므로
선택하지 않는다.

### NestJS

유효한 선택이지만 Pie는 decorator 중심 application framework보다 명시적 module, JSON Schema와 얇은
HTTP adapter가 우선이다. Fastify plugin과 application service를 직접 구성하기로 한다.

### 모든 process를 하나로 실행

긴 object scan, webhook와 retention이 request latency와 shutdown을 방해하므로 API와 Worker는 처음부터
분리한다.

## 결과와 제약

- module ownership과 cross-module dependency rule을 lint 또는 architecture test로 강제해야 한다.
- API와 Worker가 공유 code를 사용하더라도 startup, migration과 graceful shutdown을 독립 검증해야 한다.
- 단일 database의 connection budget과 migration compatibility가 모든 module에 영향을 준다.
- 별도 Realtime process를 켜기 전에도 connection state를 API memory의 업무 권위로 사용하지 않아야 한다.
- `platform` workspace와 Desktop 사이에는 TypeScript source import가 아니라 versioned contract와 생성물을
  사용해야 한다.

## 검증

- module dependency cycle과 다른 module repository 직접 import 차단 test
- Fastify request/response schema와 OpenAPI contract test
- API 종료 중 새 request 거부, in-flight drain과 DB rollback test
- Worker lease, duplicate claim, crash와 retry test
- aggregate·audit·outbox atomicity test
- Realtime module 중단 중 REST snapshot 복구 test
- API와 Worker의 별도 DB role·health·metric test
- Desktop package와 platform lockfile의 dependency isolation test
