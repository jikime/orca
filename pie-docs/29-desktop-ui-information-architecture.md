# 데스크톱 UI 정보구조

## 목표

기존 Orca의 저장소·Worktree·terminal 중심 작업면을 유지하면서 Pie의 프로젝트 포털, 고객관리,
서비스 데스크, 원격지원과 협업 기능을 하나의 Electron 셸에 배치한다. 기능이 늘어나도 실행 중인
Workspace를 잃지 않고, 사용자가 `업무 관리 -> 실제 실행 -> 결과 검토`를 같은 문맥에서 왕복할 수
있어야 한다.

이 문서는 화면 배치와 모듈 간 전환의 기준이다. 도메인 의미는
[프로젝트 실행 모델](./27-project-execution-model.md), 역할별 노출은
[역할과 내비게이션](./01-roles-and-navigation.md), 컴포넌트의 시각 표현은
[`docs/STYLEGUIDE.md`](../docs/STYLEGUIDE.md)를 따른다.

## 현재 UI 기준선

현재 Renderer 셸은 다음 구조를 이미 제공한다.

- `src/renderer/src/App.tsx`: 왼쪽 Sidebar, 중앙 terminal workbench와 page surface, 선택형 RightSidebar
- `src/renderer/src/components/sidebar/index.tsx`: 상단 탐색, 저장소·Worktree 목록, 하단 toolbar
- `src/renderer/src/components/sidebar/WorkspaceKanbanDrawer.tsx`: 로컬·SSH Workspace 상태 보드
- `src/renderer/src/components/right-sidebar/index.tsx`: Explorer, source control, review 등 문맥 패널
- 하단 status bar와 floating workspace

새 기능을 별도 관리 앱처럼 중첩하지 않는다. 현재 3열 셸을 유지하되 왼쪽을 전역 모듈 레일과
문맥 사이드바로 분리하고, 중앙과 오른쪽 영역의 내용만 선택한 모듈에 맞게 교체한다.

## 셸 구조

```text
┌────────┬──────────────────┬──────────────────────────────┬──────────────────┐
│ 전역   │ 문맥 사이드바    │ 주 작업 영역                 │ 우측 인스펙터    │
│ 레일   │                  │                              │                  │
│ 44px   │ 240~320px        │ 가변                         │ 340~420px        │
├────────┴──────────────────┴──────────────────────────────┴──────────────────┤
│ 상태 표시줄 · 실행 상태 · 동기화 · SSH/Relay 연결 상태                    │
└────────────────────────────────────────────────────────────────────────────┘
```

| 영역 | 책임 |
|---|---|
| 전역 레일 | 제품 모듈 전환, 알림, 관리, 사용자 문맥 |
| 문맥 사이드바 | 선택한 모듈의 탐색, 목록, 저장된 보기와 필터 |
| 주 작업 영역 | List, Board, Timeline, Overview, Workspace와 원격 세션 |
| 우측 인스펙터 | 선택 resource의 속성, 활동, AI 세션, 산출물과 승인 |
| 하단 상태 표시줄 | 로컬·WSL·SSH·Relay 실행 위치, 연결, 동기화와 작업 상태 |

전역 레일의 위치와 폭은 모듈 전환 중 바뀌지 않는다. 문맥 사이드바와 인스펙터는 접을 수 있지만
열고 닫을 때 중앙 작업면의 선택, scroll과 query 상태를 잃지 않는다.

## 전역 모듈 레일

전역 레일에는 세부 resource 메뉴가 아니라 큰 업무 모듈만 배치한다. 아이콘에는 tooltip과 접근성
label을 제공하고, 역할과 permission에 없는 모듈은 빈 자리 없이 제거한다.

```text
Pie
────────────
업무 포털
Workspace
고객 관리
지원
대화
────────────
알림
관리
프로필
```

| 모듈 | 기본 사용자 | 주요 작업면 |
|---|---|---|
| 업무 포털 | 전 사용자 | My Work, Inbox, Intake, Project, Initiative, Team |
| Workspace | 개발자, PL, 승인된 지원 인력 | 저장소, Worktree, terminal, editor, browser, Agent |
| 고객 관리 | 영업, PM, 사업 관리자 | 고객사, 담당자, 영업기회, 견적, 계약 |
| 지원 | 지원 엔지니어, 고객 | 티켓, 자산, 원격 세션, Runbook |
| 대화 | 허용된 내부·외부 사용자 | DM, 채널, 회의와 통화 기록 |
| 관리 | 조직 소유자·관리자 | 사용자, Team, 정책, 감사, 연동 |

첫 구현에서는 업무 포털과 Workspace를 노출한다. 고객 관리, 지원과 대화는 해당 수직 흐름이
완료될 때 같은 레일에 순차적으로 추가한다.

## 업무 포털 배치

업무 포털의 문맥 사이드바는 조직·Team 전환과 빠른 업무 탐색을 담당한다.

```text
[조직 / Team 전환]

My Work
Inbox
Intake

계획
  Initiatives
  Projects
  Cycles

Views
Teams
```

- 기본 시작 화면은 통계 dashboard가 아니라 `My Work` 또는 사용자가 지정한 SavedView다.
- `My Work`는 Assigned, Created, Participating, Reviewing, Approving과 Recently viewed projection을
  같은 화면 안의 scope로 제공한다.
- Inbox는 알림과 action request, Intake는 외부 요청과 미할당 AI 세션의 분류 화면으로 분리한다.
- 빠른 생성은 현재 Team, Project와 SavedView filter를 기본값으로 제안하고 저장 전에 표시한다.
- 검색은 WorkItem key, Project, 고객, AgentSession, Artifact와 명령을 포함하는 권한 인식 빠른 열기로
  확장한다.

## Portal 주 작업 영역

Portal resource 화면은 공통적으로 다음 구조를 사용한다.

```text
┌ Breadcrumb / 제목 ─────────────── Search · Create · More ┐
├ List | Board | Timeline ─ Filter · Group · Sort · Display ┤
│                                                           │
│ Resource 결과                                              │
│                                                           │
└ 선택 시 multi-select action bar                            ┘
```

- List와 Board는 같은 query, filter, selection 상태를 공유한다.
- WorkItem 행과 카드에는 key, 제목, 상태, 담당자, 우선순위, Project, Cycle과 연결된 Workspace 상태만
  표시한다.
- Project 화면은 Overview, Work items, Cycles, Milestones, Updates와 Resources 탭을 제공한다.
- Initiative와 Project timeline을 먼저 제공하고 WorkItem Gantt는 SI 일정 기능 단계에서 추가한다.
- 많은 요약 card를 배치하지 않는다. 반복 업무는 밀도 높은 row, table과 lane을 사용한다.

## WorkItem 우측 인스펙터

WorkItem은 별도 전체 페이지로 전환하지 않고 오른쪽 인스펙터에서 검토·수정한다.

```text
PIE-142  로그인 오류 수정

상태       In Progress
담당자     jikime
프로젝트   고객 포털
Cycle      2026-W29
──────────────────────
설명 / 하위 업무
댓글 / 활동
AI 세션
산출물
승인
──────────────────────
[Workspace에서 열기]
```

- 인스펙터를 열어도 기존 List·Board의 scroll, query와 선택을 유지한다.
- 속성 변경은 ETag/version 충돌과 pending 상태를 표시한다.
- Activity에는 사람의 변경, AgentRun, MCP ingest와 Artifact 생성 출처를 구분해 표시한다.
- 고객 visibility, 내부 메모와 승인 권한은 동일한 패널에서도 permission에 따라 분리한다.
- `Workspace에서 열기`는 Project·WorkItem 문맥을 전달하고 기존 Workspace를 선택하거나 새로 만든다.

## Workspace 배치

Workspace 모듈은 현재 Orca의 실행 UI를 유지한다.

| 영역 | 유지·추가 내용 |
|---|---|
| 문맥 사이드바 | 저장소, Project group, 로컬·WSL·SSH Worktree 목록 |
| 중앙 | terminal, editor, browser와 split group |
| 상단 문맥 | `고객 / Project / WorkItem key`, 수집·동기화 상태 |
| 오른쪽 | 기존 Explorer·Source Control·Checks와 WorkItem·AI Activity·Artifacts·Approvals |
| 하단 | host, branch, PTY, Relay와 background job 상태 |

Portal과 Workspace 전환은 terminal, browser, editor와 Agent 세션을 unmount하지 않는다. 숨겨진
Workspace subtree를 유지하고 Portal 화면은 별도 surface로 lazy-load한다. 사용자가 Portal로 돌아오면
직전 resource, view mode, filter, scroll과 선택된 WorkItem을 복원한다.

Workspace 상단 문맥은 자동 연결 결과를 숨기지 않는다. 사용자는 잘못 연결된 Project나 WorkItem을
변경할 수 있고, 앱 밖에서 시작한 세션은 Intake의 `unassigned_agent_session`으로 이동할 수 있다.

## 두 종류의 Board

Project Board와 기존 Workspace Board는 이름과 원본이 다르므로 하나로 합치지 않는다.

| 화면 | 원본 | 상태 의미 | 주요 동작 |
|---|---|---|---|
| Project Board | 서버 WorkItem | Team Workflow의 업무 진행 상태 | 담당, 우선순위, Cycle, 상태 변경 |
| Workspace Board | 로컬·WSL·SSH Workspace | 실제 실행 공간과 Agent 활동 상태 | Worktree 전환, 실행 확인, 정리 |

Project Board 카드는 연결된 Workspace 수와 Agent 실행 상태를 보조 정보로 표시할 수 있다. Workspace
Board는 WorkItem의 권위 있는 상태를 직접 변경하지 않으며, 사용자가 명시적으로 동기화 명령을
실행할 때만 WorkItem mutation을 요청한다.

## 고객 관리, 지원과 대화

### 고객 관리

- 문맥 사이드바: 고객사, 담당자, 영업기회, 견적, 계약, 저장된 보기
- 중앙: 목록과 고객 360도, 계약·Project 관계
- 인스펙터: 담당자, 최근 활동, 열린 Project·티켓과 권한이 허용된 재무 요약

### 지원과 원격 세션

- 문맥 사이드바: 티켓, 고객 자산, 원격 세션, Runbook
- 중앙: queue, 티켓 상세, session 준비와 실행 작업면
- 인스펙터: 고객 동의, 제어 등급, 참가자, 녹화·감사와 연결된 WorkItem
- 원격 terminal은 Workspace 계열의 실행 UI를 재사용하되 일반 개발 Workspace와 security boundary,
  자격 증명, 녹화와 종료 정책을 분리한다.
- Relay와 SSH 연결 상태, 실제 실행 host와 고객 동의 상태를 항상 화면에 표시한다.

### 대화와 화상회의

- 문맥 사이드바: DM, Project 채널, 고객 채널과 회의 목록
- Project·WorkItem 관련 thread는 우측 Activity에서도 접근한다.
- 화상회의는 좁은 인스펙터에 넣지 않고 별도 Electron window 또는 중앙 전체 작업면으로 연다.
- 통화 중에는 작은 제어 surface를 유지하되 terminal, 원격지원 승인과 화면 공유 상태를 가리지 않는다.

## 창 크기와 플랫폼

- 넓은 창에서는 전역 레일, 문맥 사이드바, 중앙 작업면과 인스펙터를 동시에 표시한다.
- 공간이 부족하면 인스펙터를 overlay로 전환하고, 다음으로 문맥 사이드바를 접는다. 전역 레일과
  현재 resource 제목은 마지막까지 유지한다.
- 고정 폭 요소는 `min/max-width`를 사용하고 hover, badge와 loading 상태가 열 너비를 바꾸지 않게 한다.
- macOS는 `⌘`·`⇧`, Linux와 Windows는 `Ctrl+`·`Shift+` shortcut label을 사용한다.
- Electron accelerator는 `CmdOrCtrl`을 사용하고 파일 경로와 host 표시는 로컬·WSL·SSH·Relay를
  구분한다.
- 색상, spacing, type scale, shadow와 shadcn primitive 선택은 `docs/STYLEGUIDE.md`와
  `src/renderer/src/assets/main.css` token을 사용한다.

## Connections 설정

- 로그인 전에도 `Settings > Connections`에서 Pie Cloud와 Self-hosted profile을 선택할 수 있다.
- 일반 사용자는 Control Plane URL 하나만 입력하고 API, Realtime, Relay, Media와 Object Storage 주소를
  개별 입력하지 않는다.
- 연결 테스트는 DNS, TLS, discovery, protocol과 최소 앱 version을 단계별 상태로 표시한다.
- custom CA와 proxy는 고급 설정에 두되 TLS 검증 해제 기능은 제공하지 않는다.
- 여러 instance의 token, 조직, cache와 최근 route가 섞이지 않도록 profile 전환 시 현재 instance와
  account를 title·profile surface에 식별 가능하게 표시한다.

상세 설정 필드와 discovery 계약은
[SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md)을 따른다.

## 상태와 내비게이션 계약

화면 상태는 최소한 다음 두 수준으로 분리한다.

```text
App Surface
├── portal
├── workspace
├── customers
├── support
├── conversations
└── administration

Surface Route State
├── organization / team
├── resource type / resource id
├── view / filter / group / sort
├── selected item
└── sidebar / inspector visibility
```

- surface 전환과 route 변경은 같은 전역 command registry를 사용한다.
- notification, deep link와 command palette는 동일한 permission-aware route resolver를 통과한다.
- RBAC는 메뉴 숨김뿐 아니라 route, Renderer command, Main IPC와 서버 API에서 반복 검증한다.
- 현재 사용자에게 보이지 않는 Project나 고객 정보는 breadcrumb, recent item, badge와 검색 제안에도
  노출하지 않는다.

## 구현 순서

1. 현재 App 셸에서 전역 레일과 surface route state를 분리한다.
2. Workspace subtree를 유지한 채 Portal surface로 왕복하는 상태 보존을 검증한다.
3. 업무 포털 문맥 사이드바와 `My Work` List를 구현한다.
4. WorkItem 우측 인스펙터와 빠른 생성·수정 흐름을 구현한다.
5. `Workspace에서 열기`와 Project·WorkItem execution context를 연결한다.
6. Project Board와 기존 Workspace Board의 교차 상태 표시를 구현한다.
7. Cycle, Initiative, Timeline, Intake와 SavedView를 순차 추가한다.
8. 같은 셸 계약으로 고객 관리, 지원·원격 세션과 대화 모듈을 추가한다.

## 완료 기준

- Portal과 Workspace를 반복 전환해도 terminal process, tab, split과 입력 focus 복구 계약이 깨지지 않는다.
- WorkItem에서 Workspace를 열고 돌아왔을 때 Project, view, filter, scroll과 선택 상태가 복원된다.
- Project Board와 Workspace Board의 상태 및 mutation 권위가 혼동되지 않는다.
- 역할별로 전역 레일, 문맥 사이드바, 빠른 열기와 명령 팔레트의 항목이 일관되게 제한된다.
- 고객과 게스트에게 terminal, 내부 메모, 원가, 제한 Project와 로컬 경로가 노출되지 않는다.
- 로컬, WSL, SSH와 Relay host에서 현재 실행 위치와 연결 상태를 사용자가 식별할 수 있다.
- macOS, Windows와 Linux의 최소 지원 창 크기에서 navigation, title, badge와 action이 겹치지 않는다.
