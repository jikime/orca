# R4 프로젝트 포털 구현 Backlog

## 목표

R3 인증·RBAC 기반 위에 Team, Project와 WorkItem을 실제로 사용 가능한 데스크톱 프로젝트 포털로
구현한다. 각 backlog item은 API, 권한, 저장, Electron 작업면과 검증을 함께 끝내며 메뉴와 빈 화면만
먼저 만들지 않는다.

상세 도메인 의미는 [프로젝트 실행 모델](./27-project-execution-model.md), 공통 transport와 충돌 처리는
[API·이벤트·동기화 계약](./23-api-event-sync-contracts.md)을 따른다.

## 내부 단계

```text
R3 Auth/RBAC
  |
  v
R4-A Contract and Tenant Foundation
  |
  v
R4-B Team -> Project -> WorkItem -> My Work -> Board
  |                         |
  |                         +-> R5 AI Workspace 첫 수직 흐름 시작 가능
  v
R4-C Cycle -> Initiative/Milestone/Update -> Intake -> SavedView
  |
  v
R4 Release Gate
```

R5가 R4 전체를 기다리며 장기간 막히지 않도록 `R4 Core Gate`를 둔다. 다만 외부 알파는 R4 Planning
Gate와 R5의 AI 추적 gate가 모두 통과한 뒤 진행한다.

## 공통 Definition of Ready

backlog item을 구현 상태로 옮기려면 다음이 준비되어야 한다.

- 사용자 결과와 제외 범위
- aggregate owner와 tenant key
- permission과 field visibility
- OpenAPI request/response/problem type 초안
- optimistic concurrency와 idempotency 요구
- Activity와 Audit event 목록
- valid, invalid, previous-version fixture
- desktop/Windows/macOS/Linux와 SSH 영향
- 데이터 migration과 rollback 방식

## 공통 Definition of Done

- 서버, Worker, Main, Renderer 중 필요한 계층이 typed contract를 사용한다.
- API, DB RLS, Object Storage와 local cache가 organization 경계를 지킨다.
- mutation은 permission, entitlement, `If-Match`와 idempotency를 검증한다.
- allow·deny·conflict·retry test가 있다.
- Realtime 유실 후 snapshot/delta resync로 같은 결과에 도달한다.
- 고객·협력사 field projection과 search 결과가 permission test를 통과한다.
- keyboard, screen reader, empty/loading/error/offline 상태를 검증한다.
- feature flag가 있으면 owner, 제거 조건과 만료 단계를 기록한다.
- 운영 log에 본문, token, 고객 비밀과 로컬 절대 경로를 남기지 않는다.
- 문서, schema, migration과 release evidence가 함께 갱신된다.

## 우선순위

| 등급 | 의미 |
|---|---|
| R4-P0 | 후속 모든 project 기능의 데이터·권한 기반 |
| R4-P1 | Core Gate와 첫 실사용 업무 흐름에 필수 |
| R4-P2 | Planning Gate와 Linear형 포털 완성에 필요 |
| R4-P3 | R5 이후 확장 또는 사용량 검증 후 추가 |

## Backlog 요약

| ID | 우선순위 | 결과 | 선행 |
|---|---|---|---|
| R4-00 | P0 | Project execution contract package | R0, R2, R3 |
| R4-01 | P0 | Team과 personal default Team | R4-00 |
| R4-02 | P0 | Team WorkItem Workflow | R4-01 |
| R4-03 | P0 | cross-team Project와 참여 조직 | R4-01 |
| R4-04 | P0 | WorkItem aggregate와 identifier | R4-02, R4-03 |
| R4-05 | P1 | My Work, quick create, detail panel | R4-04 |
| R4-06 | P1 | List·Board와 안전한 상태 이동 | R4-04, R4-05 |
| R4-07 | P1 | 관계·댓글·Activity·Audit | R4-04 |
| R4-CG | Gate | Team → Project → WorkItem Core Gate | R4-01~07 |
| R4-08 | P2 | Cycle과 rollover proposal | R4-CG |
| R4-09 | P2 | Initiative·Milestone·ProjectUpdate | R4-CG |
| R4-10 | P2 | Intake와 WorkItem 승격 | R4-CG |
| R4-11 | P2 | Filter DSL과 SavedView | R4-05, R4-CG |
| R4-12 | P1 | Realtime·offline cache·search projection | R4-04~11 |
| R4-13 | P2 | GitHub·GitLab·Jira·Linear reference | R4-04, R4-10 |
| R4-PG | Gate | Project planning portal release gate | R4-08~13 |

## R4-00 Project execution contract package

### 결과

서버, Main과 Renderer가 공유할 project execution schema와 오류 의미를 만든다.

### 작업

- Team, TeamMembership, WorkItemIdentifier schema
- WorkflowDefinitionVersion과 WorkflowState schema
- Project, ProjectTeam, ProjectOrganizationRelation schema
- WorkItem, participant, dependency와 parent relation schema
- Cycle, Initiative, Milestone, ProjectUpdate, IntakeItem, SavedView schema
- resource별 permission catalogue
- Activity/Audit event type catalogue
- OpenAPI route와 RFC 9457 problem type
- previous/additive/invalid compatibility fixture
- RLS tenant fixture와 migration ownership role

### 완료 조건

- 같은 fixture를 API validator, Main decoder와 contract test가 통과한다.
- unknown enum과 unsupported schema version을 임의 기본값으로 바꾸지 않는다.
- organization ID만 바꾼 모든 resource 요청이 거부된다.
- WorkItem Workflow와 Delivery Workflow 타입을 혼용할 수 없다.

## R4-01 Team과 personal default Team

### 사용자 흐름

`가입 완료 → personal Organization 선택 → 기본 Team 확인 → 회사 Team 생성 → 멤버 참여`

### 작업

- personal Organization 생성 transaction에 default Team provisioning 추가
- Team CRUD/archive와 identifier alias
- Organization Membership과 TeamMembership 분리 migration
- Team member 역할과 workflow 관리 permission
- Team switcher와 Team 설정 작업면
- 보관 Team의 read-only history와 신규 업무 차단

### API 초안

```text
GET  /v1/organizations/{orgId}/teams
POST /v1/organizations/{orgId}/teams
GET  /v1/organizations/{orgId}/teams/{teamId}
PATCH /v1/organizations/{orgId}/teams/{teamId}
POST /v1/organizations/{orgId}/teams/{teamId}:archive
GET  /v1/organizations/{orgId}/teams/{teamId}/memberships
```

### 완료 조건

- personal과 company Organization이 같은 Team API를 사용한다.
- Team identifier의 대소문자·예약어·alias 충돌을 막는다.
- 사용자가 여러 Team에 참여해도 Organization Membership이 중복되지 않는다.
- 고객 guest가 내부 Team 목록을 기본 조회하지 못한다.

## R4-02 Team WorkItem Workflow

### 사용자 흐름

`Team 설정 → 상태 생성·정렬 → 기본 상태 지정 → 새 WorkItem에 적용`

### 작업

- 고정 category와 사용자 정의 상태
- versioned WorkflowDefinition과 immutable published version
- 상태 추가·수정·정렬·보관
- 상태 삭제 전 replacement mapping
- 기본 `Backlog`, `Todo`, `In Progress`, `Review`, `Done`, `Canceled` template
- workflow editor와 permission preview
- WorkItem 상태 이동 command contract

### 완료 조건

- category 순서와 completed/canceled 의미가 사용자 이름 변경으로 바뀌지 않는다.
- published version 변경이 기존 Activity를 다시 쓰지 않는다.
- stale workflow version의 상태 이동을 `412`로 거부한다.
- WorkItem 상태 변경으로 Project Delivery Stage를 자동 승인하지 않는다.

## R4-03 Cross-team Project와 참여 조직

### 사용자 흐름

`Project 생성 → lead·기간·고객 선택 → Team 추가 → 내부·고객 멤버 범위 설정`

### 작업

- Project CRUD/archive와 사용자 정의 status category
- ProjectTeam lead/contributor/reviewer/support relation
- customer/vendor/partner/auditor 조직 관계
- ProjectMembership과 resource grant
- Project overview의 summary, status, health, dates, teams, resources
- customer field projection과 private Project 처리
- Project dependency contract

### 완료 조건

- Project owner Organization과 참여 Organization을 혼동하지 않는다.
- Team 참여가 고객 데이터 조회권한을 자동 부여하지 않는다.
- Project status는 WorkItem 수로 자동 완료되지 않는다.
- 제한 Project가 Initiative, search, Realtime과 최근 항목에서 새지 않는다.

## R4-04 WorkItem aggregate와 identifier

### 사용자 흐름

`Team 또는 Project에서 생성 → APP-1 발급 → 담당자·우선순위 지정 → 조회·수정`

### 작업

- Team-scoped atomic sequence와 WorkItemIdentifier alias
- WorkItem create/get/update/archive
- project optional, Team required invariant
- assignee, participant, parent, dependency와 label
- priority, estimate, due date, sort key
- customer visibility와 field projection
- ETag, idempotency와 conflict problem
- Team 이동 시 identifier alias와 permission 재검증

### API 초안

```text
GET  /v1/organizations/{orgId}/work-items/{workItemId}
POST /v1/organizations/{orgId}/work-items
PATCH /v1/organizations/{orgId}/work-items/{workItemId}
POST /v1/organizations/{orgId}/work-items/{workItemId}:move-state
POST /v1/organizations/{orgId}/work-items/{workItemId}:archive
GET  /v1/organizations/{orgId}/work-items:resolve-key?key=APP-142
```

### 완료 조건

- concurrent create가 중복 display key를 만들지 않는다.
- 이전 Team key가 새 WorkItem에 재사용되지 않는다.
- 다른 Project의 Milestone, 다른 Team의 Workflow state를 지정할 수 없다.
- 고객 사용자가 internal description, participant와 AI binding을 조회하지 못한다.

## R4-05 My Work, quick create와 detail panel

화면 영역, Portal·Workspace 전환과 상태 보존은
[데스크톱 UI 정보구조](./29-desktop-ui-information-architecture.md)를 따른다.

### 사용자 흐름

`앱 시작 → My Work 확인 → 빠른 생성 → detail panel 편집 → Workspace로 이동`

### 작업

- Inbox, My Work, Intake, Initiatives, Projects, Views, Teams, Workspace navigation
- My Work의 assigned/created/participating/reviewing projection
- quick create command와 현재 context 기본값
- list row와 오른쪽 WorkItem detail panel
- title, description, status, assignee, priority, project, cycle, milestone 편집
- 최근 조회, deep link와 WorkItem key 검색
- command palette와 cross-platform shortcut label
- loading, empty, permission denied, stale, offline 상태

### 완료 조건

- 앱 시작 시 dashboard 카드 대신 My Work 또는 사용자 기본 SavedView가 열린다.
- quick create가 숨은 filter 값을 적용할 때 생성 전 확인할 수 있다.
- detail panel의 긴 제목·경로·사용자명이 좁은 viewport에서 겹치지 않는다.
- macOS는 `metaKey`, Windows/Linux는 `ctrlKey`를 사용한다.
- `Workspace에서 열기` 전 Project 연결·permission과 host context를 확인한다.

## R4-06 List·Board와 안전한 상태 이동

### 사용자 흐름

`Project 또는 Team 열기 → List/Board 전환 → drag → multi-select 변경 → conflict 복구`

### 작업

- 공통 query state를 쓰는 list와 board
- status, assignee, priority, project grouping
- stable sort key와 bounded reorder
- optimistic drag state와 pending indicator
- `If-Match`, workflow version과 compare-and-set
- multi-select action의 item별 결과
- virtualization과 cursor pagination
- board keyboard move와 접근성 announcement

### 완료 조건

- 다른 client가 먼저 옮긴 WorkItem을 last-write-wins로 덮지 않는다.
- drag 실패 시 카드가 server 위치로 복구되고 사유가 남는다.
- 권한 없는 column과 customer-hidden WorkItem 수를 노출하지 않는다.
- 10,000개 WorkItem fixture에서 pagination·virtualization과 memory baseline을 기록한다.
- list와 board 전환이 filter, selection과 detail panel 대상을 잃지 않는다.

## R4-07 관계·댓글·Activity·Audit

### 사용자 흐름

`하위 업무·dependency 추가 → 댓글·멘션 → 활동 이력 검토`

### 작업

- parent/subtask와 blocked/blocking/related/duplicate relation
- cycle과 cross-project dependency 검증
- internal/project/customer visibility comment
- mention과 notification event
- 사용자 친화 Activity projection
- permission·visibility·export를 포함한 Audit event
- duplicate merge 시 source relation과 attachment 처리 policy

### 완료 조건

- relation cycle과 self-reference를 거부한다.
- 고객 댓글과 내부 댓글이 같은 body의 UI flag로만 구분되지 않는다.
- Activity는 correction을 표시하고 Audit 원본을 수정하지 않는다.
- comment retry와 mention Worker 재실행이 중복 알림을 만들지 않는다.

## R4 Core Gate

다음 수직 흐름을 실제 Electron과 Control Plane에서 통과해야 R5의 AI Workspace 연결을 시작한다.

```text
owner login
-> personal/company Organization
-> Team
-> Project and ProjectTeam
-> WorkItem APP-1
-> My Work
-> Board move
-> comment and Activity
-> Workspace open request
```

Gate 조건:

- cross-tenant와 customer/internal visibility suite 통과
- stale ETag, duplicate request, Realtime loss와 offline recovery 통과
- Windows, macOS, Linux desktop smoke 통과
- Project/WorkItem API와 Renderer 사이에 access token 노출 없음
- WorkItem ID가 기존 GitHub/GitLab work item과 충돌하지 않음
- 기존 Orca Workspace, Worktree, terminal 핵심 회귀 통과

## R4-08 Cycle과 rollover proposal

### 작업

- Team timezone 기반 Cycle schedule과 active/upcoming/completed 상태
- Cycle 생성·수정·닫기와 WorkItem 배정
- 하나의 active Team Cycle invariant
- capacity projection과 scope change Activity
- 미완료 WorkItem rollover proposal
- cycle sidebar와 progress/assignee distribution

### 완료 조건

- DST와 timezone 경계에서 시작·종료가 일관된다.
- Cycle 종료가 WorkItem이나 Release를 자동 완료하지 않는다.
- proposal을 거부하거나 일부만 다음 Cycle로 옮길 수 있다.
- Team 이동 시 기존 Cycle 이력을 보존하고 새 Team Cycle을 재검증한다.

## R4-09 Initiative·Milestone·ProjectUpdate

### 작업

- Initiative CRUD와 explicit InitiativeProject relation
- Initiative list와 project timeline
- Project Milestone CRUD, 정렬, WorkItem 배정과 progress projection
- ProjectUpdate draft, revision, internal/customer publish
- on_track/at_risk/off_track health와 update reminder
- AI summary를 받을 수 있는 draft port만 정의하고 R5 전 자동 생성은 제외

### 완료 조건

- Initiative membership은 filter 변화로 자동 추가·제거되지 않는다.
- 제한 Project가 Initiative rollup에서 제목·health를 노출하지 않는다.
- Milestone 완료와 고객 Acceptance를 구분한다.
- AI update 초안이 사람 확인 없이 게시되거나 Project health를 변경하지 않는다.
- 고객 게시 update를 수정하면 새 revision과 correction 이력이 남는다.

## R4-10 Intake와 WorkItem 승격

### 사용자 흐름

`외부 요청 수신 → Intake 검토 → Team·Project 선택 → WorkItem 생성 또는 duplicate 연결`

### 작업

- source adapter와 IntakeItem normalize contract
- pending/needs_info/accepted/duplicate/declined 상태
- routing suggestion과 사용자 확정 분리
- accept transaction: WorkItem create + source binding + Activity
- duplicate canonical relation
- unassigned AgentSession source placeholder
- quarantine attachment와 payload size/classification policy
- triage 책임자와 notification

### 완료 조건

- 같은 external delivery를 반복해도 IntakeItem과 WorkItem 결과가 하나다.
- accept response 유실 후 같은 idempotency key로 결과를 찾는다.
- inferred Team·Project·duplicate가 자동 확정되지 않는다.
- decline이 외부 source의 삭제나 고객 응답을 암묵적으로 수행하지 않는다.
- R5 collector가 없어도 unassigned session 계약을 synthetic fixture로 검증한다.

## R4-11 Filter DSL과 SavedView

### 작업

- versioned filter AST와 allowlisted field/operator registry
- authorization-aware query compiler
- filter, group, sort, display와 list/board/timeline layout
- private/team/project/organization visibility
- create/update/duplicate/share/transfer/archive
- favorite와 default start view
- temporary filter URL과 persistent view 구분
- field/schema deprecation과 degraded view state

### 완료 조건

- raw SQL, arbitrary field path와 unbounded recursive filter를 저장하지 않는다.
- view 공유가 resource grant를 새로 만들지 않는다.
- 동일 view를 고객과 내부 사용자가 열 때 허용된 서로 다른 결과가 나온다.
- Initiative 수동 Project 집합과 Project SavedView 동적 결과가 섞이지 않는다.
- owner 탈퇴·Team 보관과 field 제거 후 복구·이전 경로가 있다.

## R4-12 Realtime·offline cache·search projection

### 작업

- Project execution resource의 serverSequence change feed
- Main session broker의 Realtime subscription
- SQLite read cache와 organization/user/permission version key
- resync cursor와 snapshot fallback
- My Work, key lookup과 permission-aware search projection
- revoke·role change·Project visibility change cache invalidation
- draft와 server-accepted mutation 상태 분리

### 완료 조건

- Realtime event를 유실·중복·역순으로 받아도 snapshot과 같은 결과가 된다.
- 조직 전환 시 이전 tenant cache row가 보이지 않는다.
- permission 회수 후 offline cache와 search snippet이 민감 내용을 새로 노출하지 않는다.
- 상태 이동, Intake accept, 고객 게시와 승인 mutation은 offline에서 실행되지 않는다.

## R4-13 외부 reference 읽기 연결

### 작업

- provider-neutral ExternalReference와 sync cursor
- GitHub Issue/PR, GitLab Issue/MR, Jira Issue, Linear Issue read projection
- local WorkItem link/unlink와 explicit identity mapping
- provider webhook duplicate/reorder/delete 처리
- provider rate limit, stale 표시와 reconnect

### 완료 조건

- 외부 issue를 Pie WorkItem으로 자동 동일시하지 않는다.
- GitHub 이름을 generic review entity에 사용하지 않는다.
- GitLab self-managed URL과 provider capability 차이를 보존한다.
- email만으로 외부 user와 Pie User를 자동 결합하지 않는다.

## R4 Planning Gate

외부 알파 전 다음을 검증한다.

- Team, Project, WorkItem, Cycle, Initiative, Milestone과 ProjectUpdate 실제 사용자 흐름
- Intake의 manual, external issue, synthetic unassigned agent source
- SavedView의 private/team/project/organization 공유와 deny matrix
- My Work, Inbox, Intake가 원본을 중복 소유하지 않는 projection test
- customer/partner/viewer/admin 역할의 list, detail, search, Realtime, export 결과
- multi-device conflict, network flap, revoke와 restore 후 cache validation
- Project 1,000개, WorkItem 100,000개 조직 fixture의 query·비용 baseline
- accessibility와 Windows/macOS/Linux package smoke

## 첫 구현 PR 묶음

한 PR에 R4 전체를 넣지 않는다. 첫 묶음은 다음 순서가 적절하다.

1. `R4-00A`: Team, Workflow, Project, WorkItem JSON Schema와 fixtures
2. `R4-00B`: PostgreSQL migration, RLS와 cross-tenant integration tests
3. `R4-01A`: personal default Team provisioning과 Team API
4. `R4-02A`: 기본 Workflow template과 state transition API
5. `R4-03A`: Project·ProjectTeam API와 permission projection
6. `R4-04A`: WorkItem create/get, Team sequence와 ETag
7. `R4-05A`: My Work list, quick create와 detail panel read path
8. `R4-06A`: Board move와 conflict recovery
9. `R4-07A`: Activity와 최소 comment
10. `R4-CG`: Core Gate 자동화

각 PR은 schema/migration/API/UI를 무조건 모두 포함할 필요는 없다. 하지만 사용자 흐름이 완성되기 전
중간 layer를 “기능 완료”로 표시하지 않는다.

## Issue 작성 템플릿

```text
Outcome:
Actor and permission:
Organization/Team/Project scope:
Happy path:
Denied and conflict paths:
API/schema/event changes:
Desktop states:
Offline/Realtime behavior:
Migration and rollback:
Tests and release evidence:
Out of scope:
```

## R4 제외 범위

- AI transcript 실제 ingest와 Artifact provenance: R5
- 고객 계약·견적·원가·청구: R6/R9
- 서비스 티켓 SLA와 remote support: R8
- 자동 Project completion과 AI 자동 customer publish
- CRDT 기반 공동 문서 편집
- arbitrary custom SQL view와 user-defined script automation
- Initiative 다중 parent·깊은 hierarchy와 weighted financial progress
- 전용 search engine 도입

## R5 인계 계약

R5는 R4 Core Gate 이후 다음 contract만 사용한다.

- Project와 WorkItem opaque ID
- Team, Project permission과 content visibility
- `Workspace에서 열기` command와 ExecutionContext request
- `sourceType=unassigned_agent_session` IntakeItem
- WorkItem Activity와 Artifact/Evidence link port
- Realtime resource invalidation

R5 collector가 WorkItem status table을 직접 수정하거나 Project permission을 자체 판단하지 않는다.
