# 구현 로드맵

## 원칙

모든 메뉴의 빈 화면을 먼저 만들지 않는다. 기반 계층을 완성한 뒤 고객 요청에서 원격지원, 코드
수정, 고객 확인까지 이어지는 수직 흐름을 단계별로 출시한다.

- 보안과 데이터 경계는 화면보다 먼저 구현한다.
- 각 단계는 실제로 시연 가능한 사용자 흐름과 자동화된 종료 조건을 가진다.
- Electron, 서버, Runtime, Relay가 다른 버전인 상황을 항상 시험한다.
- 로컬·WSL·SSH·Edge Agent 실행 위치를 공통 계약으로 다룬다.
- 운영 관측과 복구 없이 기능 단계를 완료 처리하지 않는다.
- 다음 단계는 이전 단계의 미완료 기반을 우회하지 않는다.

## 의존성 순서

```text
R0 결정과 계약
└── R1 안전한 Electron 기반
    └── R2 Control Plane 기반
        └── R3 인증·RBAC·Entitlement
            └── R4 프로젝트·업무 포털
                └── R5 AI 실행 추적·개발 Workspace
                    ├── R6 CRM·SI 프로젝트 수행
                    ├── R7 협업·회의·지식·자동화
                    └── R8 서비스 데스크·원격지원·자산
                        └── R9 재무·연동·엔터프라이즈 완성
```

R0부터 R3까지는 제품 기반이고, R4부터 사용자가 업무 가치를 확인한다. 첫 외부 알파는 R5까지
완료한 뒤 진행한다. 여러 관리 화면을 넓게 만드는 대신 프로젝트 업무에서 Claude Code·Codex
Workspace를 열고 실제 산출물이 돌아오는 수직 흐름으로 Pie의 핵심 가설을 먼저 검증한다.

## R0: 결정과 계약

### 목표

코드를 크게 변경하기 전에 기존 Orca 기능과 새 Pie 서비스 사이의 경계를 고정한다.

### 범위

- Pie 표시명과 기존 식별자 호환 정책
- 현재 Electron Main, preload, Renderer, Runtime, Relay 책임 목록
- 사용자·조직·고객·프로젝트·호스트의 신뢰 경계와 위협 모델
- 공통 ID, 테넌트, 이벤트, 감사, 오류 코드 규칙
- permission 카탈로그와 기본 역할·리소스 범위
- entitlement 카탈로그와 초기 제품 plan 가정
- Control Plane API, Realtime, Runtime, Relay의 버전·capability 계약
- Reference Architecture v1과 OpenAPI·AsyncAPI·JSON Schema 권위
- 로컬 데이터와 중앙 데이터의 소유권·동기화 규칙
- 지원 OS, Git 2.25, WSL, SSH, Wayland·X11 범위
- 구현 준비도, API·이벤트·동기화 계약, 위협 모델과 검증 매트릭스
- KROOT capability별 소스 근거와 이관·대체·보류 판정

### 필수 결정 기록

- Keycloak Identity와 Pie Authorization 경계
- Fastify Control Plane, PostgreSQL, SeaweedFS와 outbox 배포 단위
- Electron과 서버 사이의 OpenAPI·AsyncAPI·JSON Schema 계약
- 기존 `cli-relay` 재사용 범위와 확장 방식
- 원격 데스크톱 sidecar 경계와 LiveKit Media SFU 통합 방식
- 자동 업데이트, 코드 서명, 온프레미스 배포 방식

현재 결정은 [Reference Architecture v1](./32-reference-architecture-v1.md),
[아키텍처 결정과 기술 기준](./22-architecture-decisions-and-technology.md)과
[`docs/adr`](../docs/adr/README.md)에서 관리한다. 실행 가능한 schema는
[Contract Specification과 변경 관리](./33-contract-specification-governance.md)를 따른다.

### 종료 조건

- 새 도메인 용어와 엔터티가 문서와 타입 계약에서 충돌하지 않는다.
- 사용자 역할별 허용·거부 행렬과 대표 공격 시나리오가 정의된다.
- 기존 Orca 프로필, CLI, 딥링크, Runtime 호환 fixture를 확보한다.
- 구현 중 결정을 다시 열어야 하는 항목과 실험으로 확인할 항목이 구분된다.
- [구현 준비도](./21-implementation-readiness.md)의 R0 저장소 산출물이 executable contract와 ADR로
  생성된다.
- [보안 위협 모델](./24-security-threat-model.md)의 P0 위협과
  [검증 매트릭스](./25-verification-test-matrix.md)의 단계별 gate가 CI 또는 release checklist에
  연결된다.
- [KROOT 기능 이관](./26-kroot-capability-migration.md)의 capability manifest가 기준 commit과 함께
  확정된다.

### 구현 상태

2026-07-15 `feat/pie-r0-contracts`에서 executable contract 기준선을 구현했다. `pielab.ai` namespace의
JSON Schema 59개, fixture 49개, OpenAPI 18 operation, AsyncAPI 7 message, MCP 6 tool과 P0 threat
38개의 단계별 gate를 `pnpm check:contracts`로 검증한다. OS·host·Git·Claude Code·Codex 조합은
`contracts/manifests/support-matrix.json`, KROOT 이관 근거는 source baseline과 capability manifest에
고정했다. 실제 단계별 E2E 구현은 이 계약을 입력으로 R1부터 진행한다.

## R1: 안전한 Electron 기반

### 목표

기존 앱 기능을 보존하면서 새 중앙 기능이 통과할 안전한 데스크톱 경계를 만든다.

### 범위

- 모든 BrowserWindow의 sandbox, context isolation, CSP 점검
- preload API를 도메인별 타입 계약으로 정리
- sender·스키마·조직 문맥을 검증하는 IPC 공통 경로
- Main의 인증 세션 브로커 인터페이스와 OS 보안 저장소
- `pie://` 딥링크와 단일 인스턴스 callback 검증
- App ↔ Runtime protocol version과 capability handshake
- Electron Fuses, ASAR integrity, 코드 서명·업데이트 검증
- Orca 로컬 프로필 감지, 백업, 마이그레이션 dry-run
- 안전 모드와 민감정보 제거 진단 번들

### 먼저 구현할 얇은 계약

1. Renderer가 `getSessionState`를 호출한다.
2. Main이 로그인되지 않은 타입이 있는 결과를 반환한다.
3. Main과 Runtime이 버전·capability를 교환한다.
4. 허용되지 않은 sender, payload, protocol 버전을 자동화 테스트에서 거부한다.

이 단계에서는 실제 회원가입 서버를 만들지 않는다. 이후 인증 구현이 들어갈 자리를 범용 IPC나
Renderer 토큰 저장 없이 고정한다.

### 구현 상태

2026-07-16 `feat/pie-r1-electron-foundation`에서 첫 얇은 계약을 구현했다. Renderer는
`window.api.pie.session.getState()`로 Main의 signed-out Session Broker를 읽고,
`window.api.pie.runtime.getHandshake()`로 Main이 내부 capability를 사용해 협상한 Runtime protocol,
host와 제한값만 받는다. preload와 Main이 양쪽 payload를 검증하며 Main은 현재 BrowserWindow ID,
window type과 main frame을 모두 확인한다. Runtime capability secret과 인증 token은 Renderer로 전달하지
않는다.

같은 날 두 번째 slice에서 패키지 metadata에 `pie` scheme을 등록하고 macOS `open-url`, 최초 실행과
Windows·Linux `second-instance` command line을 하나의 Main broker로 연결했다. 현재 허용 route는
fallback OIDC callback인 `pie://auth/callback` 하나뿐이다. callback은 원문 route, query cardinality와
길이를 검증하고 Main 메모리에 최대 10분간 등록된 base64url `state`와 일치할 때 한 번만 소비한다.
authorization code, state와 IdP 오류 설명은 로그나 Renderer로 전달하지 않는다. 실제 PKCE 생성,
시스템 브라우저 실행과 code 교환은 R3 인증 수직 흐름에서 이 broker에 연결한다.

같은 날 세 번째 slice `feat/pie-r1-secure-session-store`에서 Main 전용 `SessionSecretStore` 계약과
Electron `safeStorage` adapter를 구현했다. refresh token만 instance·profile·account별로 격리된
디렉터리에 암호화해 저장하고(atomic write, 파일 권한 제한, scope segment는 SHA-256으로 경로·대소문자
충돌 차단), access token은 Main 메모리에만 둔다. Linux `basic_text`·미확인 backend와 암호화 불가
환경은 저장을 거부하고 로그인 유지만 비활성화한다. 손상된 ciphertext는 읽기 시점에 폐기해 재로그인을
강제한다. `PieSessionTokenLifecycle`이 로그인 저장, rotation 교체, 로그아웃·계정 제거 삭제를 Session
Broker와 연결하며 조직 전환은 secret store를 읽지 않아 다른 계정 token을 재사용할 수 없다. preload와
Renderer에는 어떤 token API도 노출하지 않았다.

같은 날 네 번째 slice `feat/pie-r1-electron-hardening`에서 ELC-005(DevTools·Node 옵션·ASAR
변조를 통한 권한 상승)를 겨냥해 패키지 강화를 구현했다. electron-builder의 `electronFuses`로
사용하지 않는 Electron Fuses를 비활성화한다. `NODE_OPTIONS`·`NODE_EXTRA_CA_CERTS` 환경변수와
`--inspect` 계열 인자를 무시하고, cookie 암호화·ASAR integrity 검증·`onlyLoadAppFromAsar`를 켠다.
단 `runAsNode`는 유지한다. 패키지된 CLI 런처가 `ELECTRON_RUN_AS_NODE=1`로 실행되고 terminal
daemon이 plain Node로 `child_process.fork`되기 때문이며, 이 fuse를 끄면 fork 자체가 깨진다.
`grantFileProtocolExtraPrivileges`도 유지(deferred)한다. production renderer가 `file://`로 로드되고
onig.wasm과 Monaco worker를 `file://`에서 가져오기 때문이며, renderer를 custom protocol로 옮긴 뒤
비활성화한다. ASAR integrity는 macOS·Windows에서만 강제되고 Linux는 fuse만 설정될 뿐 강제되지
않는다(수용된 gap). renderer `index.html`에는 strict Content-Security-Policy를 추가했다. production
정책은 `default-src 'self'`·`object-src 'none'`·`base-uri 'none'` 기준이며 `'unsafe-eval'`을 절대
포함하지 않는다. dev HMR origin(http·ws localhost)과 dev inline/eval은 serve 전용 Vite 플러그인이
주입해 prod와 분리한다. 메인 BrowserWindow는 `contextIsolation: true`·`nodeIntegration: false`를
명시적으로 고정해 Electron 기본값 변화에 의존하지 않는다. `verify:packaged-security` 스크립트가
패키지된 앱에서 flipped fuse wire, macOS Info.plist의 `ElectronAsarIntegrity`와 `codesign --verify
--strict`, app.asar 레이아웃을 검사하며, 이것이 ELC-005의 `fuse-asar-signature-gate` 증거다. fuse
읽기와 결정 로직은 pure 함수로 단위 테스트한다.

같은 날 다섯 번째 slice `feat/pie-r1-profile-migration-dryrun`에서 기존 Orca 프로필의 감지·백업·
마이그레이션 dry-run을 구현했다. 감지는 주입된 userData 경로를 읽기 전용으로 조사해 `none`(새 설치),
`legacy-single-profile`(루트 orca-data.json), `multi-profile`(orca-profile-index.json)로 분류하고
프로필별 파일 존재/누락, 손상 index의 `.bak` 복구 여부, orca-data.json의 top-level schemaVersion(없으면
`unversioned`)을 인벤토리한다. 백업은 index와 프로필 데이터 파일을 `userData/pie/migration-backups/
{runId}/`에 tmp+rename으로 복사하되, 암호화 자격증명 저장소(`pie/session-secrets`·claude/codex
accounts·claude-runtime-auth·`*.enc`)와 `orchestration.db`는 복사하지 않고 manifest에 excluded-secret·
excluded-database로만 기록한다. manifest는 마지막에 기록해 중단된 스냅샷은 manifest 부재로 폐기 대상이
된다. dry-run 엔진은 provisional `pie/migration-target` projection 대비 항목을 create·merge·conflict·
missing·sensitive-device-only로 분류하고 데이터를 이동하지 않으며, 두 번 실행해도 runId·timestamp를
제외하면 같은 report를 낸다. report는 경로와 개수만 담고 파일 내용·token 값을 절대 포함하지 않으며
`writeSecureJsonFile`로 `userData/pie/migration-reports/{runId}.json`에 권한 제한 저장한다. 표시명이
아닌 안정적 id에서 경로를 파생하는 중앙 `pie-product-identity` 계약이 이 매핑을 고정하고, 앱 데이터
디렉터리 naming·`orca://`·IPC·telemetry 키는 부수적으로 변경하지 않는다. 감지·백업·dry-run은 모두
Main 전용이며 아직 renderer나 IPC로 노출하지 않는다. 실제 cutover(데이터 이동)와 안전 모드는 후속
slice로 남고, 마이그레이션 데이터 노출을 위한 전용 threat-model gate는 아직 없으며 위협 모델 P1
Backup 행에 매핑된다.

같은 날 여섯 번째 slice `feat/pie-r1-safe-mode-diagnostics`에서 안전 모드 메커니즘과 연결 진단
번들 확장을 구현했다. 안전 모드는 startup/gpu-fallback-marker를 따른 schema-versioned 크래시 버스트
마커(userData의 `safe-mode.json`, 빌드별 sticky, 정상 시작이나 앱·Electron 버전 변경 시 초기화,
크래시 루프 중 원자적 write)로 연속 실패한 시작 횟수를 세고, 기본 임계값 3회 연속 실패 뒤 다음
launch가 안전 모드로 부팅한다. `--safe-mode` CLI 플래그나 `PIE_SAFE_MODE=1` 환경변수로 강제할 수도
있으며 플래그가 버스트보다 우선한다. 결정은 순수 함수이고 프로세스 상태는 Main에서 한 번 정해진 뒤
읽기 전용이다(어떤 IPC 핸들러도 변경하지 못해 renderer가 서브시스템 보안을 끌 수 없다). 안전 모드는
first-window startup seam에서 `guardStartupService`로 터미널 daemon과 agent hook server 시작을
건너뛰어, 크래시를 유발하던 서브시스템이 복구 부팅에서 다시 실행되지 않게 한다. 창이 뜬 뒤 유예
시간 동안 크래시 없이 살아남거나 사용자가 정상 종료(`before-quit`)하면 카운터를 지운다 — 유예
시간보다 짧은 실행·종료 반복이 크래시 버스트로 오인되지 않게 한다. 진단 번들에는 `pie-connection-diagnostics` 수집기가
Main/Renderer/Runtime/Relay 4-way 섹션을 추가한다 — 안전 모드 상태, Pie 세션 status와 instanceId만,
보안 저장소 가용성(backend/reason), daemon liveness, 앱·Electron·platform을 필드 단위로 구성하고
기존 server-mode redactor로 다시 한번 스크럽한 뒤 emit한다. Runtime과 Relay는 아직 없으므로
`not-configured`로 정직하게 보고한다. 섹션은 composition root가 등록한 provider를 통해 기존
`collectDiagnosticBundle`에 실려 consent·preview·upload 흐름은 바뀌지 않는다.

안전 모드는 R1에서 메커니즘만 구현했다. 사용자에게 보이는 배너·복구 UI, on-demand로 실행되는 agent
runtime과 Pie Runtime handshake의 gating(현재는 선언만 되고 startup launch가 아니라 미가드), 업데이트
실패→안전 모드의 명시적 배선은 남아 있다. `updater-fallback.ts`는 상태 비교 helper라 트리거 seam이
아니어서 배선하지 않았고, 업데이트로 유발된 시작 크래시는 크래시 버스트 경로가 일반적으로 이미
포착한다. 마이그레이션 데이터 노출 전용 threat-model gate가 없는 점(위협 모델 P1 Backup 행 매핑)도
그대로다.

R1 전체가 완료된 것은 아니다. 실제 서명 인증서를 사용하는 릴리스 서명·notarization gate, 프로필
마이그레이션의 실제 cutover, 안전 모드 UX와 업데이트 실패 복구 배선은 후속 R1 slice로 남아 있다.

### 종료 조건

- Renderer가 Node, 토큰, OS 비밀에 직접 접근하지 않는다.
- 딥링크와 외부 URL이 allowlist 밖의 탐색·명령을 실행하지 못한다.
- 서명과 integrity 검증 실패 빌드가 시작·업데이트되지 않는다.
- 기존 개발 Workspace의 핵심 회귀 테스트가 통과한다.
- 구버전 Runtime fixture와 handshake 실패·제한 모드를 재현한다.

## R2: Control Plane 기반

### 목표

인증과 업무 기능이 공유할 테넌트 저장소, 이벤트, 작업, 관측, 복구 기반을 먼저 만든다.

### 범위

- Node.js 24·Fastify 5 기반의 버전이 있는 Control Plane API와 request correlation ID
- PostgreSQL migration과 테넌트 문맥 강제
- SeaweedFS와 S3 adapter의 테넌트 key, presigned transfer와 격리 영역
- transactional outbox, 작업 큐, 멱등 소비자, dead-letter
- 감사 이벤트 append 경로
- Realtime Gateway의 연결·재동기화 최소 계약
- 공개 인증 utility page와 이메일 발송 pipeline
- 로그, 메트릭, trace와 기본 운영 대시보드
- 자동 백업과 별도 환경 restore smoke test
- 앱 최소 지원 버전과 capability 응답

### 첫 서버 수직 확인

`임시 조직 fixture 생성 → 감사 이벤트 저장 → outbox 발행 → Worker 소비 → Electron에 Realtime 전달`
흐름을 만든다. 이 흐름이 이후 사용자 초대, 티켓 알림, 권한 폐기의 기준 구현이 된다.

### 종료 조건

- 다른 테넌트 문맥의 DB·Object Storage 접근이 통합 테스트에서 거부된다.
- 요청 하나를 Electron에서 DB와 Worker까지 trace할 수 있다.
- 중복 이벤트와 Worker 재시작이 중복 업무 결과를 만들지 않는다.
- 백업을 새 환경에 복원하고 데이터·감사 연속성을 검증한다.
- 구버전 앱 fixture가 지원·제한·업데이트 필요 상태를 구분한다.

### 구현 상태

2026-07-17 `feat/pie-r2-platform-foundation`에서 첫 slice인 platform 워크스페이스와 PostgreSQL 테넌트
기반을 구현했다. `platform/`은 자체 `pnpm-workspace.yaml`과 lockfile을 가진 독립 pnpm 워크스페이스로,
Desktop 루트 package와 dependency를 섞지 않는다(루트 lockfile 무변경 확인). 앱은
`apps/control-plane-api`·`apps/control-plane-worker`, 패키지는 `packages/persistence` 하나로 시작한다.
ADR-0008 clause 11에 따라 `platform/` 경로를 사용하고 doc 30 :429의 `services/control-plane` 경로는
stale로 간주한다.

`packages/persistence`는 SQL-first 동결 migration runner(적용 파일의 checksum을 기록하고 이미 적용된
migration의 checksum이 바뀌면 hard error, advisory lock으로 단일 실행)와 고정 schema(identity·
operations·audit)를 만든다. 역할은 `pie_migration_owner`, `pie_app`(NOBYPASSRLS), `pie_worker`(claim 전용)
이다. `identity.organizations`는 테넌트 root라 자기 `id`를 RLS 기준으로 삼고, `operations.outbox_events`는
doc 30 :330-332 컬럼을 그대로 두고 partial claim index를 가지며, `operations.idempotency_records`와
append-only `audit.audit_events`가 함께 있다. 모든 테넌트 table은 permissive isolation + restrictive
boundary guard + FORCE RLS를 적용하고, `withTenantTransaction`이 `SET LOCAL ROLE pie_app` +
`SET LOCAL pie.organization_id`로 문맥을 건다(문맥 없으면 default deny). Worker는 BYPASSRLS가 아니라
`pie_worker` 전용 grant·policy로 cross-tenant claim만 하고(`withWorkerClaimTransaction`), 시드 등 운영
경로는 `withoutTenantContext`를 쓴다. 시드 로더는 `contracts/fixtures/valid/organization.json` 모양의
임시 조직을 idempotent하게 넣는다(공개 createOrganization 엔드포인트 없음, 결정 사항).

두 앱은 최소 Fastify 5 부팅만 한다. API는 `/healthz`(liveness)·`/readyz`(DB ping)와 W3C traceparent
correlation, RFC 9457 problem+json 오류, 그리고 contracts의 JSON Schema 2020-12를 소비하는 Ajv2020
validator를 갖고 아직 업무 엔드포인트는 없다. Worker는 부팅·연결·heartbeat idle만 하며 SKIP LOCKED
claim 루프는 slice 2다. 로컬 dev는 `deploy/compose/dev-postgres.yml`(PostgreSQL 16 단독, dev 전용
자격증명)로 띄우고, 통합 테스트는 dev DB와 충돌하지 않도록 testcontainers로 임시 PG16을 띄워 실제
migration·RLS 부정 테스트·worker claim·시드 idempotency를 검증한다(Docker 부재 시 명시적 SKIP).
DTO 생성기는 openapi-typescript를 고정했고, OpenAPI가 스키마를 원격 `$id`로 상호 참조해 오프라인
생성이 막히므로 로컬 파일로 dereference하는 얇은 prepass를 거쳐 18개 operation DTO를 `generated/`에
만든다. slice 2는 조직 mutation을 한 transaction 안에서 audit+outbox로 쓰고 Worker의 SKIP LOCKED
claim과 Realtime `resource.changed`까지 잇는 수직 흐름이다.

2026-07-18 `feat/pie-r2-outbox-vertical`에서 두 번째 slice인 outbox 수직 흐름을 구현했다.
`updateOrganizationDisplayName`이 한 transaction에서 org row version 증가 + 감사 이벤트 + outbox 이벤트
+ operation record를 함께 쓴다(aggregate row `FOR UPDATE` lock, `expectedVersion` 광학적 동시성). 네
row는 모두 커밋되거나 모두 롤백되며 commit 전 side effect가 없다. outbox payload는 CloudEvents 1.0
envelope(pieorgid·piestream 확장)이고, publish 시점에 org별 단조 sequence를 부여한다. sequence는
`operations.stream_cursors`의 원자적 upsert로 매기며 published_at·NOTIFY와 한 transaction이라 롤백 시
gap이 없다. Worker claim 루프는 `FOR UPDATE SKIP LOCKED`로 배치 claim하고 lease(claim_expires_at)를
걸며, publish는 row lock 아래 published_at 재확인으로 idempotent하다(동시 두 worker가 같은 row를 한 번만
publish, publish 중 재시작해도 이중 전달 없음, 전달은 at-least-once + client의 cursor 기반 idempotent
apply). 실패는 exponential backoff로 재시도하고 재시도 예산을 넘긴 poison row는 `parked_at` +
`last_error_code`로 dead-letter parking한다. Realtime gateway는 별도 process가 아니라 control-plane-api
안의 module로, `pie://` WebSocket에서 ClientHello→ServerWelcome 핸드셰이크(스키마 검증)와 org 구독(현재
org는 hello에서 옴 — 실제 authn은 R3, trust gap 문서화), Heartbeat, ResourceChanged push, 너무 뒤처진
클라이언트에 ResyncRequired를 처리한다. Worker→gateway 전송은 Postgres-only LISTEN/NOTIFY이며 payload는
작은 pointer(org + sequence)이고 gateway가 DB에서 envelope를 다시 읽는다(NOTIFY는 크기 제한·연결 끊김에
lossy하므로 재연결 후 cursor 기반 catch-up). `listResourceChanges`(REST `/v1/organizations/{id}/changes`)가
Realtime 문서가 요구하는 복구 권위자로, org 문맥(RLS)으로 sequence 이후 delta를 낸다. `getOperation`과
`listOrganizations`도 구현했고 응답을 contracts 스키마로 런타임 검증한다. 통합 테스트는 실제 PostgreSQL과
WS 테스트 클라이언트로 mutation 원자성(실패 시 부분 row 없음), 동시 두 worker exactly-once,
resource.changed 전달, cross-tenant 격리(org A 구독은 org B 이벤트를 못 받고, org A 문맥은 org B changes를
못 읽음), 재연결 delta, 너무 뒤처짐→ResyncRequired→`/changes` 수렴을 검증한다. Electron 클라이언트 배선은
slice 2b, WS 실제 authn은 R3, dead-letter table·SeaweedFS·백업·대시보드는 후속 R2 slice로 남는다.

2026-07-18 slice 2b `feat/pie-r2-electron-realtime-client`에서 Electron(Main) 쪽 Realtime 클라이언트를
구현해 "Worker 소비 → Electron에 Realtime 전달" 종료 조건을 닫았다. `src/shared/pie-realtime-contract.ts`가
AsyncAPI 7개 메시지를 zod로 옮기고(inbound는 forward-compat 위해 passthrough, outbound는 strict) R0
fixture(valid·unknown-optional 호환·version-zero invalid)를 기존 계약 테스트와 동일하게 검증한다.
`src/main/pie-realtime/`는 Main 전용 클라이언트로, 기존 relay가 쓰던 `ws` 의존성을 재사용해 WebSocket
lifecycle을 관리한다. ClientHello(재개 시 lastCursor 포함)를 보내고 ServerWelcome을 받고 Heartbeat에
pong으로 답하며, 모든 inbound 메시지를 zod로 검증해 유효하지 않으면 dispatch 없이 연결을 끊고 재접속한다.
재접속은 capped exponential backoff + jitter, heartbeat timeout 감지로 죽은 연결을 회수한다. 커서 기반
dedupe(플랫폼 전달이 at-least-once이므로 lastAppliedSequence 이하 무시)로 중복을 한 번만 적용하고,
ResyncRequired는 소비자에 `resync-needed` 상태를 알린 뒤 주입된 fetchChanges(REST `listResourceChanges`)로
수렴한다. HTTP를 실제로 수행하는 얇은 어댑터는 별도 파일이며 플랫폼과 같은 `x-pie-organization-id` authn
stand-in 헤더에 R3 trust-gap 주석을 단다. 연결은 dev-gated(`PIE_REALTIME_URL` + org)이고 production
자동 연결은 없으며(instance discovery·connection profile은 후속), 안전 모드에서는 연결하지 않는다
(`pie-realtime`을 `SAFE_MODE_GATED_SUBSYSTEMS`에 추가). renderer/preload에 raw 메시지를 노출하지 않고,
유일한 외부 표면은 연결 상태를 `pie-connection-diagnostics`에 싣는 것으로 진단 섹션을 schemaVersion 2로
올려 `realtime` subsection을 추가했다. 테스트는 in-process `ws` mock 서버로 handshake·커서 dedupe·heartbeat
timeout 재접속·resync 수렴·session.revoked 종료·connection.closing 재접속·invalid 메시지 미dispatch·safe
mode/dev-gate 미연결을 검증한다. renderer 노출, instance connection profile, 실제 authn은 이후 slice로 남고,
커서의 재시작 간 영속화는 향후 최적화로 남긴다(현재는 재접속 resync로 복구).

2026-07-19 slice 3 `feat/pie-r2-object-storage`에서 Object Storage 어댑터와 artifact 업로드 수직 흐름을
구현했다. `platform/packages/object-storage-adapter`는 S3 호환 클라이언트(@aws-sdk/client-s3 +
s3-request-presigner, presign PUT·HEAD·bucket)와 테넌트 key 빌더를 제공한다. key 빌더는 한 조직에
바인딩되어 모든 key를 `org/{org_id}/{zone}/{objectId}`로 namespace하고, 다른 조직 key를 만들 API 자체가
없어 cross-tenant 접근이 구조적으로 불가능하다(ADR-0006 §3). isolation zone은 key prefix(artifacts·
transcripts·attachments)로 분리한다. 물리 schema는 doc 30을 따라 `agent` schema에 `agent.objects`(staging→
available 등 lifecycle), immutable `agent.artifact_revisions`(append-only, pie_app는 SELECT+INSERT만),
`agent.artifacts`(current_revision·version)와 `operations.artifact_upload_sessions`를 두고 모두 tenant
RLS(isolation+guard+FORCE)를 적용한다. `createArtifactUploadIntent`는 `Idempotency-Key`로 멱등하고
(operations.idempotency_records를 실제로 사용: 같은 key+payload는 같은 intent를 replay, 다른 payload는
409), 테넌트 key로 staging object와 presigned PUT target을 만든다. localPath/file: 대상은 request schema의
`additionalProperties:false`로 거부한다. `finalizeArtifactUpload`는 object 존재(HEAD)와 size를 확인한 뒤
immutable revision 생성 + object available + artifact available + audit + outbox를 한 tenant transaction으로
쓴다 — outbox 이벤트는 artifact resource-change라 slice 2의 Worker→Realtime 경로가 `artifact.created`를
새 plumbing 없이 전달한다. 통합 테스트는 실제 PostgreSQL과 실제 S3(테스트는 SeaweedFS 우선 시도 후
불안정하면 MinIO로 fallback; production/dev compose 기본값은 SeaweedFS로 유지, 어댑터 코드는 동일)로
테넌트 key 격리, presign 왕복(PUT→HEAD), intent 멱등성, finalize 원자성 + WS 클라이언트의 artifact 실시간
수신, localPath 거부, 다른 테넌트에서 finalize 불가(RLS 404)를 검증한다. `deploy/compose/dev-object-storage.yml`
(SeaweedFS S3, dev 전용)을 추가했다. multipart 업로드·object 삭제 workflow·malware/secret scan quarantine
게이트·download presign·backup restore·관측 대시보드는 후속 R2 slice로 남는다.

2026-07-19 slice 4 `feat/pie-r2-backup-capability`에서 남은 두 R2 종료 조건(백업·복원 연속성, 앱
최소버전·capability 게이팅)을 구현했다. **백업/복원:** `packages/persistence/database-backup.ts`가 논리
백업 driver로, pg 도구를 **postgres 컨테이너 내부에서** 실행한다(주입된 exec) — host pg_dump가 서버와
다른 major(여기 host는 psql 17.x)면 조용한 손상 위험이라 의도적으로 피한다. `pg_dumpall --roles-only
--no-role-passwords`(역할, 비밀번호 제외)와 plain SQL `pg_dump`(스키마·데이터·grant·RLS policy)를 뜬 뒤
새 컨테이너에 psql로 복원한다. 통합 테스트는 컨테이너 A를 채우고(2 tenant, org mutation 수직 + publish로
stream_cursors + artifact intent/finalize) 백업→**새 컨테이너 B로 복원**→검증한다: migration checksum
테이블 보존, org/audit/outbox/artifact row 수·내용 일치, audit 연속성(digest 보존), 복원 DB에서 RLS
여전히 강제(tenant A만 보임), stream_cursors 일관성(복원 후 재개 publish가 시퀀스를 1로 되돌리지 않고
다음 번호로 이어감). 위협모델 P1 Backup: DB에 credential이 없고(토큰은 client측), audit은 digest만
저장함을 canary로 검증(백업 바이트에 canary 평문 부재·digest 존재, globals 덤프에 PASSWORD 없음).
custom-format+pg_restore와 WAL/PITR은 production ops 관심사로 문서상 deferred(복원 스모크는 컨테이너 간
텍스트 이동이 단순한 plain SQL을 사용 — 연속성·RLS·비밀 검증은 포맷 무관). **capability/버전 게이팅:**
control-plane-api가 `GET /.well-known/pie`(getInstanceDiscovery)를 구현해 config 기반의 정직한 discovery
문서(존재하는 endpoint api·realtime, 구현된 기능만 true인 capabilities, 최소버전 정책)를 서빙하고 응답을
contract로 검증한다. 클라이언트측 평가기는 doc 16:65-66에 따라 Electron repo `src/shared/
pie-instance-discovery.ts`에 순수 함수로 두었다: discovery를 zod로 검증하고 (appVersion, 지원 protocol)로
supported/limited/needs-update를 분류한다 — 최소버전 미만·protocol major 초과면 needs-update, protocol
minor 초과면 limited(연결되나 일부 기능 제한), 아니면 supported. R0 discovery fixture(valid·unknown-optional
·lan-http·direct-password)와 old/current/future 버전 케이스로 세 상태를 구분함을 테스트한다(종료 조건 그대로).
observability 대시보드, dead-letter table·job queue 일반화, 공개 인증 페이지 셸은 후속 R2로 남는다.

2026-07-19 slice 5 `feat/pie-r2-observability-trace`에서 관측성과 종료 조건 :241(한 요청을 Electron부터
DB·Worker까지 끝에서 끝으로 추적)을 구현했다. **문서 판독:** OpenTelemetry는 observability **deploy
profile**(doc 32:276 Collector+backend, ADR-0011:43)이고 doc은 W3C Trace Context 전파 + 구조적 signal을
요구하므로, OTel SDK를 아직 끌어오지 않고 W3C traceparent 전파 + 구조적 pino 로그 + JSON 메트릭을 정직히
구현하고 OTel Collector/exporter는 deploy profile 후속으로 둔다. **trace 전파:** 도메인 mutation과 artifact
finalize가 traceparent를 받아 trace-id를 audit row에 쓰고 traceparent를 CloudEvents 봉투의
distributed-tracing 확장 필드(doc 23:46)로 outbox에 싣는다. Worker claim 루프는 봉투에서 trace-id를 꺼내
publish/park/requeue를 구조적으로 로그하고, gateway는 delivery 시 DB에서 봉투의 traceparent를 읽어
trace-id로 delivery를 로그한다. Realtime `resource.changed` 스키마에는 trace 필드가 없으므로(계약 변경은
별도 slice) client측 상관은 gateway까지이며 wire 계약을 확장하지 않는다(문서화). **구조적 로그:** worker가
console.log 대신 pino(service·workerId·event 필드)를 쓰고 주기적 메트릭 라인을 남긴다. **메트릭:** API가
auth-free 내부 `GET /internal/metrics`(JSON: outbox published/pending/parked·claim lag 초·realtime
connected clients·delivered messages)를 제공한다 — outbox 카운트는 pie_worker 전용 grant로 cross-tenant
집계(BYPASSRLS 아님, 내용 미노출). Prometheus 포맷은 ADR 없어 JSON now·exporter later. **ops 대시보드:**
빌드·프레임워크 없는 단일 정적 HTML을 `GET /internal/ops`로 서빙해 metrics·readyz·discovery를 fetch로
표시(dev/ops 편의, Grafana/OTel은 deploy profile). **e2e trace 테스트:** 알려진 traceparent로 mutation →
같은 trace-id가 audit row·outbox 봉투·worker publish 로그·gateway delivery 로그에 나타남을 검증(종료 조건
실행형). dead-letter table·job queue 일반화·공개 인증 페이지 셸은 후속 R2, OTel exporter·Grafana는
observability deploy profile로 남는다.

2026-07-20 slice 6 `feat/pie-r2-dead-letter-auth-shell`에서 마지막 R2-범위 종료 조건(dead-letter
table·작업 큐 일반화, 공개 인증 utility page 셸·이메일 pipeline 셸)을 구현했다. **dead-letter:** doc 30의
operations 카탈로그에 전용 dead-letter table이 없어 정직한 최소 설계로 `operations.dead_letter_events`를
추가했다(outbox 봉투 컬럼 전부 + parked_at·last_error_code·attempt_count + 재큐 감사 트레일, 다른
operations table과 동일한 RLS: pie_app isolation+guard, pie_worker 전용 grant). parking은 이제 in-place
표시가 아니라 **relocate**다 — 재시도 예산을 넘긴 row를 한 worker transaction에서 dead_letter_events로
옮기고 hot outbox에서 삭제해(pending-claim partial index를 작게 유지, dead letter를 운영상 가시화)
`requeueFailedEvent`가 `relocateToDeadLetter`를 호출한다(pie_worker에 outbox DELETE grant 추가).
operator 재큐(`requeueDeadLetterEvent`, UI 없음, 조직을 넘나드는 정당한 ops라 tenant 문맥 없이 실행)는 dead
letter를 attempt_count 0으로 outbox에 되돌리고 dead-letter row는 삭제 대신 `status=requeued`+requeue_count
로 트레일을 남기며 감사 이벤트(`outbox.dead_letter.requeued`)를 append한다. `/internal/metrics`는
deadLetter(parked) 카운트를 추가한다(pie_worker cross-tenant count only). **작업 큐 일반화:** outbox가
여전히 유일한 job source라 범용 job framework를 만들지 않고, SKIP LOCKED 큐 역학만 재사용 가능한 모듈로
정직하게 추출했다 — 순수 재시도 정책(`queue-retry-policy.ts`: backoff·park 결정)과 table-agnostic 폴링
드라이버(`queue-polling-loop.ts`: unref timer·배치 실패 격리·start/stop)를 outbox를 첫 소비자로 두고
분리했고, 새 job type이 자신의 claim/execute를 더해 이들을 재사용한다고 문서화했다(투기적 추상화 금지).
**공개 인증 셸:** 문서 정찰 결과 credential 흐름(이메일/비밀번호·확인 토큰 처리·재설정 폼·MFA·Passkey)은
Keycloak 소유이고 Control Plane은 결과·랜딩·안내 페이지만 소유한다(doc 16:11-19, doc 00:42, doc 12:36).
control-plane-api가 `/public/*`에 verify-email·reset-password·invite·sso-callback 결과 셸을 프레임워크·빌드
없이(=/internal/ops와 같은 규율) 정적 서빙하고, 공개 표면이라 응답마다 엄격한 CSP(`default-src 'none';
style-src 'self'` — script 전면 차단, inline script/style 없음)를 세우며 `pie://` 딥링크로 앱에 넘긴다. 셸은
쿼리스트링을 의도적으로 무시해 토큰을 읽지도 로그하지도 않는다(doc 16:21-22, 실제 토큰 검증·URL strip은
R3). **이메일 pipeline 셸:** 작업 큐 규칙에 따라 범용 framework를 만들지 않고, 이메일 발송 seam(타입 계약
`PieEmailSender` + 구조적 로그만 하는 dev no-op 구현, 실제 발송 없음)만 정의했다 — Pie는 초대·보안 경고
템플릿만 소유하고 Keycloak이 가입·확인·재설정을 소유하며(doc 17:126), 최종 형태는 큐 역학을 재사용하는
outbox 기반 이메일 job type이나 실제 SMTP·템플릿·영속 발송 큐는 R3에 온다. 테스트는 relocation(hot outbox
비워짐·dead-letter row 완결), 재큐→republish→realtime 전달, poison 격리(poison park가 healthy 전달을 막지
않음), dead-letter 메트릭, 새 table RLS 음성, 공개 페이지 CSP+inline script 부재, 이메일 seam 구조적 로그를
검증한다.

이로써 R2 **범위 코드 구현**은 종료 조건을 모두 실행형 증거로 닫았다: 버전 있는 Control Plane API와 request
correlation, PostgreSQL migration·테넌트 문맥 강제(RLS), Object Storage 테넌트 key·presign·격리 영역,
transactional outbox·작업 큐·멱등 소비자·dead-letter, 감사 append, Realtime Gateway 연결·재동기화 계약,
공개 인증 utility page 셸·이메일 발송 seam, 로그·메트릭·trace·기본 ops 대시보드. R2 범위에서 **deploy/ops
영역으로 남는 것**은 코드가 아니라 배포·운영 관심사다: OTel Collector/exporter·Grafana(observability
deploy profile), 실제 IdP(Keycloak) credential 흐름·SMTP·이메일 템플릿(R3), WAL/PITR·custom-format
백업(ops), instance discovery·connection profile 자동 연결, SeaweedFS/reverse proxy compose `core` profile
배포. artifact multipart·삭제·quarantine·download presign과 실제 authn(WS/REST org stand-in 대체)은 R3
이후 기능 slice로 남는다.

## R3: 인증·RBAC·Entitlement

### 목표

모든 후속 기능이 재사용할 사용자·조직·세션·권한·제품 사용권을 완성한다.

### 범위

- Keycloak realm·client와 Pie issuer·subject mapping
- 시스템 브라우저 PKCE 기반 소유자 가입, 이메일 확인과 조직 생성
- Keycloak 이메일·비밀번호 로그인, 재설정과 로그아웃
- Main access token 메모리 보관과 refresh token 회전
- MFA, 복구 코드, 기기·세션 조회·폐기
- 내부 직원·고객·협력사 초대와 수락
- 조직 선택과 계정 생명주기
- Role, Permission, MembershipRole, ResourceGrant
- 기본 거부와 permission 판정 설명
- ProductPlan, Subscription, Entitlement, UsageMeter
- 역할·grant·세션·entitlement 변경 이벤트와 캐시 무효화
- 관리자 권한 미리보기와 감사

Passkey는 기본 OIDC 로그인 완료 후 같은 단계에서 추가한다. 외부 SAML·OIDC broker와 SCIM은
엔터프라이즈 고객이 필요한 시점까지 계약과 비활성화 테스트를 준비하되 R9에서 운영 완성도를
높인다.

### 첫 사용자 수직 흐름

`앱 설치 → 소유자 가입 → 이메일 확인 → 조직 생성 → 직원 초대 → 역할 부여 → 직원 로그인 →
세션 폐기`를 실제 메일과 Electron 앱으로 완료한다.

### 종료 조건

- 내부 사용자와 고객 사용자가 같은 앱에서 서로 다른 권한으로 로그인한다.
- 다른 조직·고객 ID를 직접 요청해도 API, IPC, Runtime에서 거부된다.
- 역할·세션 폐기가 Main, Runtime, Realtime의 다음 요청부터 반영된다.
- entitlement 부족과 permission 거부가 다른 오류와 감사 이벤트를 만든다.
- 마지막 소유자, 계정 연결, 초대 재사용, refresh token 재사용 공격을 차단한다.

## R4: 프로젝트·업무 포털

### 목표

개인과 회사 조직이 Team, Initiative와 Project를 만들고 중앙 `WorkItem`을 기준으로 업무를
계획·배정·검토한다.

### 범위

- 가입 시 personal Organization과 회사 Organization 전환
- personal 기본 Team과 회사 Team·TeamMembership
- Team별 WorkItem identifier와 versioned 실행 Workflow
- 프로젝트 생성·조회·수정·보관과 소유 조직
- cross-team Project, Initiative와 Milestone
- 고객·수행·협력·감사 참여 조직 관계
- 프로젝트 멤버, 역할과 리소스 grant
- WorkItem, 하위 작업, 참여자, 담당자, 의존성, 완료 조건
- 목록·칸반, 사용자 정의 상태와 versioned 상태 전이
- My Work, 빠른 생성, 오른쪽 WorkItem 상세 panel
- Team Cycle, capacity projection과 rollover proposal
- 고객 요청·외부 issue·미할당 AI 세션을 받는 Intake
- 권한 인식 Filter·Group·Sort와 SavedView
- versioned ProjectUpdate와 내부·고객 공개
- 최소 Workflow와 내부 검토·승인
- 프로젝트 활동 타임라인과 감사 이벤트
- `unassigned_agent_session` Intake source의 빈 상태와 assign 계약
- 권한 인식 목록·검색과 로컬 SQLite cache
- 외부 Jira·Linear·GitHub·GitLab reference의 단방향 읽기 연결

Team Workflow, Initiative, Cycle, Intake, SavedView와 ProjectUpdate의 의미는
[프로젝트 실행 모델](./27-project-execution-model.md), 구현 issue와 gate는
[R4 프로젝트 포털 Backlog](./28-r4-project-portal-backlog.md)를 따른다.

### 내부 구현 Gate

- `R4 Core Gate`: Team → Project → WorkItem → My Work → Board → Workspace open request
- `R4 Planning Gate`: Cycle → Initiative/Milestone/Update → Intake → SavedView

R5의 첫 AI Workspace 수직 흐름은 R4 Core Gate 이후 시작할 수 있다. 외부 알파는 R4 Planning Gate와
R5 완료 조건을 모두 요구한다.

### 수직 흐름

`개인 또는 회사 조직 선택 → Team → 프로젝트 생성 → 멤버 초대 → 업무 생성·배정 → 칸반 이동 →
검토·완료`

### 종료 조건

- 개인과 회사 공간이 같은 Project·WorkItem API를 사용하고 tenant 경계를 우회하지 않는다.
- Team Workflow와 Project Delivery Workflow가 서로 다른 상태와 permission으로 동작한다.
- 고객·협력사·내부 사용자가 허용된 프로젝트·업무·필드만 조회한다.
- WorkItem과 Worktree·Workspace·orchestration task의 ID와 상태가 분리된다.
- 네트워크 중단과 multi-device 수정 후에도 상태 변경이 멱등하고 충돌을 숨기지 않는다.
- project·workflow version 변경과 외부 issue mapping이 기존 업무 이력을 다시 쓰지 않는다.
- 사용자 행위가 correlation ID와 활동·감사 이벤트로 연결된다.
- Initiative의 수동 Project 구성과 SavedView의 동적 결과가 구분된다.
- Intake accept가 WorkItem 생성·source binding과 함께 멱등 transaction으로 처리된다.
- ProjectUpdate가 내부·고객 visibility와 revision을 보존한다.

## R5: AI 실행 추적과 개발 Workspace

### 목표

프로젝트 업무에서 Workspace와 Claude Code·Codex를 열고 실행 과정과 산출물을 업무 타임라인으로
되돌리는 Pie의 핵심 흐름을 완성한다.

### 범위

- 업무에서 native, WSL, SSH Workspace와 Worktree 생성
- 서명된 ExecutionContext와 유효 시점이 있는 SessionBinding
- Claude Code·Codex 우선 Agent Hook과 provider transcript reconciler
- source·assertion·sequence가 있는 AgentEvent envelope
- Node 내장 SQLite outbox, cursor, quota, item ack와 재전송
- packaged Electron/Runtime의 SQLite 수정 버전 확인과 single-writer/checkpoint 정책
- Control Plane agent event ingest와 session·turn timeline projection
- 파일 변경, Artifact, commit, PR·MR, test·build 결과와 provenance
- 미할당 세션 검색, 사용자 assign·재분류와 감사
- project capture mode, 기록 표시·pause, local/server redaction
- turn·tool output·Artifact별 내부·프로젝트·고객 visibility
- local `stdio` Pie MCP의 project·work item·artifact 도구
- agent run, Workspace, WorkItem, Workflow 상태의 분리
- provider·app·Runtime protocol version과 capability degradation

### 수직 흐름

`프로젝트 업무 → Workspace에서 열기 → Claude Code·Codex → prompt·tool·변경 수집 → 테스트·PR →
Evidence 검토 → 업무 완료`

### 종료 조건

- Hook 누락, 앱 재시작, transcript compaction과 network 중단 후 timeline을 복구하거나 gap을 표시한다.
- event replay와 upload 응답 유실이 session·turn·Artifact를 중복 생성하지 않는다.
- 같은 path의 native·WSL·SSH project와 재개 session을 잘못 연결하지 않는다.
- 권한 회수 후 offline outbox가 민감 데이터를 업로드하지 않는다.
- 내부 prompt와 제한 tool output이 고객 Evidence와 검색 결과에 노출되지 않는다.
- agent의 완료 주장만으로 WorkItem이나 Workflow 승인을 완료하지 않는다.
- Git 2.25와 GitHub·GitLab·지원 공급자의 commit·review 흐름을 검증한다.
- [AI 프로젝트 포털 구현 위험](./20-ai-project-portal-risk-register.md)의 P0 이슈가 모두 닫힌다.

## 첫 외부 알파

R0부터 R5까지 완료한 뒤 개인 사용자와 제한된 내부 조직으로 알파를 진행한다.

- 하나의 cloud 리전
- Keycloak 이메일·비밀번호·MFA를 시스템 브라우저 OIDC로 제공
- 프로젝트·WorkItem·Workspace·Claude Code·Codex·Artifact 흐름
- metadata-only와 full capture 정책, 미할당 세션과 권한별 timeline
- 수동 운영 가능한 범위의 entitlement
- 백업 복원, 감사 조회, 진단 번들, 강제 세션 폐기

알파에서 검증할 핵심은 메뉴 수가 아니라 업무에서 agent를 시작해 검토 가능한 산출물을 얻는 시간,
세션 자동·수동 연결 정확도, event 누락·중복률, 권한 거부 정확도와 사용자가 기록 정책을 이해하는지다.

## R6: CRM·계약·SI 프로젝트 수행

### 범위

- 영업기회, 견적, 계약, 변경 계약
- 고객사, 사업장, 담당자와 고객 360도
- 계약에서 프로젝트·SLA 생성
- WBS, 마일스톤, 간트, 기준선
- 요구사항과 추적 매트릭스
- 변경요청과 고객 승인
- 인력 배정, 계획·실제 MM, 자원 가동률
- 산출물, 테스트, 결함, 검수
- 프로젝트 위험·의사결정·상태
- 서비스 티켓, 담당자, SLA, 공개 답변과 내부 메모
- 티켓에서 기존 R5 Workspace·AgentSession 흐름 재사용
- 기존 Jira·Redmine·CSV import dry-run

### 종료 조건

- 계약 범위와 변경 범위를 구분하고 승인 전 실행을 제한한다.
- 요구사항이 작업, 코드, 테스트, 산출물, 검수까지 추적된다.
- 계획 대비 일정·공수·비용과 인력 과투입을 조회한다.
- import 재실행이 프로젝트·사용자·작업을 중복 생성하지 않는다.

## R7: 협업·회의·지식·자동화

### 범위

- 고객·프로젝트·티켓 채널과 1:1 메시지
- 내부 메모와 고객 공개 메시지 분리
- 화상회의, 화면 공유, 자막, 녹화 동의
- 녹화·전사·AI 회의록
- 지식베이스와 권한 인식 검색
- 해결 티켓과 원격 세션의 지식화
- 승인형 Runbook과 작업 큐
- AI 모델·도구 entitlement, quota, 평가, prompt injection 방어

### 종료 조건

- 대화와 회의 결과가 프로젝트·티켓 문맥에 보존된다.
- 권한 회수가 메시지·문서·전사·검색 색인에 반영된다.
- AI 문서는 출처와 검토 상태를 가지며 모델 출력이 승인을 대체하지 않는다.
- Runbook은 대상·권한·승인·결과·롤백이 감사된다.

## R8: 서비스 데스크·원격지원·자산

### 범위

- Edge Agent 등록, 인증서 회전·폐기, 서명 업데이트
- 고객 자산과 서비스 관계
- 인벤토리, 상태, 모니터, 경고
- `cli-relay` room·participant·driver 개념과 Orca host proof·E2EE를 결합한 감사된 Relay·원격 terminal
- Control Plane 동의, 단기 capability, 조작권 전달·회수
- 검증된 원격 데스크톱 엔진 통합
- Windows UAC, macOS TCC, Linux Wayland·X11 처리
- 파일 전송, 클립보드, 다중 모니터, 세션 녹화
- 무인 접근, 재부팅 후 재연결, 고객 긴급 중지
- 경고에서 티켓과 Runbook 연결

### 종료 조건

- 고객 장비가 outbound 연결과 장비별 신원으로 등록된다.
- 보기·조작·파일·승격 권한이 서버와 Agent에서 강제된다.
- Agent 폐기와 인증서 유출 탐지가 새 연결을 차단한다.
- 지원 플랫폼별 권한 부족과 기능 저하가 안전하게 표시된다.
- 모니터링 경고가 서비스·자산이 지정된 티켓으로 이어진다.

## R9: 재무·연동·엔터프라이즈 완성

### 범위

- 시간 승인, 직원·협력사 원가, 계약별 청구 후보
- 프로젝트·고객 수익성과 경영 보고서
- 회계·ERP·전자서명 연동
- 공개 API, Webhook, rate limit, 멱등 재전송
- SAML, SCIM, 조직 도메인과 정기 접근 검토
- 데이터 내보내기, 삭제·익명화, 법적 보존
- 온프레미스 설치·업데이트·백업
- 다국어, 접근성, 엔터프라이즈 배포 검증
- 사용량 기반 entitlement와 계약 종료 정책

### 종료 조건

- 프로젝트의 계획·실제 매출과 원가를 과거 단가 기준으로 재현한다.
- 고객용 보고서와 내부 수익성 데이터가 권한으로 분리된다.
- SCIM 비활성화가 세션·grant·API 자격증명을 정해진 시간 안에 폐기한다.
- API·Webhook·회계 연동의 장애와 중복이 재무 결과를 중복 반영하지 않는다.
- 테넌트 내보내기·삭제와 온프레미스 복구를 운영 절차로 재현한다.

## 공통 릴리스 게이트

### 보안

- 위협 모델과 사용자·서비스·기기 신원 검토
- 역할·리소스·entitlement 허용·거부 행렬
- 고객·협력사·게스트의 테넌트 경계 침투 테스트
- Electron CSP, sandbox, IPC, navigation, Fuses 검증
- SBOM, 의존성·비밀 스캔, 코드·업데이트 서명

### 호환성과 복구

- macOS, Windows, Linux
- native, WSL, SSH, Relay, Edge Agent
- 현재와 최소 지원 앱·Runtime·Relay 버전
- 네트워크 중단, 작업 재시도, 이벤트 중복·순서 변경
- 로컬 DB·서버 schema 마이그레이션과 롤백
- 백업 restore drill과 정의된 RPO·RTO

### 품질과 운영

- 로그·메트릭·trace와 correlation ID
- SLO, 경보, Runbook, 진단 번들
- 대용량 터미널·파일·녹화 backpressure
- 키보드, 스크린리더, 한글 IME, 시간대
- 감사 이벤트 완전성과 민감정보 마스킹
- 고객 데이터 삭제·보존·검색 색인 반영

## 바로 시작할 개발 순서

1. 현재 Electron 창·preload·IPC·Runtime·Relay 경계를 목록화한다.
2. KROOT 기능을 source·domain·API·persistence·auth·test 상태로 나눈 capability inventory를 만든다.
3. 확정된 Keycloak, Fastify와 contract-first ADR을 executable schema와 fixture로 옮긴다.
4. Project·WorkItem·ExecutionWorkspace·AgentSession의 ID와 수명주기를 확정한다.
5. ExecutionContext, SessionBinding, AgentEvent envelope와 protocol capability 타입을 만든다.
6. capture mode, visibility, retention, deletion과 project role의 위협 모델을 확정한다.
7. 기존 Workspace 회귀 fixture와 Orca 프로필·project ID 마이그레이션 fixture를 만든다.
8. Main session broker와 안전한 preload·local MCP 계약을 구현한다.
9. 테넌트 문맥, 감사 outbox, agent event ingest와 trace가 있는 최소 Control Plane을 세운다.
10. 조직 가입·초대 후 프로젝트와 WorkItem 칸반까지 수직 구현한다.
11. WorkItem에서 Claude Code·Codex Workspace를 열고 Hook·transcript·Artifact를 동기화한다.
12. P0 위험과 native·WSL·SSH, online·offline 조합 E2E를 통과한 뒤 외부 알파를 시작한다.

화상회의, 전체 CRM, 재무, 감사된 Relay 원격지원, 원격 데스크톱 엔진, 다중 리전은 이 순서를
앞당기지 않는다.
첫 번째 기술적 성공 기준은 화면 수가 아니라 인증된 한 사용자의 요청이 안전한 IPC와 테넌트 API,
감사 이벤트를 통과하고 Claude Code·Codex 실행 결과와 함께 원래 WorkItem에 반영되는 것이다.
