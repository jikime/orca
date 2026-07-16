# Electron 시스템 아키텍처

## 목표

별도 웹 프론트엔드 없이 단일 Electron 앱을 제공하되, 로컬 권한 작업과 중앙 협업 서비스를
명확히 분리한다. 긴 실행과 스트리밍이 UI를 막지 않도록 프로세스 책임을 나눈다.

## 전체 구성

```text
Pie Electron App
├── Renderer
│   ├── 운영·프로젝트·서비스 UI
│   ├── 개발 Workspace
│   ├── 고객 제한 모드
│   └── 게스트 지원 모드
├── Preload Contract
├── Electron Main
│   ├── 창·메뉴·알림·업데이트
│   ├── 인증·보안 저장소
│   ├── 파일 선택·클립보드·OS 통합
│   └── Runtime 라우팅과 권한 검사
├── Pie Runtime
│   ├── Git·Worktree·파일시스템
│   ├── PTY·SSH·WSL
│   ├── AI 에이전트
│   ├── Agent Hook·Transcript Reconciler
│   ├── 브라우저·Design Mode
│   └── 로컬 캐시·Event Outbox·작업 큐
└── Bundled Sidecars
    ├── Edge Agent
    ├── Relay Client
    └── Remote Desktop Engine

Central Services
├── Keycloak and Public Auth Utility Pages
├── Fastify Control Plane API
│   ├── Identity Adapter and Pie Session Service
│   ├── Authorization Policy Service
│   └── Agent Event Ingest Service
├── Job Workers and Event Delivery
├── PostgreSQL and S3-compatible Object Storage
├── Realtime Gateway
├── Terminal/Desktop Relay when Support is enabled
├── LiveKit Media SFU when Meeting is enabled
└── Observability Backend
```

별도 웹 프론트엔드는 없지만 중앙 서비스는 필요하다. 여러 사용자의 데이터 동기화, 고객 초대,
채팅, 권한, 감사, 녹화, 원격지원은 한 장비의 로컬 SQLite만으로 제공할 수 없다.

## Renderer

- React 기반 화면과 상태 표현
- 역할별 내비게이션
- 목록, 보드, 간트, 편집기, 터미널, 원격 화면
- 사용자 입력의 1차 유효성 검사
- 서버와 Runtime의 결과 표시
- 비밀·파일시스템·임의 프로세스에 직접 접근하지 않음

고객 모드와 내부 모드는 동일한 번들을 사용한다. 권한 없는 모듈은 lazy load하지 않을 수 있지만
보안은 번들 분리가 아니라 IPC와 서버 검증에 의존한다.

## Preload Contract

- Renderer와 privileged 계층 사이의 타입 계약
- 도메인별 API 네임스페이스
- 요청·응답 스키마 검증
- 이벤트 구독의 명시적 해제
- 스트리밍 backpressure와 재동기화 계약
- 호출자 창과 세션 문맥 전달

하나의 무제한 `execute` 또는 범용 셸 API를 노출하지 않는다. 파일, Git, 터미널, 원격지원,
관리 기능을 각각의 좁은 명령으로 제공한다.

## Electron Main

- 앱 생명주기와 단일 인스턴스
- 메뉴, 트레이, 알림, 딥링크
- 자동 업데이트
- 인증 API 클라이언트와 토큰 갱신
- OS 보안 저장소
- 창과 내장 브라우저 보안 정책
- Renderer sender 검증
- Runtime 연결과 상태 관리
- 파일 선택, 외부 URL, 클립보드 같은 OS 기능

업무 규칙과 긴 작업을 Main에 계속 추가하지 않는다. 장기 실행은 Runtime이나 서버 작업으로
보내고 Main은 권한과 수명주기를 조정한다.

## Pie Runtime

기존 메인 프로세스의 개발 실행 기능을 점진적으로 Runtime 서비스 경계로 이동한다.

- 로컬 소켓 기반 요청·응답
- 호스트별 실행 문맥: native, WSL, SSH, relay
- Git 2.25 호환 계층
- PTY 세션 생명주기
- 파일 감시와 편집
- 에이전트 프로세스와 Hook
- provider transcript reconciliation과 parser capability
- ExecutionContext와 SessionBinding
- Agent event 정규화와 SQLite outbox
- 브라우저 자동화
- 재시작 후 세션 복구

Main과 Runtime 사이의 계약은 Electron 타입을 포함하지 않는다. 향후 헤드리스 실행과 테스트가
같은 계약을 사용할 수 있어야 한다.

## AI 수집과 MCP 경계

```text
Hook + Transcript + Runtime/Git/Test Observer
  -> Runtime Event Normalizer
  -> Local SQLite Outbox
  -> Control Plane Ingest API
  -> PostgreSQL Metadata + Object Storage + Search Projection

LLM Client <-> Local Pie MCP <-> Main Session Broker <-> Project API
```

- Hook은 실시간 상태를 제공하고 transcript reconciler는 누락된 turn과 최종 원문을 보완한다.
- MCP는 프로젝트·업무 조회와 변경을 위한 명시적 도구이며 자동 telemetry의 유일한 경로가 아니다.
- Local MCP는 기본적으로 child-process `stdio`를 사용하고 사용자 token을 agent process에 전달하지
  않는다.
- remote MCP가 필요하면 Streamable HTTP, Origin 검증, OAuth resource·audience 검증과 protocol
  capability negotiation을 적용한다.
- Realtime Gateway는 projection 변경 통지에 사용하고 raw transcript와 terminal output을 보내지
  않는다.
- Relay는 원격 command·PTY stream을 담당하고 일반 업무 event ingest와 분리한다.

수집 이벤트의 영구 식별자, visibility와 저장 계약은
[AI 작업 프로젝트 포털](./19-ai-project-portal.md)을 따른다.

## 로컬 저장소

- SQLite 캐시와 오프라인 큐
- 사용자 UI 설정
- 최근 열기와 Workspace 세션
- 다운로드한 문서 메타데이터
- 서버 데이터의 제한된 캐시
- 동기화 체크포인트
- Agent event outbox와 provider transcript cursor
- outbox byte quota, capture pause와 permanent rejection 상태

SQLite WAL을 사용할 때는 Runtime이 single writer와 짧은 transaction을 소유하고 DB, `-wal`, `-shm`을
하나의 상태로 백업한다. packaged Electron과 Runtime의 `process.versions.sqlite`가 WAL 동시성 수정
버전인지 시작·CI에서 확인하며, 확인 전에는 다중 connection write와 동시 checkpoint를 허용하지
않는다. 세부 상태와 복구 계약은 [API·이벤트·동기화 계약](./23-api-event-sync-contracts.md), 버전 기준은
[아키텍처 결정과 기술 기준](./22-architecture-decisions-and-technology.md), DB 파일 분리와 물리 table은
[데이터베이스 물리 설계](./30-database-physical-design.md)를 따른다.

서버가 권위자인 고객·계약·프로젝트·티켓 데이터를 로컬 파일만으로 확정하지 않는다. 충돌은
엔터티 버전과 서버 이벤트 순서로 해결한다.

## 중앙 Control Plane

- 조직·사용자·초대·인증수단
- 로그인 세션과 기기, 토큰 회전·폐기
- 역할·permission·리소스 grant와 정책 판정
- 제품 entitlement와 사용량
- 고객·계약·프로젝트·티켓
- WorkItem, Workflow, SessionBinding, AgentSession·Run·Turn과 Artifact metadata
- agent event ingest, projection checkpoint와 capture policy
- 자산 메타데이터
- 메시지와 회의 메타데이터
- 원격 세션과 초대
- 감사 이벤트
- 작업·자동화 큐
- 보고용 기준 데이터

Keycloak은 identity 인증과 credential의 권위자이고 Control Plane은 issuer·subject account mapping,
조직 Membership과 업무 인가의 권위자다. 조직과 역할 정보는 Electron의 로컬 캐시에만 의존하지
않으며 역할·grant·세션 폐기 이벤트를 Realtime Gateway로 배포한다.

공개 인증 페이지, 백그라운드 작업, 검색, 관측, 백업·복구의 세부 기준은
[데스크톱 배포와 수명주기](./16-desktop-lifecycle.md),
[Control Plane 운영](./17-control-plane-operations.md),
[데이터 거버넌스와 연동](./18-data-governance-integrations.md)을 따른다.

## 네이티브 앱 인증

- 이메일·비밀번호, Passkey와 외부 SSO는 시스템 브라우저의 Keycloak OIDC 흐름에서 처리한다.
- Renderer, Main과 Control Plane은 사용자 비밀번호를 저장하거나 직접 검증하지 않는다.
- access token은 Main 메모리에 두고 Renderer에는 원본 토큰을 노출하지 않는다.
- refresh token은 Main이 회전시키고 OS 보안 저장소에 보관한다.
- OIDC는 시스템 브라우저와 Authorization Code + PKCE를 사용한다.
- loopback 또는 `pie://auth/callback`은 Main이 `state`와 `nonce`를 검증한 뒤 처리한다.
- Runtime과 Relay에는 사용자 토큰 대신 대상과 작업이 제한된 단기 capability token을 전달한다.

Linux에서 시스템 키링을 사용할 수 없으면 영속 로그인을 제한한다. 오프라인 캐시는 권한이 확인된
비민감 읽기만 제공하고 원격조작, 승인, 권한 변경에는 온라인 검증을 요구한다.

## Instance discovery와 연결 프로필

- SaaS, Local Docker와 On-prem은 같은 Electron binary와 API contract를 사용한다.
- 사용자는 Control Plane bootstrap URL 하나만 입력한다.
- Main이 `/.well-known/pie`를 조회해 API, Auth, Realtime, Relay, Media와 capability를 발견한다.
- PostgreSQL과 Object Storage root credential, Docker internal endpoint는 Renderer와 discovery에
  노출하지 않는다.
- non-loopback 연결은 HTTPS·WSS만 허용하고 custom CA를 지원하되 TLS 검증 해제 옵션은 제공하지 않는다.
- token, OS key store, cache, recent route와 Realtime cursor는 origin과 stable `instanceId`별로 격리한다.
- Object transfer는 Control Plane이 permission을 확인한 뒤 발급한 presigned URL을 사용한다.

상세 bootstrap schema, Docker public/internal URL과 연결 UI는
[SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md)을 따른다.

## 실시간과 미디어

- 업무 이벤트와 채팅은 Realtime Gateway 사용
- 터미널·원격 데스크톱은 별도 Relay 데이터 경로 사용
- 영상·음성·화면 공유는 optional `meeting` profile의 LiveKit Media SFU 사용
- 대용량 파일과 녹화는 Object Storage 사용
- 모든 채널은 동일한 조직·세션 권한을 확인

서로 다른 트래픽을 하나의 WebSocket에 합치지 않는다. 터미널 폭주가 채팅, 승인, heartbeat를
막지 않도록 제어와 대용량 스트림을 분리한다.

전체 process topology, Fastify module, Keycloak, SeaweedFS와 LiveKit 기준은
[Reference Architecture v1](./32-reference-architecture-v1.md)을 따른다.

## 오프라인과 재연결

- 네트워크 상태를 명시적으로 표시
- 작성 중 메시지와 폼 임시 저장
- 멱등 키를 가진 재시도
- 구독 재연결 후 스냅샷과 이벤트 재동기화
- 중복 실행을 막는 작업 ID
- 원격 세션은 재연결 가능 여부와 종료 여부를 구분

## 패키징

- macOS, Windows, Linux 설치본
- 동일 앱의 역할 기반 모드
- Edge Agent와 Relay Client 번들
- 서명된 자동 업데이트
- 엔터프라이즈용 오프라인·온프레미스 배포
- 플랫폼별 권한과 방화벽 안내

앱과 서버가 항상 동시에 배포된다고 가정하지 않는다. Control Plane, Runtime, Relay, Edge Agent는
연결 시 protocol과 capability를 협상하고 지원되지 않는 기능을 명시적으로 비활성화한다.

## 아키텍처 완료 기준

Renderer가 직접 Node와 OS 권한을 사용하지 않고, Main과 Runtime의 타입 계약을 통해 로컬·WSL·
SSH 작업을 수행하며, 서버 연결이 끊겨도 UI와 진행 중 세션이 일관된 복구 상태를 제공해야 한다.
