# 프로젝트 실행 모델

## 목표

Pie의 프로젝트 포털을 빠른 업무 실행에 최적화된 데스크톱 작업면으로 만든다. Linear의 Issue,
Project, Cycle, Triage, Initiative와 Custom View에서 검증된 작업 방식을 참고하되, Pie의 고객·계약,
SI 승인, AI 실행, Artifact와 원격 host 경계를 포함해 다시 설계한다.

Linear API나 화면과의 호환을 목표로 하지 않는다. 외부 Linear 연결은 `ExternalReference` adapter로
처리하고 Pie의 중앙 모델을 외부 provider 필드에 종속시키지 않는다.

## 최상위 모델

```text
Organization
├── Team
│   ├── WorkItem Workflow
│   ├── Cycles
│   ├── Backlog
│   └── WorkItems
├── Initiatives
│   └── Projects
│       ├── Participating Teams
│       ├── Milestones
│       ├── WorkItems
│       ├── Project Updates
│       ├── Delivery Workflow
│       └── Artifacts and Evidence
├── Intake
│   ├── Customer Requests
│   ├── Service Tickets
│   ├── External Issues
│   └── Unassigned Agent Sessions
└── Saved Views
```

## 소유권 결정

| 대상 | 소유자 | 이유 |
|---|---|---|
| WorkItem identifier | Team | 팀별 연속 키와 업무 유입 지점을 안정적으로 유지 |
| WorkItem status workflow | Team | 팀마다 실행 절차가 다르고 Project를 옮겨도 상태 의미를 보존 |
| Cycle | Team | 팀의 기간 계획과 capacity를 표현 |
| Project | Organization | 여러 Team·고객·참여 조직을 묶는 결과 단위 |
| Milestone | Project | 프로젝트 내부 checkpoint와 납품 목표를 표현 |
| Delivery Workflow | Project | 내부·고객 승인과 필수 Artifact를 실행 업무 상태와 분리 |
| Initiative | Organization | 여러 Project를 목표에 따라 수동으로 구성 |
| IntakeItem | Organization + routing Team | 외부 입력을 정규 WorkItem 전에 검토 |
| SavedView | User, Team, Project 또는 Organization | 공유 범위와 권한을 명시 |
| ProjectUpdate | Project | 시점별 health, 진행, 위험과 다음 행동을 기록 |

## Team

Team은 조직도가 아니라 업무 처리 규칙의 소유자다. 부서·스쿼드·개인 작업 공간을 같은 모델로
표현할 수 있다.

여기서 Team은 사람의 업무 Team이다. Claude Agent Teams나 Runtime orchestration worker 집합은
`AgentGroup` 또는 별도 orchestration 용어와 ID를 사용하고 중앙 TeamMembership·permission을
재사용하지 않는다.

```text
Team
- id / organizationId
- name / identifier / description
- parentTeamId?
- defaultWorkflowDefinitionId
- defaultEstimateScaleId?
- defaultCyclePolicyId?
- visibility
- status / version
```

- `identifier`는 조직 안에서 고유한 짧은 ASCII key다. 예: `PLAT`, `APP`, `PERS`.
- 가입 시 personal Organization에 기본 Team을 하나 만든다.
- Organization Membership과 Team Membership을 분리한다. 한 사용자는 같은 조직의 여러 Team에
  참여할 수 있다.
- Team visibility는 project와 resource grant를 우회하지 않는다.
- Team 보관 시 기존 WorkItem과 식별자 alias를 보존하고 새 업무 생성을 막는다.
- Team 이름이나 identifier 변경은 기존 deep link를 깨뜨리지 않도록 alias 이력을 남긴다.

### 업무 식별자

```text
WorkItemIdentifier
- workItemId
- teamId
- sequence
- displayKey
- validFrom / validUntil
- isPrimary
```

WorkItem의 실제 ID는 opaque UUID이고 `APP-142` 같은 display key는 사용자 탐색과 외부 연결용이다.
Team 이동 시 새 primary key를 발급할 수 있지만 이전 key는 alias로 계속 조회되며 감사 이력을 남긴다.

## WorkItem과 Workflow

모든 WorkItem은 하나의 `teamId`를 반드시 가진다. `projectId`는 team backlog와 개인 업무를 위해
nullable로 둘 수 있지만 다음 행위에는 Project 연결이 필요하다.

- 고객·협력사 공개
- Milestone 또는 Delivery Workflow 연결
- Project Artifact와 Evidence 생성
- AI ExecutionContext와 공유 Workspace 실행
- 계약, 고객 요청, 서비스 티켓과의 납품 관계

```text
WorkItem
- id / organizationId / teamId / projectId?
- primaryIdentifierId
- parentId? / milestoneId? / cycleId?
- type / title / description
- workflowStateId / workflowVersion
- priority / estimate / dueAt?
- assigneeId? / creatorId
- customerVisibility
- sortKey / version
- createdAt / updatedAt / archivedAt?
```

### 상태 category

사용자 정의 상태 이름과 별개로 다음 고정 category를 가진다.

```text
triage -> backlog -> unstarted -> started -> completed
                                      \-> canceled
```

- category는 progress, cycle rollover와 기본 view의 공통 의미다.
- Team은 category 안에 `Ready`, `In Development`, `In Review` 같은 상태를 여러 개 정의할 수 있다.
- 상태 삭제는 기존 WorkItem이 남아 있으면 대체 상태 mapping을 요구한다.
- 상태 이동은 `expectedVersion`, `fromStateId`, `toStateId`, `workflowVersion`을 검증한다.
- Git·AI·automation은 상태 이동을 제안할 수 있지만 고객 승인이나 Delivery Workflow를 자동 확정하지
  않는다.

### 두 Workflow의 분리

| Workflow | 대상 | 예시 |
|---|---|---|
| WorkItem Workflow | 개별 업무 실행 상태 | Todo → In Progress → Review → Done |
| Delivery Workflow | 프로젝트 단계와 승인 | 요구사항 작성 → 내부 승인 → 고객 승인 → 잠금 |

WorkItem이 `completed`여도 Delivery Stage는 검토 대기일 수 있다. 반대로 고객이 특정 산출물을 승인해도
다른 WorkItem을 자동 완료하지 않는다. 둘의 연결은 `EvidenceRule`과 명시적 transition policy로만
정의한다.

## Project와 참여 Team

Project는 명확한 결과, 기간과 책임자를 가진 cross-team 실행 단위다. SI 프로젝트에서는 고객,
계약과 참여 조직 관계를 추가한다.

```text
Project
- id / ownerOrganizationId
- customerId? / contractId?
- name / summary / description
- statusId / priority / health
- leadMembershipId?
- startAt? / targetAt?
- visibility / version
```

```text
ProjectTeam
- projectId / teamId
- role: lead | contributor | reviewer | support
- joinedAt / leftAt?
```

- Project status는 backlog, planned, started, completed, canceled category를 가진 사용자 정의 상태다.
- 모든 WorkItem 완료를 Project 완료와 동일하게 보지 않는다. Project 상태와 health는 명시적 사용자
  명령 또는 승인된 policy로 변경한다.
- Project는 여러 Team을 가질 수 있고 WorkItem의 Team은 참여 Team이어야 한다.
- 고객·협력사 visibility는 ProjectTeam이 아니라 ProjectOrganizationRelation과 ResourceGrant로
  판정한다.
- Project dependency는 WorkItem dependency와 별도 relation으로 관리한다.

## Initiative

Initiative는 조직의 목표나 프로그램에 기여하는 Project를 사람이 의도적으로 묶은 집합이다.
필터 조건으로 자동 구성되는 SavedView와 구분한다.

```text
Initiative
- id / organizationId
- name / description
- status / priority / health
- ownerMembershipId?
- startAt? / targetAt?
- visibility / version
```

```text
InitiativeProject
- initiativeId / projectId
- contributionType
- sortKey
- addedBy / addedAt
```

- 첫 버전은 Initiative와 Project의 명시적 관계만 지원한다.
- 하위 Initiative, 다중 parent와 weighted progress는 실제 portfolio 요구가 확인된 뒤 추가한다.
- progress는 Project 상태·기간·health의 projection이며 원본 Project를 다시 쓰지 않는다.
- Linear와 달리 Pie Initiative는 고객·사업부 제한이 필요하므로 항상 조직 전체 공개로 고정하지 않는다.
- Initiative를 공유해도 제한 Project의 제목·health·일정이 자동 공개되지 않는다.

## Cycle

Cycle은 Team이 일정 기간 집중할 WorkItem의 계획 단위다. Release, Milestone이나 계약 납기와 동일하지
않다.

```text
Cycle
- id / organizationId / teamId
- number / name?
- startsAt / endsAt
- status: upcoming | active | completed | canceled
- capacityPolicySnapshot
- version
```

```text
CycleWorkItem
- cycleId / workItemId
- addedAt / removedAt?
- addedBy
- rolloverFromCycleId?
```

- 한 시점에 WorkItem은 Team의 한 Cycle에만 활성 배정된다.
- Cycle 날짜와 Team timezone을 명시하고 UTC 경계 계산 규칙을 고정한다.
- Cycle 종료 시 미완료 업무는 자동 완료하지 않는다. backlog, 다음 Cycle, 현재 active 유지 중 조직
  policy에 따른 proposal을 만든다.
- capacity는 최근 완료 estimate와 현재 참여자를 사용한 projection이다. 초기에는 경고만 제공하고
  업무 추가를 차단하지 않는다.
- Release는 실제 배포 단위, Milestone은 Project checkpoint, Cycle은 팀의 timebox다.

## Milestone

Milestone은 Project 내부 단계를 나누는 계획 checkpoint다.

```text
Milestone
- id / organizationId / projectId
- name / description
- targetAt?
- status
- sortKey / version
```

- WorkItem은 같은 Project의 Milestone 하나에 선택적으로 연결된다.
- progress는 해당 Milestone의 WorkItem 상태 projection으로 계산한다.
- Milestone 완료가 고객 Acceptance를 의미하지 않는다.
- `Internal Alpha`, `Beta`, `Customer Review`, `Go Live`처럼 납품 문맥을 표현할 수 있다.
- target date 변경과 WorkItem 재배정은 Activity로 남긴다.

## Intake

Intake는 외부·자동 수집 항목을 정규 업무에 넣기 전 검토하는 공통 inbox다. `Unassigned Activity`를
별도 예외 화면으로 만들지 않고 Intake source 중 하나로 통합한다.

```text
IntakeItem
- id / organizationId
- sourceType / sourceId / externalReferenceId?
- suggestedTeamId? / suggestedProjectId?
- title / summary / payloadObjectId?
- classification / visibility
- status: pending | needs_info | accepted | duplicate | declined
- assigneeMembershipId?
- deduplicationKey?
- version
```

초기 source type:

- `manual_request`
- `customer_request`
- `service_ticket`
- `external_issue`
- `unassigned_agent_session`
- `integration_event`

### Intake 처리

- `accepted`: WorkItem을 생성하거나 기존 WorkItem에 연결하고 source relation을 보존한다.
- `duplicate`: canonical WorkItem/IntakeItem을 지정하고 첨부·요청 관계를 이동 또는 참조한다.
- `needs_info`: 요청자와 필요한 필드를 기록하고 정규 workflow에는 넣지 않는다.
- `declined`: 사유와 actor를 기록하며 source 원본 보존정책을 따른다.
- accept와 source binding은 한 서버 transaction에서 처리하고 idempotency key를 요구한다.
- AI가 제안한 Team, Project, priority와 duplicate는 `inferred`이며 사용자가 확인하기 전 확정하지 않는다.
- Intake payload는 일반 WorkItem description보다 낮은 신뢰 입력으로 취급하고 attachment quarantine,
  secret scan과 크기 제한을 적용한다.

## SavedView

SavedView는 조건에 맞는 최신 resource를 동적으로 계산하는 저장된 질의다.

```text
SavedView
- id / organizationId
- ownerMembershipId
- resourceType: work_item | project | initiative | intake_item
- scopeType / scopeId?
- name / description?
- visibility: private | team | project | organization
- layout: list | board | timeline
- filterDefinition / groupDefinition / sortDefinition
- displayDefinition
- schemaVersion / version
```

- filter는 versioned AST/JSON DSL로 저장하고 SQL 문자열을 저장하지 않는다.
- authorization과 field visibility를 먼저 적용한 뒤 filter, group, sort를 계산한다.
- view 공유는 데이터 접근권한을 부여하지 않는다. 권한이 다른 사용자는 허용된 결과만 본다.
- 임시 filter가 있는 URL과 영구 SavedView를 구분한다.
- 사용자가 모르는 enum/property는 조용히 다른 조건으로 바꾸지 않고 degraded 상태를 표시한다.
- owner가 탈퇴하거나 Team이 보관될 때 view ownership 이전·보관 policy를 적용한다.
- 첫 버전은 구독 알림을 제외하고 view 결과·공유·즐겨찾기에 집중한다.

### Filter 연산자

초기 필드와 연산자는 allowlist로 시작한다.

```text
fields: status, category, team, project, assignee, priority, label,
        cycle, milestone, dueAt, customer, updatedAt, visibility
operators: equals, not_equals, in, not_in, is_empty, before, after,
           contains_any, contains_all
combinators: and, or
```

recursive depth, clause 수와 result page 크기에 제한을 두고 조직별 custom field는 schema registry를
통해서만 filter에 추가한다.

## ProjectUpdate

ProjectUpdate는 자동 계산된 progress와 별개인 시점별 관리 보고다.

```text
ProjectUpdate
- id / organizationId / projectId
- periodStart? / periodEnd?
- health: on_track | at_risk | off_track
- summary / progress / risks / nextActions
- authorMembershipId
- visibility
- revision / publishedAt
```

- 최신 update는 Project overview의 대표 health 근거가 되며 과거 update는 시간순으로 보존한다.
- 수정은 revision을 만들고 이미 고객에게 게시된 update를 조용히 덮어쓰지 않는다.
- AI는 event와 Artifact를 바탕으로 초안을 만들 수 있지만 health 선택과 게시자는 사람이다.
- customer visibility update는 내부 update와 별도 publish action을 요구한다.
- reminder와 알림은 Project lead, cadence와 최근 게시 시각을 기준으로 Worker가 생성한다.
- Project status, health, percent complete는 서로 다른 값이다.

## My Work와 Inbox

`My Work`는 별도 업무 원본이 아니라 현재 사용자에 대한 projection이다.

```text
My Work
├── Assigned
├── Created
├── Participating
├── Reviewing
├── Approving
└── Recently viewed
```

`Inbox`는 알림과 action request projection이고 `Intake`는 조직으로 들어오는 미분류 업무 원본이다.
둘을 같은 테이블이나 같은 읽음 상태로 합치지 않는다.

## 데스크톱 작업면

```text
Global Module Rail
├── Portal
├── Workspace
├── Customers
├── Support
└── Conversations

Portal Context Sidebar
├── My Work
├── Inbox
├── Intake
├── Initiatives / Projects / Cycles
├── Views
└── Teams

Resource Surface
├── List / Board / Timeline
├── Filter / Group / Sort / Display
├── Multi-select Action Bar
└── Right Detail Panel
```

열 너비, Workspace 상태 보존, Project Board와 Workspace Board의 분리 및 후속 모듈 배치는
[데스크톱 UI 정보구조](./29-desktop-ui-information-architecture.md)를 따른다.

- 앱 시작 기본 화면은 사용자의 `My Work` 또는 지정한 SavedView다.
- WorkItem은 전체 페이지 전환 없이 오른쪽 detail panel에서 빠르게 검토·수정한다.
- Project Overview는 summary, lead, status, health, dates, milestones, latest update, resources를 보여준다.
- list와 board는 같은 query·selection 상태를 공유한다.
- timeline은 R4에서 Project·Initiative·Milestone을 우선하며 WorkItem gantt는 SI 일정 기능에서 추가한다.
- 빠른 생성은 현재 Team·Project·View filter를 기본값으로 사용하되 사용자가 확인할 수 있게 한다.
- multi-select 변경은 item별 권한·version 결과를 반환하고 일부 실패를 전체 성공처럼 표시하지 않는다.
- 단축키는 macOS의 `⌘`와 다른 플랫폼의 `Ctrl+`를 구분하고 command palette와 동일 command registry를
  사용한다.
- Portal에서 `Workspace에서 열기`를 실행하면 Project·WorkItem 문맥을 유지한 채 기존 terminal 작업면으로
  이동한다.

## 권한 카탈로그

| resource | 주요 action |
|---|---|
| Team | create, view, update, archive, manage_members, manage_workflow |
| Initiative | create, view, update, link_project, publish_update, archive |
| Project | create, view, update, manage_teams, manage_members, archive |
| WorkItem | create, view, update, move_state, assign, comment, archive |
| Cycle | create, update, assign_work, close |
| Intake | view, triage, accept, decline, assign |
| SavedView | create, view, update, share, transfer, delete |
| ProjectUpdate | create, edit_own, publish_internal, publish_customer |

고객·협력사 사용자에게 Team 전체 backlog, Initiative portfolio와 private SavedView를 기본 공개하지
않는다. 고객 사용자는 허용된 Project와 customer visibility WorkItem·Update만 조회한다.

## Realtime과 오프라인

- List/Board/View 결과는 Control Plane snapshot이 권위자다.
- Realtime은 resource ID, version과 server sequence를 전달하는 invalidation이다.
- WorkItem draft와 comment draft는 local 임시 저장할 수 있다.
- 상태 이동, assignee 변경, Cycle 배정, Intake accept, 고객 게시와 승인은 online mutation이다.
- optimistic UI는 pending 상태를 표시하고 `412` 충돌 시 이전 위치와 최신 server 상태를 복구한다.
- SavedView definition은 server version을 기준으로 하고 임시 local filter와 구분한다.
- offline cache는 마지막 권한 확인 시각을 표시하고 revoke 이후 새 민감 데이터를 제공하지 않는다.

## 자동화 경계

허용 가능한 초기 자동화:

- PR/MR draft, review, merge 상태에 따른 WorkItem 상태 이동 제안
- Cycle 종료 시 미완료 업무 rollover 제안
- Intake Team·Project·duplicate 후보 제안
- ProjectUpdate 초안과 위험 signal 생성
- due date, blocked dependency, stale update 알림

사람 확인 없이 금지하는 초기 자동화:

- 고객 공개와 고객 승인
- Project 또는 Initiative 완료
- WorkItem 대량 삭제·보관
- 원격 명령과 배포
- inferred AI 완료만으로 WorkItem 완료
- 고객 계약·비용·일정 기준 변경

## 외부 기준에서 가져온 원칙

- Linear는 Project를 명확한 결과를 가진 여러 Team의 작업 단위로 정의한다.
  [Linear Projects](https://linear.app/docs/projects)
- Initiative는 목표에 따라 Project를 수동으로 묶고, Project View는 filter에 따라 동적으로 구성한다.
  [Linear Initiatives](https://linear.app/docs/initiatives),
  [Linear Custom Views](https://linear.app/docs/custom-views)
- Cycle은 Release와 분리된 Team timebox다.
  [Linear Cycles](https://linear.app/docs/use-cycles)
- Triage는 외부 Team과 integration에서 들어온 업무를 정규 workflow 전에 검토한다.
  [Linear Triage](https://linear.app/docs/triage)
- Milestone은 Project 내부 checkpoint이며 WorkItem 진행률을 roll up한다.
  [Linear Project Milestones](https://linear.app/docs/project-milestones)
- Project Update는 health와 서술형 진행 정보를 함께 제공한다.
  [Linear Initiative and Project Updates](https://linear.app/docs/initiative-and-project-updates)

Pie는 이 원칙에 고객·계약·visibility, Delivery Workflow, AI session·Artifact와 Runtime 실행 문맥을
추가한다.

## R4 핵심 완료 기준

- personal Organization에 기본 Team이 생성되고 회사 조직의 여러 Team에 참여할 수 있다.
- Team workflow와 Project Delivery Workflow가 별도 상태와 permission으로 동작한다.
- cross-team Project에서 Team별 WorkItem key, list, board와 detail panel을 사용할 수 있다.
- stale version의 board 이동, multi-edit와 Cycle 배정이 충돌을 숨기지 않는다.
- Initiative의 수동 Project 목록과 SavedView의 동적 결과가 서로 다른 계약을 가진다.
- Intake accept가 WorkItem 생성·source binding과 함께 멱등 transaction으로 처리된다.
- ProjectUpdate가 내부·고객 visibility와 revision을 지킨다.
- My Work, Inbox, Intake와 Workspace가 같은 항목을 다른 의미로 중복 소유하지 않는다.
- 고객·협력사가 Team backlog, 제한 Project, 내부 update와 SavedView를 조회하지 못한다.
