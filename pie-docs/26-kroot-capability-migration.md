# KROOT 기능 인벤토리와 이관 기준

## 목적

KROOT의 기능을 “모두 반영한다”는 요구를 화면 복사로 처리하지 않는다. 실제 소스에서 확인된 기능을
Pie 도메인에 매핑하고 `채택`, `재구현`, `대체`, `보류`, `폐기`로 판정한다. 이 문서는 초기 source
audit 결과이며 데이터베이스와 운영 환경을 분석한 production readiness 평가는 아니다.

## 조사 기준

KROOT 기준 경로를 다음 환경 변수로 표현한다.

```text
KROOT_MAIN_SITE=/Users/jikime/Dev/Business/kaonsoftlab/kroot/frontend/clients/kroot-main-site
```

확인 순서는 실행 코드와 테스트 → domain 계약 → API route → 문서 → 화면 순이다. KROOT 안에서도
상태 문서와 코드가 다른 시점에 작성되어 상충하므로 문서의 “완료” 문구만으로 구현 상태를 판정하지
않는다.

## 확인된 핵심 기능

| 기능 | 소스 근거 | 판단 |
|---|---|---|
| 프로젝트와 master/sub 구조 | `src/domain/projects/entities/project.ts`, `src/app/(dashboard)/master-projects` | 개념 채택, tenant·참여 조직을 추가해 재구현 |
| versioned Workflow와 단계 | `src/domain/projects/entities/project-workflow-*.ts`, 관련 use case/test | 상태 규칙과 테스트 시나리오 채택 |
| 내부·고객 승인과 잠금 | `src/domain/approval/entities.ts`, `use-cases`, approval tests | Pie Workflow/Evidence로 재구현 |
| 개인·프로젝트 업무 | `src/domain/todolists/entities.ts`, `use-cases`, tests | `WorkItem`으로 통합 재구현 |
| 참여자·인수인계·의존성·하위 업무 | `src/domain/todolists/use-cases`와 value objects | 정책별 채택, aggregate 경계 재설계 |
| 업무 template·반복·help request·memo | `src/domain/todolists/policies`, `use-cases` | R4 이후 우선순위별 이관 |
| Markdown 업무 ingest | `src/domain/todolists/ingest-contract.ts`, ingest tests | external key/hash/dry-run 개념 채택 |
| 업무·프로젝트 chat과 알림 | `src/domain/todolists/chat-events.ts`, notification use cases, dashboard routes | 별도 Conversation/Notification domain으로 재구현 |
| 명령 registry와 instance | `src/domain/commands/command-registry.ts`, `entities.ts`, tests | typed command 개념 채택, capability·승인 강화 |
| 단계별 프로젝트 화면·산출물 | `src/app/(dashboard)/projects/[id]/*` | 정보 구조 참고, Electron UI로 새로 설계 |
| AI Coding 프로젝트·session 화면 | `src/app/(dashboard)/aicoding/*` | Pie Workspace/AI timeline으로 대체 |
| Claude session 조회 API | `src/app/api/agents/projects/[projectId]/sessions/route.ts` | 대체. 전체 수집 기반으로 사용하지 않음 |
| Agent Teams API/MCP | `src/app/api/agents/teams`, `mcp-server` | 별도 실험 자산, Pie 업무 MCP와 분리 평가 |
| KROOT MCP server package | `packages/kroot-mcp-server/README.md` | scaffold이므로 구현으로 이관하지 않음 |
| 역할·permission 표 | `src/shared/lib/permissions.ts`, domain security | permission 이름 참고, Pie resource grant로 재설계 |
| 감사·Evidence·보고 route | project dashboard 하위 route와 domain | domain/API 존재 여부를 기능별로 추가 검증 |

## 중요한 소스 관찰

### 업무 모델

KROOT `Todo`는 status, scope, order, due date, priority, owner, assignee, project, ingest metadata를
가지며 participant, assignment, approval, read receipt, chat, memo, help request, recurrence와 template
use case가 분리되어 있다. 기능 폭은 유용하지만 Pie에서는 다음처럼 정리한다.

- 중앙 업무 이름은 `WorkItem` 하나로 고정한다.
- 개인 업무도 personal Organization의 Project/WorkItem 계약을 사용한다.
- assignee, participant와 approver를 하나의 role field로 합치지 않는다.
- chat encryption field를 WorkItem entity에 직접 계속 붙이지 않고 Conversation 경계로 이동한다.
- ingest metadata는 source-specific object가 아니라 `ExternalReference`와 `ImportRun`으로 분리한다.
- status 이동은 문자열 update가 아니라 versioned Workflow transition 명령으로 처리한다.

### Workflow와 승인

KROOT는 `DRAFT → REVIEW → APPROVED_INTERNAL → APPROVED_CLIENT → LOCKED`와 reject/reopen 이력,
required artifact, progress, due date를 가진다. Pie는 이 상태 머신을 출발점으로 쓰되 다음을 보강한다.

- workflow definition version과 project binding의 유효 시점
- 승인 요청 당시 Artifact/Evidence revision 고정
- 승인자 permission과 참여 조직 관계 snapshot
- 승인과 실행자의 분리, step-up 인증이 필요한 상태
- reopen이 후속 단계와 고객 제출에 주는 영향
- AI `declared` 완료와 검증된 evidence의 분리
- optimistic concurrency와 idempotent transition

KROOT의 단계별 use-case test는 시나리오 목록으로 이관할 가치가 높다. 구현 코드를 직접 의존하기보다
Pie 상태 표와 fixture로 옮긴다.

### 명령 실행

KROOT command registry는 command와 args를 배열로 나누고 기본 `shell: false`, 허용 환경변수와 역할,
timeout을 둔다. 이는 arbitrary shell보다 좋은 출발점이다. Pie에서는 추가로 다음을 요구한다.

- command definition version과 content digest
- 실행 host type과 host capability
- typed argument schema와 값별 제한
- working directory root와 symlink 정책
- secret reference와 plaintext env 분리
- 요청자, 승인자, 실행자와 target binding
- idempotency, cancellation, output quota, audit와 artifact result
- native, WSL, SSH, Relay별 executable resolution

KROOT의 `script` 문자열은 표시용으로만 취급하고 실행의 권위자는 `command + args` 구조여야 한다.

### AI session

KROOT project session API는 `~/.claude/projects/.../*.jsonl`을 읽고 파일당 최대 300줄에서 첫 메시지,
assistant message 수, tool 진행 상태, subagent, branch와 compaction metadata를 계산한다. 이 구현은
프로젝트 session 목록 UI에는 유용하지만 다음 이유로 Pie 수집 기반으로 재사용하지 않는다.

- Claude 전용 경로와 파일 형식이다.
- 앞 300줄 제한으로 전체 session과 최종 상태를 보장하지 않는다.
- cursor가 파일 목록 offset이고 transcript byte checkpoint가 아니다.
- SessionBinding, tenant, visibility, event deduplication과 deletion 계약이 없다.
- 파일 변경·회전·truncate와 provider schema version을 추적하지 않는다.

Pie는 Orca AI Vault, Hook, transcript reconciler와 Runtime observer를 기준으로 하고 KROOT UI에서 유용한
metadata만 projection 요구사항으로 가져온다.

### MCP 구현 상태

`packages/kroot-mcp-server/README.md`는 스스로 scaffold와 `not implemented` 상태를 밝히며 WebSocket,
registry, reconnect, upload와 metrics가 후속 TODO다. 별도 `mcp-server/package.json`은 외부
`agent-teams-mcp` 계보의 Claude Agent Teams controller 도구다.

따라서 둘을 Pie MCP의 완성 구현으로 합치지 않는다.

- Pie 업무 MCP는 project/work item/artifact 도구와 현재 Pie 인증 계약으로 새로 만든다.
- Agent Teams MCP는 Runtime orchestration 실험으로 분리해 license, protocol, security와 유지보수성을
  평가한다.
- KROOT WS job 아이디어는 Relay/CommandRun 요구사항 참고 자료로만 사용한다.
- MCP transport와 인증은 Pie가 고정한 protocol `2025-11-25`와 capability negotiation을 따른다.

## 기능별 이관 판정

| KROOT capability | Pie target | 판정 | 단계 |
|---|---|---|---|
| Project CRUD/archive | Project | 재구현 | R4 |
| Master/sub project | ProjectRelation/Portfolio | 채택, 보류 | R6 |
| Project member/role | MembershipRole/ResourceGrant | 재구현 | R3/R4 |
| Customer/developer role | ParticipatingOrganization | 대체 | R4/R6 |
| Todo board/list | WorkItem list/board | 재구현 | R4 |
| Todo assignment/participant | WorkItemAssignment/Participant | 채택 | R4 |
| Subtask/dependency | WorkItem relation | 채택 | R4 |
| Handoff/help request | WorkItem collaboration command | 보류 | R6/R7 |
| Recurrence/template | WorkItem template/schedule | 보류 | R6 |
| Todo memo/read receipt | Comment/Activity/Read model | 선택 이관 | R7 |
| Todo/project chat | Conversation/Message | 재구현 | R7 |
| Notification | Notification/Preference | 재구현 | R3/R7 |
| Workflow template | WorkflowDefinitionVersion | 재구현 | R4/R6 |
| Internal/client approval | ApprovalRequest/Decision | 재구현 | R4/R6 |
| Required artifact | EvidenceRule/ArtifactRevision | 재구현 | R5/R6 |
| Step pages 13개 | Workflow stage views | 정보 구조만 채택 | R6 |
| Progress/report | Projection/Report | 재구현 | R6/R9 |
| Markdown todo ingest | ImportProfile/ImportRun | 채택 | R5/R6 |
| Command registry | CommandDefinitionVersion | 강화 재구현 | R5/R8 |
| Command result | CommandRun/Artifact | 강화 재구현 | R5/R8 |
| Claude session list | AgentSession projection | Orca 기반으로 대체 | R5 |
| Agent team Kanban | AgentRun orchestration view | 별도 평가 | R5 이후 |
| KROOT MCP scaffold | Pie MCP | 폐기 후 신규 구현 | R5 |
| Web dashboard pages | Electron Renderer | UX 참고 후 신규 구현 | 각 단계 |

## 그대로 가져오면 안 되는 항목

- Next.js route와 browser session을 Electron Main 인증 경계 없이 호출하는 구조
- broad role 이름만으로 project, field, artifact와 remote host 권한을 결정하는 방식
- path와 provider project ID를 중앙 Project identity로 사용하는 방식
- Claude JSONL 일부 scan을 전체 conversation 기록으로 표현하는 방식
- MCP와 WebSocket remote job, AI telemetry를 하나의 프로토콜로 부르는 방식
- 문서의 계획 상태를 production-ready 구현으로 간주하는 방식
- UI route 존재를 완성된 domain/API/audit/security의 증거로 간주하는 방식
- KROOT DB schema를 tenant/RLS 분석 없이 그대로 import하는 방식

## 이관 절차

### 1. Capability manifest

각 기능에 다음 manifest를 만든다.

```text
- capabilityId
- user outcome
- source files and tests
- current dependencies
- Pie aggregate and permission
- data fields and classification
- behavior fixtures
- migration decision
- target roadmap stage
- known gaps
```

### 2. 행위 테스트 추출

- use case test에서 정상 상태 전이와 deny 시나리오를 추출한다.
- 날짜, ID와 framework 의존성을 제거한 Pie contract fixture를 만든다.
- KROOT bug까지 호환해야 하는지 제품 규칙으로 명시한다.
- 테스트가 없는 UI 동작은 자동으로 요구사항으로 승격하지 않고 사용자 흐름 검토를 거친다.

### 3. Pie schema 구현

- organization과 resource scope를 모든 aggregate에 추가한다.
- version, idempotency, audit, visibility와 retention을 공통 규칙으로 적용한다.
- KROOT 이름을 API alias로 영구 유지하지 않고 import mapping에만 둔다.
- Electron/Runtime에 필요한 로컬 실행 필드와 중앙 업무 필드를 분리한다.

### 4. 데이터 이관 spike

- KROOT 실제 DB schema, row count, null/duplicate/orphan, encoding과 timezone을 읽기 전용으로 분석한다.
- project, member, todo, workflow, approval, artifact와 chat별 mapping report를 만든다.
- dry-run은 생성·병합·충돌·누락·민감정보 수를 출력한다.
- source primary key와 content hash를 보존해 재실행을 멱등하게 한다.
- approval/evidence처럼 의미를 보장할 수 없는 row는 추측해 승인 상태로 가져오지 않는다.

### 5. 병행 검증과 전환

- representative project를 read-only import해 KROOT와 Pie 결과를 비교한다.
- 사용자 수용 후 incremental delta 또는 final freeze 방식을 선택한다.
- rollback은 Pie 쓰기를 KROOT로 역동기화하는 것이 아니라 import 전 snapshot과 전환 계획으로 제공한다.
- source 보존·폐기 일정과 개인정보 삭제 책임을 기록한다.

## 추가로 조사할 KROOT 영역

현재 audit만으로 다음은 구현 완성도를 확정하지 않았다.

- 실제 database migration과 tenant/organization 관계
- master project, company, contract, budget와 report의 domain/API 일치 여부
- chat E2EE key lifecycle, multi-device recovery와 server 검색 동작
- audit event의 append-only·operator access·보존 보장
- Evidence 파일 저장소, hash와 승인 revision binding
- command dispatch의 실제 agent 인증, cancellation과 retry
- notification delivery, email, websocket과 offline 동작
- legacy/신규 route 중 실제 사용 경로와 dead code
- KROOT 배포 환경의 identity provider, secret, backup과 observability

이 영역은 R6 이후 기능을 시작하기 전 source + schema + runtime evidence로 다시 감사한다.

## 이관 완료 기준

- manifest의 모든 KROOT capability가 Pie target과 단계에 연결된다.
- `채택`한 상태 규칙은 Pie contract test로 재현된다.
- `대체`·`폐기` 항목은 사용자 결과가 어디서 제공되는지 명시된다.
- 데이터 import는 dry-run, 멱등 재실행, 충돌 report와 rollback evidence를 가진다.
- 고객·내부 visibility와 approval evidence가 이관 중 넓어지지 않는다.
- KROOT source update 이후 manifest drift를 탐지할 기준 commit을 기록한다.
