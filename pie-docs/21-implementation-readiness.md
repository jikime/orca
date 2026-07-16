# 구현 준비도와 문서 운영

## 결론

Pie의 제품 범위, 핵심 도메인, 단계별 우선순위와 주요 위험은 구현 논의를 시작할 수준으로 정리되어
있다. 그러나 모든 구현 결정을 완료한 상태는 아니다. 현재 문서는 다음 작업에는 사용할 수 있다.

- R1 Electron 보안 경계와 Runtime 계약의 상세 설계
- R2 Fastify Control Plane 골격과 테넌트 저장소의 기술 검증
- R3 Keycloak 인증·Pie RBAC의 수직 흐름 구현
- R4~R5 Project → WorkItem → AI 실행 → Artifact 흐름의 schema·prototype 작성

외부 알파나 운영 배포는 아직 시작하면 안 된다. 이 문서에서 `결정 필요`로 분류한 항목과
[위협 모델](./24-security-threat-model.md), [검증 매트릭스](./25-verification-test-matrix.md)의 P0 gate가
먼저 닫혀야 한다.

## 문서 상태 분류

| 상태      | 의미                                            | 구현 사용법                              |
| --------- | ----------------------------------------------- | ---------------------------------------- |
| 기준      | 제품·도메인·보안의 기본 방향으로 채택           | 변경 시 ADR과 영향 분석 필요             |
| 계약 초안 | schema와 실패 의미가 있으나 코드 fixture가 없음 | contract test와 함께 구현                |
| 결정 필요 | 공급자, 라이브러리, 운영 조건이 미확정          | spike 또는 ADR 승인 전 종속 구현 금지    |
| 확장      | 현재 단계의 필수 경로가 아님                    | 인터페이스만 보존하고 후속 단계에서 구현 |

문서에 미래 기능이 적혀 있다는 이유만으로 구현 완료 또는 기술 채택으로 간주하지 않는다. 실제
완료 여부는 코드, migration, 자동화 테스트와 운영 Runbook을 함께 확인한다.

## 준비도 감사

| 영역                    | 현재 상태        | 근거                            | 남은 산출물                                          |
| ----------------------- | ---------------- | ------------------------------- | ---------------------------------------------------- |
| 제품 범위·사용자        | 기준             | `00`, `01`, 기능별 문서         | 초기 사용자 인터뷰와 사용량 가정                     |
| 프로젝트 실행·AI 도메인 | 기준             | `13`, `19`, `27`                | `28` backlog의 TypeScript schema와 migration         |
| 단계·의존성             | 기준             | `14`                            | 단계별 issue와 담당자                                |
| 인증·RBAC               | R0 계약 기준선   | `01`, `ADR-0009`, manifest      | R3 provisioning·정책 실행 테스트                     |
| Electron·Runtime 경계   | R0 계약 기준선   | `12`, `16`, IPC·Runtime schema  | R1 Main·preload 구현과 보안 E2E                      |
| API·이벤트·동기화       | R0 실행 계약     | `23`, OpenAPI·AsyncAPI·fixture  | R2 server validator와 generated client               |
| 위협 모델·개인정보      | 계약 초안        | `20`, `24`                      | 데이터 흐름도 review와 처리 근거 승인                |
| 테스트·호환성           | R0 gate 기준선   | `25`, security·support manifest | 단계별 CI job과 fault harness                        |
| KROOT 이관              | R0 manifest 고정 | `26`, source baseline           | 기능별 테스트 추출과 데이터 이관 spike               |
| Control Plane 기술      | 기준             | `22`, `32`, `ADR-0008`          | framework skeleton, 배포·비밀 관리 구현              |
| Relay·원격지원          | 계약 초안        | `07`, `32`, `ADR-0011`          | `cli-relay` 보안·프로토콜 fixture와 Go service spike |
| 화상회의·원격 데스크톱  | 일부 기준        | `07`, `08`, `ADR-0011`          | LiveKit contract, 원격 데스크톱 엔진 prototype       |
| 온프레미스·과금         | 확장             | `10`, `17`                      | 계약 요구와 운영 topology                            |

## 문서의 권위 순서

같은 항목이 충돌하면 다음 순서로 해결한다.

1. 승인된 ADR과 버전이 고정된 schema
2. 보안·데이터·호환성 계약 문서
3. 제품 기능 문서와 로드맵
4. 화면 설명과 prototype
5. 외부 저장소의 기존 구현

KROOT와 Orca의 기존 코드는 중요한 근거이지만 Pie의 중앙 도메인 계약보다 우선하지 않는다. 기존
동작을 바꾸는 경우에는 회귀 fixture를 만들고 의도한 변경을 ADR에 남긴다.

## R0에서 만들어야 할 저장소 산출물

문서만으로 R0를 완료하지 않는다. 구현 브랜치에는 다음 파일 계층을 추가한다.

```text
contracts/
├── openapi/pie-control-plane-v1.yaml
├── asyncapi/pie-realtime-v1.yaml
├── schemas/{common,discovery,events,resources,ipc,runtime,mcp}/
├── fixtures/{valid,invalid,compatibility}/
├── manifests/
│   ├── {permissions,roles,entitlements,capabilities}.json
│   ├── {protocol-support,error-codes,mcp-tools}.json
│   └── {security-gates,support-matrix,source-baselines,kroot-capability-migration}.json
└── scripts/{contract-file-io,schema-fixture-verification,wire-spec-verification,
             manifest-verification,verify-contracts}.mjs

docs/adr/
├── 0003-local-sqlite-outbox.md
├── 0004-tenant-enforcement.md
├── 0005-control-plane-persistence.md
├── 0006-object-storage-boundary.md
├── 0007-instance-discovery-and-connection-profiles.md
├── 0008-control-plane-modular-monolith.md
├── 0009-identity-provider-and-application-authorization.md
├── 0010-contract-first-wire-specifications.md
└── 0011-self-hosted-platform-dependencies.md
```

경로와 권위 규칙은 [Contract Specification과 변경 관리](./33-contract-specification-governance.md)에서
확정한다. 서버, Electron Main과 Runtime은 같은 versioned schema와 fixture를 사용하고 Renderer는 서버
DTO나 인증 토큰을 직접 소유하지 않는다.

## R0 구현 결과

2026-07-15 기준 `feat/pie-r0-contracts` 브랜치에는 JSON Schema 59개, fixture 49개, HTTP operation
18개, Realtime message 7개, MCP tool 6개와 P0 threat gate 38개가 있다. `pnpm check:contracts`는 root
lint에 포함되어 schema·fixture·wire spec·manifest 간 drift를 차단한다. KROOT·Orca·`cli-relay` 기준
commit과 OS·host·Git·provider release gate도 manifest에 고정했다.

R0 완료는 이 기능들이 동작한다는 뜻이 아니다. Electron 보안·IPC 실행 증거는 R1, server validator와
generated type drift는 R2, 실제 RBAC allow·deny와 세션 정책은 R3, provider parser fixture와 Relay 보안
E2E는 각각 R5와 R8의 gate다.

### R1 기반 계약 진행

2026-07-16 기준 Session Broker, `pie:session:*` IPC, preload session API와 Runtime 1.0 capability
handshake가 구현됐다. R0 JSON Schema fixture를 TypeScript 소비 계약 테스트에서 그대로 검증하고,
stale window·webview·subframe·잘못된 protocol·session context·token-bearing response를 거부한다.
기존 Workspace의 `session:*` 채널은 호환성을 위해 변경하지 않았다.

두 번째 slice에서는 packaged app의 `pie` scheme과 `pie://auth/callback` Main-only broker를 추가했다.
macOS `open-url`, 최초 command line과 Windows·Linux `second-instance`가 같은 strict parser를 사용한다.
route 정규화, 중복·미등록·만료·재사용 state, 여러 Pie URL, token query와 알 수 없는 parameter를
거부하며 callback URL 자체는 진단 로그에 남기지 않는다. broker는 아직 실제 IdP와 연결하지 않았고
R3의 Authorization Code + PKCE 흐름이 pending state와 code 교환 handler를 등록한다.

세 번째 slice에서는 Main 전용 OS 보안 저장소를 추가했다. `SessionSecretStore`가
instance·profile·account scope로 refresh token만 암호화 저장하고, 가용성 정책이 macOS
Keychain·Windows DPAPI·Linux Secret Service만 허용하며 `basic_text`는 거부한다. 테스트는 평문
token이 디스크·broker 이벤트·console에 남지 않음, ciphertext 손상 폐기, scope 격리(대소문자·경로
탈출 포함), backend별 degrade를 검증한다. R3 인증 흐름이 `PieSessionTokenLifecycle`의 로그인·rotation
·로그아웃 handler에 code 교환 결과를 연결한다.

네 번째 slice에서는 ELC-005 패키지 강화를 추가했다. electron-builder `electronFuses`로 사용하지
않는 fuse(NODE_OPTIONS·NODE_EXTRA_CA_CERTS·`--inspect`)를 끄고 cookie 암호화·ASAR
integrity·`onlyLoadAppFromAsar`를 켜되, CLI 런처와 forked daemon이 의존하는 `runAsNode`와 `file://`
renderer가 의존하는 `grantFileProtocolExtraPrivileges`는 유지한다. ASAR integrity는 macOS·Windows만
강제하고 Linux는 수용된 gap이다. renderer `index.html`에 production strict CSP(`'unsafe-eval'` 없음)를
넣고 dev origin은 serve 전용 플러그인이 주입하며, 메인 BrowserWindow의 `contextIsolation`·
`nodeIntegration`을 명시적으로 고정했다. `verify:packaged-security`가 flipped fuse wire·Info.plist
`ElectronAsarIntegrity`·`codesign --verify --strict`·app.asar 레이아웃을 검사해 ELC-005
`fuse-asar-signature-gate` 증거를 만든다. fuse·CSP 결정 로직은 단위 테스트로 검증하고, 실제 서명
인증서 gate와 프로필 migration dry-run·안전 모드는 후속 slice로 남는다.

다섯 번째 slice에서는 기존 Orca 프로필 감지·백업·마이그레이션 dry-run을 Main 전용으로 추가했다.
감지는 주입된 userData 경로를 읽기 전용으로 조사해 새 설치·legacy 단일 프로필·multi-profile을
분류하고 프로필별 파일 인벤토리와 손상 index의 `.bak` 복구, schemaVersion을 기록한다. 백업은
프로필 데이터만 `pie/migration-backups/{runId}`에 복사하고 암호화 자격증명 저장소와
`orchestration.db`는 excluded로만 manifest에 남기며 manifest를 마지막에 써 중단된 스냅샷을 폐기
가능하게 한다. dry-run은 provisional target projection 대비 create·merge·conflict·missing·
sensitive-device-only를 계획하되 데이터를 이동하지 않고, report는 경로·개수만 담아
`writeSecureJsonFile`로 저장하며 idempotent하다. 테스트는 감지 분기, 시크릿 미복사(session-secrets
bytes 부재), 경로 탈출 방어, 항목별 개수, 두 실행의 report 동일성, canary token이 report·manifest에
남지 않음을 검증한다. 표시명이 아닌 안정 id에서 경로를 파생하는 중앙 `pie-product-identity` 계약이
매핑을 고정한다. 아직 renderer·IPC 노출이 없고, 실제 cutover·안전 모드와 마이그레이션 데이터 노출
전용 threat-model gate(위협 모델 P1 Backup 행에 매핑)는 후속 작업으로 남는다.

여섯 번째 slice에서는 안전 모드 메커니즘과 연결 진단 번들 확장을 Main 전용으로 추가했다. schema-versioned
크래시 버스트 마커가 연속 실패한 시작을 세어 기본 3회 뒤 다음 launch를 안전 모드로 부팅하고,
`--safe-mode`·`PIE_SAFE_MODE`로 강제할 수 있으며, 정상 시작이나 버전 변경 시 초기화된다. 결정은 순수
함수, 프로세스 상태는 Main에서 한 번 정해진 뒤 읽기 전용이라 어떤 IPC도 이를 변경해 서브시스템 보안을
끌 수 없다. `guardStartupService`가 first-window seam에서 터미널 daemon과 agent hook server 시작을
건너뛴다. 진단 번들에는 `pie-connection-diagnostics` 수집기가 안전 모드·세션 status/instanceId·보안
저장소 가용성·daemon liveness·앱/Electron/platform을 status 수준으로만 담은 4-way 섹션을 provider
seam으로 실어 보내고, server-mode redactor로 다시 스크럽하며 consent·preview·upload 흐름은 바꾸지
않는다. 테스트는 마커 지속성·버스트 임계·버전 초기화, 결정 매트릭스, guard seam, 수집기 shape,
canary token redaction, 번들 size cap을 검증한다. on-demand agent runtime·Pie Runtime handshake
gating과 안전 모드 UX, 업데이트 실패→안전 모드 명시 배선은 known gap으로 남는다.

### R2 기반 계약 진행

2026-07-17 R2 첫 slice로 독립 `platform` pnpm 워크스페이스(자체 lockfile, 루트 미오염)와 PostgreSQL
테넌트 저장소 기반을 구현했다. `packages/persistence`는 SQL-first 동결 migration runner(checksum freeze +
advisory lock), 고정 schema(identity·operations·audit), 역할(`pie_migration_owner`·`pie_app`
NOBYPASSRLS·`pie_worker`)와 `organizations`·`outbox_events`(doc 30 :330-341 컬럼·partial claim index)·
`idempotency_records`·append-only `audit_events`를 만든다. RLS는 permissive isolation + restrictive
guard + FORCE에 `SET LOCAL` 테넌트 문맥을 더하고, 앱 코드는 `withTenantTransaction`으로만 테넌트
table에 접근한다. Worker는 BYPASSRLS 없이 전용 grant로 cross-tenant claim만 한다. `control-plane-api`·
`control-plane-worker`는 Fastify 5 부팅·healthz/readyz·traceparent correlation·RFC 9457·Ajv2020 소비까지만
하고 업무 로직·claim 루프는 slice 2다. 통합 테스트는 testcontainers 실 PostgreSQL 16에서 migration 적용,
RLS 부정(테넌트 격리·문맥 부재 default deny·worker 권한 경계), 시드 idempotency, checksum 동결을
검증한다(Docker 부재 시 명시적 SKIP). DTO는 openapi-typescript로 생성하되 contracts의 원격 `$id`
상호참조를 로컬로 dereference하는 prepass가 필요했다(보고서 open risk). 실제 조직 mutation의
DB→outbox→Worker→Realtime 수직 흐름, Object Storage, dead-letter, 백업 restore는 후속 slice로 남는다.
`platform` 경로가 doc 30 :429의 stale `services/control-plane` 경로를 대체한다.

2026-07-18 두 번째 slice로 outbox 수직 흐름을 구현했다. `updateOrganizationDisplayName`이 한 transaction에
org version·audit·outbox·operation을 함께 쓰고(원자성, 실패 시 부분 row 없음), outbox는 CloudEvents 1.0
envelope다. publish 시 `operations.stream_cursors` 원자적 upsert로 org별 단조 sequence를 매기고
published_at·NOTIFY와 한 transaction이라 gap이 없다. Worker 루프는 `FOR UPDATE SKIP LOCKED` + lease로
claim하고 published_at 재확인으로 exactly-once publish, backoff 재시도, 예산 초과 시 `parked_at` dead-letter
parking을 한다(전달은 at-least-once + client cursor idempotent apply). Realtime gateway는 control-plane-api
module로 ClientHello/Welcome/Heartbeat/ResourceChanged/ResyncRequired를 처리하고 Worker→gateway는
Postgres LISTEN/NOTIFY pointer + DB envelope fetch + 재연결 catch-up이다. `listResourceChanges`(REST)가
cursor 기반 복구 권위자이고 `getOperation`·`listOrganizations`도 구현했다. 테스트는 실 PostgreSQL + WS
클라이언트로 원자성·동시 exactly-once·전달·cross-tenant 격리·재연결 delta·resync→`/changes` 수렴을
검증한다. WS org 식별은 아직 hello/헤더 authn stand-in(R3에서 token subject로 대체), Electron 배선(slice 2b),
dead-letter table·Object Storage·백업은 후속으로 남는다. DTO 생성기의 원격 `$id` dereference prepass는
그대로 open risk다.

2026-07-18 slice 2b로 Electron(Main) Realtime 클라이언트를 root 저장소에 추가해 "Electron에 Realtime 전달"
종료 조건을 닫았다. `src/shared/pie-realtime-contract.ts`가 AsyncAPI 7개 메시지를 zod(inbound passthrough
/outbound strict)로 옮기고 R0 fixture(valid·unknown-optional·invalid)를 기존 계약 테스트와 동일하게 검증한다.
`src/main/pie-realtime/`는 기존 `ws` 의존성을 재사용한 Main 전용 클라이언트로 ClientHello→Welcome→Heartbeat
pong, 전 inbound zod 검증(무효 시 dispatch 없이 close+재접속), backoff+jitter 재접속, heartbeat timeout,
cursor dedupe(at-least-once), ResyncRequired→`resync-needed`+주입 fetchChanges(REST)로 수렴을 처리한다.
연결은 dev-gated(`PIE_REALTIME_URL`), production 자동 연결 없음, 안전 모드 시 미연결(`pie-realtime`을
`SAFE_MODE_GATED_SUBSYSTEMS`에 추가). renderer 노출 없음, 유일 외부 표면은 `pie-connection-diagnostics`
schemaVersion 2의 `realtime` subsection. 테스트는 in-process `ws` mock 서버로 lifecycle 전반을 검증한다.
renderer 노출·instance connection profile·실제 authn·커서 영속화는 이후 slice로 남는다.

2026-07-19 slice 3으로 Object Storage 어댑터와 artifact 업로드 수직 흐름을 추가했다.
`packages/object-storage-adapter`는 S3 호환 클라이언트(presign PUT·HEAD)와 조직 바인딩 tenant key
빌더(`org/{org}/{zone}/{objectId}`, 다른 조직 key 생성 API 부재로 cross-tenant 구조적 차단)를 제공한다.
`agent` schema에 objects·immutable artifact_revisions(append-only)·artifacts와 upload_sessions를 tenant
RLS로 두고, `createArtifactUploadIntent`(Idempotency-Key 멱등, 같은 key+payload replay/다른 payload 409,
localPath는 additionalProperties:false로 거부)와 `finalizeArtifactUpload`(HEAD 검증 후 revision+object
available+artifact available+audit+outbox를 한 tenant tx)를 구현했다. finalize outbox는 artifact
resource-change라 slice 2의 Worker→Realtime 경로가 `artifact.created`를 새 plumbing 없이 전달한다.
통합 테스트는 실 PostgreSQL + 실 S3(SeaweedFS 우선, 불안정 시 MinIO fallback; production/dev 기본은
SeaweedFS)로 key 격리·presign 왕복·intent 멱등·finalize 원자성+WS 실시간·localPath 거부·cross-tenant
finalize 404를 검증한다. multipart·object 삭제·quarantine scan·download presign·backup은 후속으로 남는다.

2026-07-19 slice 4로 백업·복원 연속성과 앱 최소버전·capability 게이팅을 추가해 R2의 남은 두 종료
조건을 닫았다. `database-backup.ts`는 논리 백업 driver(pg 도구를 postgres 컨테이너 내부에서 실행 —
host pg_dump major mismatch 위험 회피; `pg_dumpall --roles-only --no-role-passwords` + plain SQL
`pg_dump`). 복원 스모크는 컨테이너 A(2 tenant + org 수직 + publish + artifact intent/finalize) 백업→새
컨테이너 B 복원→migration checksum·row 수·audit 연속성·복원 DB RLS 강제·stream_cursors 일관성(재개
publish가 다음 시퀀스로 이어감)을 검증하고, P1 Backup을 canary로 확인(백업에 평문 secret 부재, audit
digest만, globals에 PASSWORD 없음). custom-format+WAL/PITR은 ops로 deferred. `GET /.well-known/pie`를
config 기반 정직한 값으로 서빙하고 contract 검증한다. 클라이언트 버전 평가기는 `src/shared/
pie-instance-discovery.ts`(Electron repo) 순수 함수로 supported/limited/needs-update를 분류하고 R0
discovery fixture + old/current/future 버전으로 세 상태를 검증한다. observability 대시보드·dead-letter
일반화·공개 인증 페이지는 후속으로 남는다.

2026-07-19 slice 5로 관측성과 end-to-end trace 종료 조건을 닫았다. **판독:** OTel은 observability deploy
profile(Collector+backend)이라 앱은 W3C traceparent 전파 + 구조적 pino 로그 + JSON 메트릭만 정직히
구현하고 OTel exporter는 후속. traceparent가 mutation/finalize→audit trace_id + outbox CloudEvents 봉투
확장 필드(doc 23:46)→Worker가 봉투에서 trace-id를 꺼내 구조적 로그→gateway가 DB 봉투에서 trace-id로
delivery 로그. `resource.changed`에 trace 필드가 없어 client 상관은 gateway까지(계약 미확장, 문서화).
worker는 pino 구조적 로그+주기 메트릭. API `GET /internal/metrics`(JSON: outbox published/pending/parked·
claim lag·realtime clients/delivered; outbox는 pie_worker cross-tenant 집계, 내용 미노출) + 빌드 없는
정적 `GET /internal/ops` 대시보드. e2e trace 테스트가 같은 trace-id가 audit·outbox 봉투·worker publish
로그·gateway delivery 로그에 나타남을 검증한다. dead-letter table·job queue 일반화·공개 인증 페이지는
후속 R2, OTel exporter/Grafana는 deploy profile로 남는다.

2026-07-20 slice 6으로 마지막 R2-범위 종료 조건(dead-letter table·작업 큐 일반화, 공개 인증 utility
page 셸·이메일 pipeline 셸)을 닫았다. **dead-letter:** doc 30에 전용 table이 없어 정직한 최소로
`operations.dead_letter_events`(outbox 봉투 전부 + park 사실 + 재큐 트레일, 표준 RLS)를 추가했다. parking은
in-place가 아니라 relocate — 예산 초과 row를 한 worker tx에서 dead_letter로 옮기고 hot outbox에서 삭제해
pending-claim index를 작게 유지하고 dead letter를 가시화한다(pie_worker에 outbox DELETE grant).
operator 재큐(UI 없음)는 attempt 0으로 outbox에 되돌리고 dead-letter row는 `status=requeued` 트레일로 남기며
감사 이벤트를 남긴다. `/internal/metrics`에 deadLetter 카운트 추가. **작업 큐 일반화:** outbox가 유일 소비자라
범용 framework 대신 SKIP LOCKED 역학만 추출했다(순수 재시도 정책 `queue-retry-policy` + table-agnostic 폴링
드라이버 `queue-polling-loop`, outbox가 첫 소비자, 새 job type이 재사용 — 투기적 추상화 금지). **공개 인증
셸:** credential 흐름은 Keycloak, Control Plane은 결과·랜딩·안내만 소유한다(doc 16:11-19). `/public/*`에
verify-email·reset-password·invite·sso-callback 결과 셸을 프레임워크 없이 정적 서빙하고 응답마다 엄격한
CSP(script 전면 차단·inline 없음)를 세우며 `pie://`로 앱에 넘긴다. 셸은 쿼리 토큰을 읽지도 로그하지도 않는다
(실제 토큰 검증은 R3). **이메일 셸:** 발송 seam(`PieEmailSender` 타입 + dev no-op 로그, 실제 발송 없음)만
정의했다 — Pie는 초대·보안 경고만, Keycloak이 가입·확인·재설정 소유(doc 17:126), 실제 SMTP·템플릿·발송 큐는
R3. 테스트는 relocation·재큐→republish→realtime·poison 격리·dead-letter 메트릭·새 table RLS 음성·공개 페이지
CSP·이메일 seam 로그를 검증한다. 이로써 R2 범위 코드 구현이 종료 조건을 모두 실행형 증거로 닫았고, 남는
것은 코드가 아니라 deploy/ops 관심사(OTel Collector·Grafana, 실제 Keycloak·SMTP, WAL/PITR, instance
discovery 자동 연결, compose `core` profile 배포)와 R3 이후 기능(artifact multipart·삭제·quarantine·download
presign, 실제 authn)이다.

2026-07-21 R3 시작. slice 1로 서버 identity 기반을 구현했다(platform+deploy, root 미변경). dev
Keycloak(`deploy/compose/dev-keycloak.yml` + realm import `pie-realm.json`: realm pie, PUBLIC
`pie-desktop`(secret 없음)·PKCE S256·loopback+`pie://auth/callback`·verifyEmail; realm 파일은 compose와
testcontainers 공용 단일 소스). identity migration: `user_accounts`(issuer+subject→user id, 비밀번호 없음),
`memberships`(org-scoped), role 어휘(`roles`/`permissions`/`role_permissions`/`role_manifest_seed`). RLS:
memberships는 표준 tenant isolation; **user_accounts는 global이라 공유-membership 조인 정책으로 cross-tenant
user 열거 차단**; role 어휘는 global read-only. **결정: manifest(roles.json+permissions.json)가 소스 오브
트루스, app 계층 검증·해석; seed loader가 DB로 checksum과 함께 물질화(self-contained+drift 검출, idempotent).**
jose로 Keycloak JWT 검증(JWKS·서명·issuer·audience·expiry, **issuer는 config 고정**), `requireAuthenticatedSubject`
/`tryAuthenticate` decoration. stand-in 라우트는 **이 slice에서 안 뒤집음(slice 3)**. 실사용 소비자
`GET /v1/session`(3상태; 멤버십 없는 검증 토큰=signed_out — 스키마에 org-less 없음)·`GET .../memberships`
(active 멤버만, 비회원 403). **소유자 provisioning**: email-verified subject로 UserAccount+Org+owner
Membership+audit+outbox를 한 Pie tx로 생성, issuer+subject 멱등(분산 tx 없음, ADR-0009 §12). **CONTRACT
GAP: OpenAPI에 provisioning operation 없음 → `POST /v1/provisioning`를 to-be-contracted 내부 라우트로 구현+
플래그(다음 contracts slice).** `organization.created` outbox는 slice-2 경로로 realtime 전달. **AUT-003
(`native-client-secret-absence-scan`) 종료**: realm이 pie-desktop을 public·secret 없음으로 표기하고 소스에
desktop client 결합 secret 부재를 검사하는 명명된 실행형 테스트. 실 Keycloak+실 Postgres 테스트로 토큰
accept/reject(tampered·expired·wrong-issuer·wrong-audience)·session 3상태·memberships cross-org·provisioning
멱등/1-tx/realtime·user 열거 차단·seed drift 검증. platform 97 tests green. slice 2가 Electron PKCE 수직을
이 기반에 연결한다.

2026-07-22 slice 2로 Electron 시스템 브라우저 OIDC/PKCE 로그인 수직을 구현했다(ROOT src/main·src/shared,
platform 미변경). **의존성 결정: root lockfile 무변경** — PKCE/state/nonce는 node:crypto, 토큰 호출은 fetch,
ID 토큰 검증도 jose 없이 `crypto.createPublicKey({format:'jwk'})`+`crypto.verify`(RS256/ES256). `src/main/
pie-auth/`: oidc-discovery(issuer 정확 일치·HTTPS/loopback origin 규칙 doc 31:134-135), pkce-authorization-
request(verifier 43–128·S256·state[broker 패턴]·nonce, authorize URL에 verifier 미포함), loopback-callback-
server(RFC 8252, 127.0.0.1:0 single-shot·state 검증·토큰 없는 페이지·timeout, 선호 모드), callback-channel
(loopback+pie:// 딥링크[R1 broker] fallback), token-exchange(code+refresh, public client secret 없음),
id-token-verifier(서명+iss+aud+exp+nonce, AUT-001), pie-auth-service(discovery→OIDC→채널→shell.openExternal
[webview 아님]→콜백→state→코드 교환→nonce→/v1/session+첫 로그인 /v1/provisioning→handleLoginSuccess;
만료 전 회전, 실패→session broker reauth_required; 로그아웃+end_session best-effort; 임시값 즉시 폐기).
realtime처럼 dev-gated(PIE_AUTH_DISCOVERY_URL, 자동시작 없음, 명시적 트리거), safe-mode에 `pie-auth` 게이트.
**access token은 Main 메모리, refresh token만 SessionSecretStore, renderer는 기존 broker IPC로만 세션 상태
(토큰키 금지).** 테스트: mock OIDC+mock 플랫폼으로 discovery 검증·PKCE·loopback(캡처/state 거부/timeout/토큰
없는 페이지)·실 broker 딥링크 fallback·토큰 교환/refresh/nonce·전체 흐름·회전·refresh 실패→reauth_required·
로그아웃·**refresh만 저장(canary)**·broker에 토큰 문자열 부재(canary). node 33 tests green, 회귀 pie-session/
safe-mode 50 tests green, typecheck(node+cli+web)·oxlint·check:contracts green, root lockfile 무변경.
오케스트레이터가 리뷰 후 실 Keycloak 교차 스모크. 남음: slice 3(stand-in 대체·RBAC), slice 4(초대·폐기).

2026-07-23 slice 3으로 **org stand-in 4곳을 모두 검증 토큰 subject+membership으로 교체하고 RBAC를 강제**
했다(platform+root). **RBAC 코어(순수 `permission-evaluator.ts`):** doc 01:215-231 순서 — membership active
→ 요청 org 일치 → 명시적 거부 우선 → 역할 permission(slice-1 catalog 해석), default-deny·거부 우선.
resource-grant 좁힘은 다음 authorization slice로 명시 연기(가짜 안 함). 결과+reason(permission vs 후속 entitlement
혼동 방지, doc 11). **거부 감사는 org FK 없는 보안 스트림 `audit.authorization_denials`에 기록**(privileged·
FK-free·best-effort) — 존재하지 않는/무관한 org id 거부도 FK 위반 없이 clean 403+감사(다른 조직 ID 직접
요청 공격이 500이 되지 않음). **TEN-006 matrix 테스트**
(evidence `permission-entitlement-combination-matrix`): 7역할×permission, cross-org·비활성·명시적 거부,
entitlement 축 stub 열. **stand-in 교체:** control-plane-routes(헤더 제거, op별 permission), artifact-routes
(principal=subject, artifact.publish), **realtime-gateway(ClientHello org 불신, WS bearer를 upgrade 헤더로
운반—ClientHello wire 미확장, Main 전용 ws라 헤더 자연스러움; 브라우저 클라이언트면 auth 필드 contracts
고려사항—verify+membership+org.read 후 구독)**, ROOT pie-realtime(stand-in 헤더 제거, auth lifecycle access
token을 주입 provider로 WS+REST resync에 bearer 전송, renderer 아님; `pie-auth-service.getAccessToken`+index
composition). **operator: `/internal/*`는 `PIE_OPERATOR_TOKEN` bearer 게이트(full-admin 전 interim), `/public/*`
는 의도적 공개 유지.** **CONTRACT GAP(재플래그): provisioning operation 미계약, ClientHello auth 필드 없음.**
테스트: RBAC matrix, 각 라우트 authorized/401/403+감사/cross-org, realtime WS 토큰+membership·거부·격리,
/internal operator 게이트, root changes-fetch bearer·헤더 부재·lifecycle 출처. platform 118 + root 100 tests
green, root lockfile 무변경. 남음: ResourceGrant narrowing·entitlement/UsageMeter(다음 authz slice), 초대·폐기
(slice 4).

2026-07-24 slice 4로 **초대 흐름 + 세션/토큰 폐기 전파**를 구현해 남은 R3 종료 조건을 닫았다(platform+root).
**초대:** `identity.invitations`(원본 토큰이 아니라 **해시만** 저장, 역할 템플릿·대상 이메일·만료·단일 사용,
org RLS). createInvitation(member.invite, 원본 토큰 1회 반환)·revokeInvitation·acceptInvitation(한 tx로
해시+만료+미사용+**이메일 매칭**+org 확인→소비+**초대 고정 역할로 Membership**+audit+outbox). 단일 사용
재수락·교차 이메일/org 재사용 구조적 차단(AUT-004). `pie://invite/<token>`는 auth broker **형제 파서**
(unsolicited 토큰이라 state broker에 안 얹음—판단·보고), ROOT Main이 로그인 후 acceptInvite. **폐기 전파:**
`identity.device_sessions`를 **Keycloak `sid`로 키잉**. **경계 결정: Keycloak이 credential·실제 refresh
회전·자체 재사용 탐지 소유, Pie가 세션 메타데이터+폐기 결정+다음-요청 강제 소유(ADR-0009).** verifier가
sid로 `isSessionRevoked` 조회→**폐기 세션 토큰 만료 전 다음 요청부터 거부**(AUT-005). membership 폐기=기존
RBAC status로 다음 요청 자동 거부 + gateway가 user 연결에 `session.revoked` push. `rotateSessionFamily`
stale 마커 재생→family 폐기(AUT-002). `revokeMembership` 마지막 owner 차단+FOR UPDATE 동시성 안전(TEN-005).
**모든 초대·폐기 라우트는 OpenAPI 없음→to-be-contracted 내부 라우트+플래그.** 테스트: 4 gate suite 명명
(invitation-replay-cross-tenant / refresh-token-family-reuse / last-owner-concurrency / revoke-propagation-
offline) + API revoke-propagation(membership→403·session→401·last-owner 409·초대 HTTP 왕복)+root invite
파서. platform 138 + root 78 tests green, root lockfile 무변경. **R3 종료 조건 충족: 권한별 로그인·조직 ID
직접 요청 거부·역할/세션 폐기 다음 요청 반영·초대/refresh 재사용/마지막 소유자 공격 차단.** 남은 R3(후속):
MFA/복구/step-up(AUT-006)·Passkey, entitlement/UsageMeter, ResourceGrant narrowing.

2026-07-25 slice 5로 **entitlement 강제 + ResourceGrant**를 구현해 **마지막 미충족 R3 종료 조건(entitlement
부족 ≠ permission 거부, doc 14:459)을 닫았다**(platform 전용, root 미변경). **entitlement:** manifest에서
checksum 시드되는 plan 카탈로그+org subscriptions+usage_meters. 순수 evaluateEntitlement(limit/boolean,
enterprise null=무제한). **wire: core.members** — invite 수락 시 활성 멤버 라이브 카운트 대비 plan 한계 검사,
초과 시 **entitlement_shortfall**(distinct 감사 `entitlement.shortfall.core_members`, HTTP 402≠permission 403).
구독 없는 org는 unmetered. **ResourceGrant:** `identity.resource_grants`(narrow|widen). 순수 evaluator에
resource-scope 단계 추가(narrow 제거·widen 예외 허용, default-deny, 명시적 거부>widen; org-level 경로 불변).
**실 리소스 op 없음(R4)→ 순수+합성 op로 증명, R4가 첫 소비자 문서화(가짜 op 금지).** **TEN-006 완결:** matrix가
**entitlement_shortfall/permission_denied/resource_narrowed/allowed 4개 구별 결과+4개 이유 코드** 검증.
platform 156 tests green(+18), lint 0, contracts OK, root src 미변경. **R3 authz 코어 완결(MFA/step-up 제외).**
남은 R3: MFA/복구/step-up(AUT-006)·Passkey. R4 대기: projects/storage metering·resource-scoped op·subscription
생성. 상시 gap: provisioning/invite/revoke/entitlement op OpenAPI 미계약, ClientHello auth 필드 없음.

2026-07-26 R4 시작. slice 1(delivery 기반+Team+Project) 구현(platform 전용, root src 미변경). **contracts 확장
개시(R4는 계약 확장이 범위): additive `createTeam`/`getTeam` op + `team-create.v1` 스키마+fixture, check:contracts
green(20 op/60 schema/51 fixture).** **선행 배관:** resource-scoped 인가 헬퍼 `authorizeResourcePermission`
(R3 slice5 evaluator resource-scope의 **첫 실 소비자**), core.projects entitlement(core.members 패턴,
createProject 402≠project.create 403, distinct 감사). **migration `20260726090001`:** delivery schema, 복합
(org_id,id) 키·복합 FK(doc 30:104-136), teams(key ^[A-Z][A-Z0-9]{1,9}$)·team_counters·projects(project.v1)·
project_teams(같은 tenant FK). **결정: merged provisionOwner 확장으로 org 생성 tx에서 기본 Team(CORE) 생성**
(created 분기만, 멱등 무회귀). Team(create team.manage/get/list) + Project(list/create/get/update). **createProject
=권한+entitlement→한 tx(project+team link+audit+outbox project.created)→realtime 무-plumbing 전달**. updateProject
merge-patch+If-Match/ETag→412. **getProject=authorizeResourcePermission(project.read) — ResourceGrant 첫 실
소비자(narrow grant→역할 있어도 거부).** merge-patch+json parser 추가. 테스트: delivery RLS·Team(dup key·기본 팀)·
Project(realtime·402·412·narrow 거부). platform 167 tests green(+11), lint 0, contracts green, root src 미변경.
slice 2=WorkItem+Board, slice 3=My Work+Core Gate.

2026-07-27 R4 slice 2(WorkItem aggregate + Team WorkItem Workflow + Board move) 구현(platform 전용, root src
미변경). **contracts additive:** `moveWorkItemState`(`.../work-items/{id}:move-state`)·`listTeamWorkflowStates`
op + `work-item-move-state.v1`·`workflow-state.v1` 스키마+fixture, work-item.v1에 `workflowVersion`/`sortKey`
optional 추가(required 아님→하위호환), check:contracts green(22 op/62 schema/54 fixture). **migration
`20260727090001`:** teams에 `workflow_version` 컬럼, `workflow_states`(팀 소유, 고정 category enum, 같은 팀
(org_id,team_id,id) unique로 work_items가 같은 팀 상태만 FK), `work_items`(teamId 필수·projectId nullable,
human key=team.key+'-'+sequence). **식별자 원자성:** `team_counters` UPDATE ... RETURNING(next_sequence-1)이
행 잠금으로 동시 생성을 직렬화→gap/dup 없는 순차 식별자(APP-1·APP-2). 식별자는 Orca Worktree/Workspace/task
ID와 **별개 네임스페이스**(UUID가 PK, human key는 조회용). **두 Workflow 분리(doc 27:137-146):** 이 slice는
Team WorkItem Workflow만 구현하고 Delivery Workflow는 만들지 않으며 WorkItem 상태 이동이 어떤 Delivery Stage도
자동 진행하지 않음(코드·주석·"move가 project row 무변경" 테스트로 경계 명시). **결정: 전용 `:move-state` op**
(updateWorkItem 병합 아님) — doc 23:118-119의 fromStateId·toStateId·workflowVersion·expectedVersion 4중 검증을
명시적 액션으로. stale workflowVersion/expectedVersion/fromState→412, workflow 밖 toState→422. PATCH는 stateId
변경 거부(→:move-state 유도)로 workflowVersion 검증 우회 차단. 기본 팀 provisioning(slice1 insertTeamRow)을
확장해 팀 생성 시 기본 Workflow(Todo→In Progress→In Review→Done) seed(같은 1 tx). getWorkItem=
authorizeResourcePermission(work_item.read)으로 ResourceGrant도 소비. platform 182 tests green(+15), lint 0,
contracts green, root src 미변경. slice 3=My Work + comments/Activity + Core Gate automation.

2026-07-28 R4 slice 3(My Work + comments/Activity + assignment + Core Gate 자동화 + TEN-004) 구현 — **R4 Core
Gate CLOSED**(platform 전용, root src 미변경). **contracts additive:** `createWorkItemComment`/
`listWorkItemComments`(nested `/comments`)·`listWorkItemActivity`(`/activity`)·`assignWorkItem`(`:assign`) op +
listWorkItems에 `assignee` query param, `comment-create.v1`·`work-item-activity-entry.v1`·`work-item-assign.v1`
스키마 + fixture 6개, check:contracts green(26 op/65 schema/60 fixture). **migration `20260728090001`:**
`delivery.comments`(work_item 같은 tenant FK, visibility internal|project|customer, RLS) + **My Work 인덱스**
`work_items_assignee_idx (org, assignee_id, state_id, sort_key, id) where archived_at is null`(doc 30:352 —
거대한 OR 금지, targeted index). **결정 1(My Work URL): `GET .../work-items?assignee=me`** — canonical work-items
리소스의 query filter(doc 23:148-150), `me` sentinel을 서버가 토큰 subject의 Pie userId로 해소(별도 /my-work
URL 아님, 타 유저 유출 없음, org-scoped). **결정 2(comment realtime signal): work_item.updated invalidation**
— comment는 work-item child라 aggregate root invalidation이 정직한 최소 신호(speculative comment 이벤트 타입
안 만듦). **결정 3(Activity source): audit.audit_events 필터 읽기**(target_type='work_item'+target_id, dedicated
projection은 연기) — audit이 SoT. **결정 4(assignment permission): 전용 `:assign` 액션(work_item.assign)** —
PATCH는 assignee 변경 거부(USE_ASSIGN 409)해 work_item.update로 재배정하는 권한 구멍 차단(member는 update는
있고 assign 없음, 라이브로 403 증명). :move-state colon-dispatch 라우트를 action('move-state'|'assign')으로 분기.
**TEN-004(customer-field-projection-snapshots):** `resource-projection.ts`(audience internal|external — 멤버십
역할이 전부 external role manifest면 external), projectWorkItemForAudience(external→assigneeId·priority·sortKey·
workflowVersion 필드 삭제)·projectProjectForAudience(external→summary·status 삭제)·projectCommentsForAudience
(external→visibility='customer'만). **customer-org-on-project 관계는 Planning Gate라 이 slice는 org-level
customer_approver 멤버십 fixture로 projection을 증명**(정직 최소, 문서화). listComments가 라이브로 audience 필터
적용(customer 역할→customer 코멘트만). **Core Gate 통합 테스트 `r4-core-gate`:** provision→CORE team→project→
work item(CORE-1)→assign→My Work→board move→comment→Activity(created/assigned/state_moved/commented) 전체
관통 + 게이트 조건(cross-tenant 403·stale ETag 412·**응답 본문에 access/refresh token·bearer 노출 0**·WorkItem
opaque UUID id ≠ human key APP-N 네임스페이스[Orca ID와 별개]). **R5 인계 포트(doc 28:509-521): WorkItem opaque
id + stateId(permission/content 포트) 노출 확인, R5는 안 만듦.** platform 188 tests green(+대략 17, 병렬 컨테이너
포트 고갈로 일부 파일 transient skip→격리 재실행으로 통과 확인), typecheck 4/4·lint 0(121 files)·check:contracts
green, root src 미변경, 두 lockfile clean. **남은 R4 = Planning Gate**(Cycle/Initiative/Milestone/ProjectUpdate/
Intake/SavedView/offline-cache/search/external-refs) + R5 핸드오프. **Core Gate closed→R5 AI Workspace 착수 가능.**
**플래그: delivery 라우트 런타임 idempotency dedup 미배선**(Idempotency-Key 헤더는 계약상 필수지만 저장 dedup은
아직 없음, 후속 → slice 3b에서 닫음).

2026-07-17 R4 slice 3b(idempotency dedup)로 **R4 Core Gate 완전 종결**. 위 플래그를 닫았다. 기존
`operations.idempotency_records`(artifact intent가 쓰던 것)를 **재사용**해 새 API 헬퍼 `idempotent-mutation.ts`
`beginIdempotency`(reserve→replay/conflict/in-progress 판정 + complete/release 클로저 반환)로 delivery **create
4종**(createTeam·createProject·createWorkItem·createWorkItemComment)을 감쌌다. 같은 key+payload 재시도→저장된
결과 재생(1행), 같은 key+다른 payload→**409 IDEMPOTENCY_KEY_REUSED**, 동시 중복→하나만 생성(unique 제약이
두 번째를 IDEMPOTENCY_IN_PROGRESS 409). **결정: If-Match로 이미 보호되는 mutation(updateProject·updateWorkItem·
:move-state·:assign)은 key-dedup 안 함**(중복은 optimistic concurrency로 412가 됨, 중복 행 위험 없음) — team-lead
스코프("create mutations")와 일치. **함정: 비즈니스 실패(entitlement 402·key_taken 409) 시 in_progress 예약을
`releaseIdempotencyKey`로 삭제해 재시도 가능하게 해야 하는데, `idempotency_records`에 pie_app DELETE grant가 없어
500 발생 → migration `20260728090002`로 `grant delete` 추가.** **함정: Idempotency-Key를 런타임 필수로 강제(400
if missing, artifact 라우트와 동일·계약 required:true와 일치)하면서 기존 vertical 3종의 createTeam setup 호출이
헤더 누락으로 400→cascade, 해당 테스트에 idempotency-key 추가.** r4-core-gate 테스트에 duplicate-request 단언
추가(doc 28:328). platform 196 tests green, typecheck 4/4·lint 0·check:contracts green(계약 변경 0), root src
미변경, 두 lockfile clean. **R4 Core Gate = doc 28:323-331 조건 전부 충족(중복 요청 포함). R5 AI Workspace 착수
가능.** 이후=Planning Gate(단, team-lead가 사용자 요청[채팅+협업 터미널]으로 우선순위 재검토 중이라 hold, [[pie-chat-and-collab-terminal]]).

2026-07-17 방향 전환: 사용자 요청으로 **채팅(R7)을 R4 기반 위에서 먼저 착수**(협업 터미널은 R8, Relay 완성 후).
chat slice 1 `feat/pie-chat-channel-message` — org 스코프 채널 + 메시지 + realtime + per-user read cursor 얇은
수직. **design-reference-only(chatto AGPL이라 코드 무참조·무복사, Pie 문서 doc 08/13/30 + 라이선스-안전 정찰 설계만).**
**새 `collaboration` 스키마**(doc 30:268 예약; delivery.comments 재사용 X, work-item 앵커라 부적합) migration
`20260729090001`: channels/channel_members/messages/read_cursors(delivery RLS 템플릿 verbatim, 같은 tenant 복합
FK). **realtime=thin invalidation을 기존 outbox→worker→gateway로 — ResourceChangeResourceType union에 channel/
channel_member/message/read_cursor 추가만 → worker/gateway 코드 변경 0(라이브 확인).** **read_cursors는 message-id로
키(stream_cursors[org realtime 순서]와 별개).** 권한=RBAC(새 permission channel.create/read/manage·message.post/read
manifest 등록)+**channel_members roster 게이트(resource_grants 아님 — 명시적 명단, 결정 보고).** post/createChannel/
markRead는 3b beginIdempotency 재사용. slice 1 미포함(후속 increment): 스레드/리액션/멘션/DM/presence-typing/첨부/
검색/채널 join 엔드포인트. 함정: 메시지 keyset 커서를 JS Date 왕복하면 microsecond 절삭으로 커서 행 재포함 → SQL
서브쿼리 튜플 비교로 수정. platform 208 tests green(+12), typecheck 4/4·lint 0·check:contracts green(70 schema/67
fixture/32 op), root src 미변경, 두 lockfile clean. team-lead의 live channel+message+realtime smoke 후 merge 예정.
후속: 채팅 slice 2(스레드/리액션 등) 또는 Planning Gate — team-lead 방향 대기.

2026-07-17 chat slice 2 `feat/pie-chat-threads-reactions` — 스레드 + 리액션(새 realtime 배관 불필요한 두 increment).
platform 전용, root src 미변경, design-reference-only. **둘 다 기존 message.created/message.updated invalidation을
타서 worker/gateway 변경 0(재확인).** **스레드=별도 aggregate 아님:** migration `20260730090001`이 messages에
nullable `thread_root_message_id`(같은 tenant 복합 FK)만 추가; 답글은 평범한 채널 메시지. thread-list=query filter
`?threadRoot=`(canonical-resource: messages 한 resource, thread는 filter). root는 같은 채널의 root여야 함(교차채널·
답글-대상→422, 1단계 평면). reply count=list read-model 집계. **리액션=durable fact:** `message_reactions`(PK
(org,message_id,user_id,emoji) 중복방지, RLS·member-gated), add(message.react·beginIdempotency)·remove(no-op 204).
**reactions는 message.v1 additive optional 요약 {emoji,count,reactedByMe}+replyCount+threadRootMessageId**(별도
엔드포인트 아님, 새 스키마 0). emoji는 길이만 bound. 함정: 204에 send() 누락→Fastify hang; 리액션 realtime 테스트에서
미-drain outbox 누적→반복 drain. platform 219 tests green(+11), typecheck 4/4·lint 0·check:contracts green(70 schema/
69 fixture/34 op), root src 미변경, 두 lockfile clean. team-lead의 live threads+reactions smoke 후 merge 예정. 후속:
멘션→DM→presence/typing→첨부→search→채널 invite 또는 Planning Gate — team-lead 방향 대기.

2026-07-17 chat slice 3 `feat/pie-chat-mentions` — 멘션 + durable per-user 알림. platform 전용, root src 미변경,
design-reference-only. **기존 outbox→realtime 재사용(notification을 union에 추가만)→worker/gateway 변경 0(재확인).**
**결정(멘션): 클라이언트가 구조화된 `mentions:[userId]` 제공(free-text @handle 파싱 아님 — handle resolver 없음),
서버가 채널 멤버십 검증·비멤버는 조용히 드롭·post 시점 1회 해소(edit 재계산 안 함).** migration `20260731090001`:
message_mentions + notifications(type/source_ref/seen/read). **핵심 보안: notifications per-user RLS** — org 격리 +
`FOR SELECT/UPDATE`에 `user_id = pie.user_id` restrictive 정책. `withTenantUserTransaction`(pie.user_id GUC) 신설;
알림 INSERT는 poster tx라 org만(poster가 남을 위해 씀, 앱 생성 id·no RETURNING). postMessage 한 tx에 message+mentions+
멘션당 notification+outbox notification.created. 라우트: listNotifications(본인 것)·markNotificationRead·markAll
(`:read-all` 정적 콜론). **결정(알림 권한): 별도 permission 없이 organization.read + per-user RLS.** beginIdempotency가
postMessage 감싸 중복 mention-post→알림 무중복. 테스트: **per-user 격리(A가 B 알림 못 읽음/mark→404)**·멘션 realtime·
비멤버 드롭·idempotency 무중복·cross-tenant. platform 227 tests green(+8), typecheck 4/4·lint 0·check:contracts green
(71 schema/71 fixture/37 op), root src 미변경, 두 lockfile clean. team-lead의 live mention+notification+isolation smoke
후 merge 예정. 후속: DM→presence/typing→첨부→search→채널 invite→DND 또는 Planning Gate — team-lead 방향 대기.

## 결정이 필요한 항목

| 결정                            | 확인 방법                                                   | 차단 단계     |
| ------------------------------- | ----------------------------------------------------------- | ------------- |
| Keycloak provisioning 운영 세부 | 이메일, theme, partial failure, upgrade와 break-glass E2E   | R3            |
| Object Storage 호환 범위        | SeaweedFS·S3 multipart, presign, quarantine와 삭제 contract | R2/R5         |
| 비밀·KMS                        | cloud KMS와 Self-hosted secret manager의 key lifecycle 비교 | production 전 |
| `cli-relay` 기능 이관 범위      | protocol, 인증, 명령 주입, backpressure, 감사 분석          | R8            |
| 검색 엔진 도입 시점             | 권한 회수 지연과 transcript 규모 부하 시험                  | R5 이후       |
| 원격 데스크톱 엔진              | OS별 권한·품질·입력·재부팅·라이선스 prototype               | R8            |

제품 핵심 흐름과 무관한 공급자 결정을 미리 모두 고정하지 않는다. 반대로 인증, 테넌트 격리,
outbox와 schema 도구처럼 후속 데이터 계약을 바꾸는 선택은 R0~R2에서 미루지 않는다.
Migration·query 계층, tenant enforcement, local outbox, Object Storage, Identity Provider, Control
Plane framework와 Media SFU는
[`docs/adr`](../docs/adr/README.md)와 [데이터베이스 물리 설계](./30-database-physical-design.md)에서
결정되었다. KMS topology와 원격 데스크톱 엔진은 아직 별도 결정이 필요하다.

## 변경 관리

- 계약 변경 PR에는 영향을 받는 Electron, Runtime, 서버, Worker와 최소 지원 버전을 적는다.
- 호환되지 않는 event payload 변경은 기존 `type`의 의미를 바꾸지 않고 새 schema version 또는 type을
  만든다.
- 문서의 상태를 `기준`으로 올릴 때 담당자, 결정일, 검증 링크를 ADR에 기록한다.
- 외부 표준은 `latest` 링크만 믿지 않고 구현에서 사용한 버전과 capability를 고정한다.
- 보안 표준과 런타임 취약점은 분기마다 다시 확인하고 긴급 이슈는 릴리스 gate로 승격한다.

## 다음 구현 순서

1. 완료: `33`의 공통 schema, OpenAPI, AsyncAPI와 compatibility fixture 계층을 만든다.
2. 완료: `23`의 error, concurrency, event와 outbox 의미를 executable contract로 옮긴다.
3. 완료: `24`의 P0 위협을 단계·gate·검증 증거 manifest로 연결한다.
4. 다음: R1의 안전한 IPC와 Runtime handshake를 구현한다.
5. R2의 임시 tenant → DB outbox → Worker → Realtime 수직 흐름을 구현한다.
6. R3 인증·RBAC 후 R4 Project·WorkItem을 추가한다.
7. R5에서 Claude Code·Codex 수집기를 한 provider씩 붙인다.

R4는 [R4 프로젝트 포털 Backlog](./28-r4-project-portal-backlog.md)의 Core Gate와 Planning Gate로
나누어 구현한다. R5 첫 수직 흐름은 Core Gate 이후 시작하되 외부 알파는 Planning Gate까지 요구한다.

## 완료 정의

“구현 자료가 정리되었다”는 말은 기능 목록이 많다는 뜻이 아니다. R0 완료 시점에는 최소한 다음이
참이어야 한다.

- R0 범위의 공통·업무·IPC·Runtime·ingest·MCP 객체와 요청·이벤트가 schema로 검증된다.
- 권한 행렬은 default-deny role manifest로 고정되고 위협은 구현 단계의 자동화 gate에 배정된다.
- offline retry와 schema mismatch의 실패 의미가 고정된다.
- KROOT 기능마다 이관 판정과 원본 근거가 있다.
- 남은 공급자 선택이 어떤 단계를 차단하는지 명시된다.
- 지원 OS, host, provider와 버전 조합이 CI 또는 수동 release gate에 배정된다.
