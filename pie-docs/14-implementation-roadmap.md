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
