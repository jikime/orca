# Pie Product Documentation

이 디렉터리는 Pie의 제품 범위와 기능별 구현 기준을 관리한다. Pie는 기존 개발자 도구의
강점을 유지하면서 AI 작업 실행과 프로젝트 업무·산출물을 연결하고, SI 프로젝트 수행,
고객관리, 서비스 데스크, 원격지원, 협업, 원가 관리를 하나의 Electron 데스크톱 앱으로 제공한다.

## 제품 범위

- Windows, macOS, Linux에서 실행되는 단일 Electron 앱을 제공한다.
- 별도의 고객용 웹 프론트엔드는 만들지 않는다.
- 내부 직원, 고객, 협력사, 일회성 원격지원 참가자는 같은 앱을 사용한다.
- 로그인 역할과 세션 권한에 따라 화면과 명령을 제한한다.
- 채팅 동기화, 데이터 저장, 화상회의, 원격지원에는 중앙 서버와 릴레이를 사용한다.
- 기존 개발 Workspace, Git, Worktree, 터미널, SSH, AI 에이전트 기능을 보존한다.

## 문서 인덱스

| 문서 | 설명 |
|---|---|
| [제품 정의](./00-product-definition.md) | 제품 목표, 사용자, 범위, 핵심 업무 흐름 |
| [회원가입·로그인과 RBAC](./01-authentication-rbac.md) | 계정 등록, 세션, MFA, 역할과 리소스 권한 |
| [역할과 내비게이션](./01-roles-and-navigation.md) | 사용자 역할, 앱 모드, 전역 화면 구조 |
| [고객·영업·계약](./02-customer-sales-contracts.md) | CRM, 영업기회, 견적, 계약, 고객 360도 |
| [프로젝트 수행](./03-project-delivery.md) | WBS, 요구사항, 변경요청, 공수, 산출물, 검수 |
| [개발 Workspace](./04-development-workspace.md) | 기존 개발 기능과 업무 데이터의 연결 |
| [서비스 데스크와 SLA](./05-service-desk-sla.md) | 티켓, 장애, 유지보수, SLA, 만족도 |
| [자산과 모니터링](./06-assets-monitoring.md) | CMDB, 고객 장비, 서비스 관계, 상태 수집 |
| [원격지원](./07-remote-support.md) | 채팅, 터미널, 데스크톱, 권한, 녹화, 감사 |
| [협업과 회의](./08-collaboration-meetings.md) | 채널, 메시지, 화상회의, 알림 |
| [지식과 자동화](./09-knowledge-automation.md) | 지식베이스, Runbook, 승인형 자동화 |
| [재무와 보고](./10-finance-reporting.md) | 공수, 원가, 청구, 수익성, 운영 보고서 |
| [보안과 관리](./11-security-administration.md) | 권한, 감사, 보존, 테넌트 관리 |
| [Electron 아키텍처](./12-electron-system-architecture.md) | Renderer, Main, Runtime, 서버 경계 |
| [도메인 데이터 모델](./13-domain-data-model.md) | 핵심 엔터티와 관계, 이벤트, 저장 원칙 |
| [구현 로드맵](./14-implementation-roadmap.md) | 단계별 구축 범위와 완료 조건 |
| [Pie 네이밍 전환](./15-pie-naming-migration.md) | 표시명, 패키지, CLI, 프로토콜 전환 원칙 |
| [데스크톱 배포와 수명주기](./16-desktop-lifecycle.md) | 설치, 데이터 전환, 버전 호환, 업데이트, 접근성 |
| [Control Plane 운영](./17-control-plane-operations.md) | 관측성, 작업 큐, SLO, 백업·복구, 보안 운영 |
| [데이터 거버넌스와 연동](./18-data-governance-integrations.md) | 데이터 수명주기, 검색 권한, API, Webhook, 가져오기 |
| [AI 작업 프로젝트 포털](./19-ai-project-portal.md) | 프로젝트 업무와 AI 세션·도구·산출물의 연결 및 MCP 경계 |
| [AI 프로젝트 포털 구현 위험](./20-ai-project-portal-risk-register.md) | 구현 전 결정할 P0/P1 이슈와 실패 시나리오·검증 기준 |
| [구현 준비도와 문서 운영](./21-implementation-readiness.md) | 현재 준비 수준, 미결 결정, R0 산출물과 문서 권위 순서 |
| [아키텍처 결정과 기술 기준](./22-architecture-decisions-and-technology.md) | 채택한 표준·기술 기본값과 별도 ADR이 필요한 선택 |
| [API·이벤트·동기화 계약](./23-api-event-sync-contracts.md) | HTTP, ETag, 멱등성, event batch, outbox, Realtime, IPC와 MCP 계약 |
| [보안 위협 모델](./24-security-threat-model.md) | 신뢰 구역, 공격 경로, 필수 통제와 외부 알파 보안 gate |
| [검증 전략과 테스트 매트릭스](./25-verification-test-matrix.md) | 플랫폼·host·provider·버전별 contract, E2E, fault와 운영 검증 |
| [KROOT 기능 이관](./26-kroot-capability-migration.md) | 실제 KROOT 소스 근거, Pie 매핑, 재구현·대체·보류 판정 |
| [프로젝트 실행 모델](./27-project-execution-model.md) | Team, Initiative, Cycle, Intake, SavedView, ProjectUpdate와 작업면 계약 |
| [R4 프로젝트 포털 Backlog](./28-r4-project-portal-backlog.md) | Project·WorkItem 포털의 수직 구현 순서, gate와 완료 조건 |
| [데스크톱 UI 정보구조](./29-desktop-ui-information-architecture.md) | 현재 Workspace UI와 Portal·CRM·지원·대화 모듈의 배치 및 상태 보존 계약 |
| [데이터베이스 물리 설계](./30-database-physical-design.md) | PostgreSQL schema, tenant RLS, index, outbox, SQLite와 Object Storage 물리 계약 |
| [SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md) | Cloud·Local Docker·On-prem 연결 프로필, discovery와 public/internal endpoint 계약 |
| [Reference Architecture v1](./32-reference-architecture-v1.md) | Desktop·Control Plane·Data Plane·저장소·배포 프로필의 기준 구조 |
| [Contract Specification과 변경 관리](./33-contract-specification-governance.md) | OpenAPI·AsyncAPI·JSON Schema 권위, 생성물과 호환성 gate |

## 우선순위 표기

| 등급 | 의미 |
|---|---|
| P0 | 앱의 보안·데이터 기반. 다른 기능보다 먼저 필요하다. |
| P1 | 첫 실사용 흐름을 완성하는 핵심 기능이다. |
| P2 | SI 수행과 유지보수 운영을 완성하는 기능이다. |
| P3 | 원격 데스크톱, 모니터링, 재무 등 확장 기능이다. |

## 용어

| 용어 | 의미 |
|---|---|
| Pie | 사용자에게 표시되는 새 제품명 |
| 조직 | Pie를 구매하고 운영하는 SI 또는 IT 서비스 회사 |
| 고객사 | 조직이 프로젝트와 유지보수 서비스를 제공하는 외부 회사 |
| Team | WorkItem 식별자, 실행 Workflow와 Cycle을 소유하는 업무 처리 단위 |
| Initiative | 목표에 따라 여러 Project를 명시적으로 묶는 포트폴리오 단위 |
| WorkItem | 칸반, 담당자, 일정, 승인과 완료 조건을 가진 중앙 프로젝트 업무 |
| Intake | 고객 요청, 외부 issue와 미할당 AI 세션을 WorkItem 전에 검토하는 공통 inbox |
| SavedView | 권한이 허용한 resource에 filter·group·sort·layout을 적용하는 저장된 조회 |
| Workspace | 저장소, Worktree, 에이전트, 터미널, 브라우저를 포함한 개발 공간 |
| AgentSession | Claude Code, Codex 등 provider가 소유한 대화 세션과 Pie 메타데이터 |
| AgentRun | 한 업무 문맥에서 수행한 에이전트의 한 번의 실행 시도 |
| Artifact | 파일, 문서, commit, PR·MR, test, report의 추적 가능한 산출물 |
| 서비스 티켓 | 문의, 장애, 작업 요청, 변경 요청을 추적하는 업무 단위 |
| 원격 세션 | 채팅, 터미널, 데스크톱 제어를 포함하는 고객지원 세션 |
| Edge Agent | 고객 장비에서 outbound 연결을 유지하는 Pie 번들 사이드카 |

## 문서 원칙

- 새 문서와 사용자 표시명에는 `Pie`를 사용한다.
- 기존 런타임 식별자는 호환성 계획 없이 일괄 변경하지 않는다.
- 인증과 권한은 다른 중앙 업무 기능보다 먼저 구현한다.
- 화면에서 숨기는 것만으로 권한을 구현하지 않는다. Main, Runtime, 서버에서 다시 검증한다.
- 별도 웹 프론트엔드가 없어도 인증·초대·설치를 위한 최소 공개 HTTPS 표면은 제공한다.
- 데스크톱, 서버, Runtime, Relay, Edge Agent의 버전 차이를 정상 운영 상태로 간주한다.
- 로컬, WSL, SSH, 원격지원 호스트를 모두 실행 위치로 고려한다.
- Git 기능은 GitHub뿐 아니라 GitLab과 다른 지원 공급자를 함께 고려한다.
- 문서의 기능 목록만으로 구현 완료를 판단하지 않는다. schema, migration, 자동화 테스트와 운영
  Runbook을 함께 완료 증거로 사용한다.
- `결정 필요` 항목은 공급자나 framework를 임의 선택해 코드에 고정하지 않고 ADR과 spike로 닫는다.
- Linear 등 외부 제품은 UX와 도메인 원칙의 참고 자료이며 API·화면 호환 대상이 아니다.
