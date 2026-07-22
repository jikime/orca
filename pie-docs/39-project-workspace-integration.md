# 프로젝트·작업·Workspace 통합 구현 순서

## 결정

업무 포털의 첫 화면은 `내 작업`과 `프로젝트` 두 진입점으로 단순화한다. Team, Inbox와 Intake는
도메인에서 유지하지만 다중 Team이나 미분류 요청이 실제로 생기기 전에는 기본 내비게이션에 노출하지
않는다.

프로젝트의 보드, 변경 요청, 결과물, 결함, 위험, 결정과 상태보고서를 서로 같은 수준의 전역 메뉴로
두지 않는다. 기능은 삭제하지 않고 다음 프로젝트 작업면 안에서 제공한다.

```text
프로젝트
├── 개요
├── 작업
│   ├── 보드
│   └── 목록
├── 납품·품질
│   ├── 변경 요청
│   ├── 결과물
│   └── 결함
└── 관리
    ├── 위험
    ├── 결정
    └── 상태보고서
```

개인·일반 개발 프로젝트는 `개요`와 `작업`을 기본 노출한다. 고객 검수나 SI 통제가 필요한 프로젝트만
`납품·품질`과 `관리`를 확장한다. 숨김은 기능 삭제나 권한 부여를 의미하지 않는다.

## 책임 경계

| 영역      | 권위 있는 원본                              | 책임                                                       |
| --------- | ------------------------------------------- | ---------------------------------------------------------- |
| 내 작업   | Pie WorkItem query와 외부 source projection | 사용자가 지금 처리할 업무를 모아 보여준다.                 |
| 프로젝트  | Control Plane Project·WorkItem              | 계획, 담당, 우선순위, 업무 상태와 납품 문맥을 관리한다.    |
| Workspace | 로컬·WSL·SSH 실행 상태                      | Worktree, 터미널, 에이전트와 실제 실행 상태를 관리한다.    |
| 외부 업무 | 각 provider + ExternalReference             | GitHub·GitLab·Linear·Jira 식별자와 동기화 상태를 보존한다. |

`내 작업`은 새 aggregate가 아니라 `assignee=me`를 중심으로 한 WorkItem projection이다. 외부 issue를
Pie WorkItem으로 자동 변환하거나 제목으로 동일시하지 않는다.

## 연결 계약

Pie WorkItem과 Workspace의 연결은 외부 provider 연결 필드와 분리한다.

```text
PieWorkspaceContext
- schemaVersion
- organizationId
- projectId
- projectName (표시용 snapshot, optional)
- workItemId
- workItemIdentifier
- workItemTitle
```

- `organizationId`, `projectId`, `workItemId`는 제목이나 경로가 아닌 불변 식별자를 사용한다.
- WorkItem은 Project에 연결되어 있어야 Workspace 실행 문맥을 만들 수 있다.
- 하나의 WorkItem은 여러 Workspace를 가질 수 있다.
- 하나의 Workspace는 한 시점에 하나의 기본 Pie WorkItem 문맥만 가진다.
- 로컬·WSL·SSH의 실행 위치는 기존 Workspace host 계약이 소유하며 Pie 문맥에 절대 경로를 저장하지
  않는다.
- 잘못 연결한 문맥은 변경할 수 있지만 이전 연결과 변경 actor는 Activity/Audit로 남긴다.
- WorkItem 상태와 Workspace 상태는 별개다. 실행 시작, PR·MR, 테스트 결과는 상태 변경 제안의
  근거이며 자동 완료의 근거가 아니다.

## 단계별 구현

현재 상태(2026-07-21): P1부터 P4까지 구현했다. P5 `외부 reference`는 별도 TODO 문서로 분리해
개발을 보류한다. P6를 진행할 때도 외부 provider 결과 연결은 같은 보류 범위를 따른다.

현재 데스크톱 화면의 기능, 자원별 생성·편집 필드, API·ETag와 검증 증거는
[프로젝트 작업면 기능 가이드](./41-project-workspace-feature-guide.md)에서 관리한다.

### P1. 내비게이션과 프로젝트 작업면

- 기존 왼쪽 사이드바를 `Orca | Pie` 모드 탭으로 구분하고 Pie 내부의 중복 사이드바를 제거한다.
- 업무 포털 기본 진입점을 `내 작업`, `프로젝트`로 축소한다.
- `내 작업`은 현재 사용자가 담당한 WorkItem만 요청한다.
- 프로젝트 작업면 안에 개요, 작업, 납품·품질, 관리 탭을 둔다.
- Team은 기본 Team 하나를 자동 사용하고 다중 Team 지원 전까지 선택기를 숨긴다.

구현 메모: `개요`는 프로젝트 목록을 반복하는 화면이 아니라 선택한 프로젝트의 작업, 변경 요청,
결과물, 결함, 위험, 최근 상태보고서와 결정 현황을 요약하는 대시보드다. 프로젝트 선택기는 모든 탭에
유지하며 요약 카드에서 관련 세부 탭으로 바로 이동할 수 있다.

`내 작업`과 프로젝트 작업 보드는 카드를 Workflow 컬럼 사이로 드래그해 상태를 바꿀 수 있다. Electron의
네이티브 HTML5 DnD 대신 앱 내부 포인터 추적과 좌표 기반 컬럼 판별을 사용한다. 화면은 이동을 즉시
반영하되 Control Plane의 WorkItem·Workflow version 검증을 생략하지 않으며, 충돌이나 허용되지 않은
전이는 원래 컬럼으로 되돌린다.

프로젝트와 프로젝트 하위 자원의 생성은 화면 안쪽 임시 입력란이 아닌 Dialog에서 처리한다. 프로젝트,
변경 요청, 결과물, 결함, 위험과 상태보고서는 같은 Dialog 패턴으로 편집하고 version 기반 ETag를
사용한다. 프로젝트 Dialog만 종료·중단을 포함한 전체 생명주기 상태를 제공한다. 결정은 당시의 근거와
책임을 보존해야 하므로 생성 후 수정하지 않는 기록으로 유지한다.

### P2. WorkItem에서 Workspace 열기

- WorkItem detail에 `Workspace에서 열기`를 추가한다.
- Project 연결과 permission을 먼저 확인한다.
- 기존 Workspace를 선택하거나 저장소·host·agent를 골라 새 Workspace를 만든다.
- Workspace 상단에 Project와 WorkItem key를 표시하고 포털 복귀 동작을 제공한다.

구현 메모: Pie 문맥은 일반 Git worktree, 폴더 저장소 workspace, project-group folder workspace 모두에
같은 버전 계약으로 저장한다. 새 작업공간 생성의 백그라운드 재시도와 로컬·WSL·SSH runtime RPC에서도
문맥을 보존한다. 이미 다른 Pie 업무에 연결된 작업공간은 빠른 연결 목록에서 제외해 암묵적 재연결을
막는다.

### P3. 내 작업과 기존 작업 화면 연결

- Pie WorkItem을 기존 GitHub·GitLab·Linear·Jira 실행 항목과 같은 `작업` 진입점에서 조회한다.
- Pie는 외부 provider가 아니므로 기존 `TaskProvider` 열거형에 억지로 추가하지 않고 내부 source로
  구분한다.
- 저장소가 없어도 `내 작업`은 열 수 있으며 Workspace 생성 시점에만 저장소와 host를 요구한다.

구현 메모: Orca `작업` 화면에 Pie를 내부 source로 추가하고, Pie source에서는 외부 provider 조회 효과를
마운트하지 않는다. Git 저장소가 없는 환경에서 `작업`을 열면 `Pie · 내 작업`으로 진입하며, WorkItem을
열람하는 동안에는 저장소나 host를 요구하지 않는다. 기존 GitHub·GitLab·Linear·Jira source와 Pie는
같은 상단 source 전환 영역에서 오갈 수 있지만 Pie는 `TaskProvider`와 기본 외부 provider 설정에
포함하지 않는다.

### P4. 채팅·회의 왕복

- 채팅 메시지와 회의 액션에서 생성한 WorkItem을 `내 작업`과 프로젝트에 즉시 표시한다.
- WorkItem에서 원본 채팅·회의로, 원본에서 WorkItem으로 이동한다.
- 같은 source를 반복 변환해도 WorkItem이나 source binding을 중복 생성하지 않는다.

구현 메모: 채팅에서 만든 WorkItem은 생성자를 기본 담당자로 지정하며, 회의 액션에 담당자가 없으면
변환한 사용자를 기본 담당자로 지정한다. 원본 연결은 설명 문자열이 아니라 provider-neutral
`source binding` 조회 계약으로 제공하고, 호출자의 원본 열람 권한과 채널 멤버십으로 필터링한다. 채팅
메시지는 source row lock 뒤 기존 binding을 확인해 서로 다른 idempotency key나 동시 요청에서도 하나의
WorkItem만 만든다. 채팅과 회의에서는 이미 연결된 WorkItem을 바로 열 수 있고, WorkItem에서는 원본
메시지 또는 회의의 정확한 액션 항목을 열어 강조한다. 기존 설명 기반 채팅 링크는 이전 데이터와 서버를
위한 읽기 호환 경로로만 유지한다.

### P5. 외부 reference

- 상태: `개발 보류`
- provider-neutral ExternalReference와 명시적 link/unlink를 구현한다.
- 외부 상태와 WorkItem 상태는 project policy가 있는 경우에만 mapping한다.
- 동기화 지연, rate limit, 삭제와 provider 연결 해제를 사용자에게 표시한다.

상세 TODO와 재개 조건은 [외부 업무 연동 TODO](./40-external-work-integration-todo.md)에서 관리한다.

### P6. 결과 연결

- Workspace, AgentSession, commit, review, test와 Artifact를 WorkItem Activity에 연결한다.
- GitHub PR뿐 아니라 GitLab MR과 다른 review provider를 같은 일반 계약으로 처리한다.
- AI 완료 메시지만으로 WorkItem이나 Project를 완료하지 않는다.

Workspace와 내부 AgentSession 결과 연결은 외부 업무와 독립적으로 진행할 수 있다. commit, PR·MR,
외부 review provider 연결은 P5 재개 전까지 구현 범위에서 제외한다.

## 완료 기준

- 왼쪽 업무 포털에 세부 도메인 7개가 같은 수준으로 노출되지 않는다.
- 로그인한 사용자는 저장소 유무와 관계없이 `내 작업`을 열 수 있다.
- 프로젝트 안에서 WorkItem과 보조 업무를 문맥 전환 없이 탐색한다.
- WorkItem에서 로컬·WSL·SSH Workspace를 열고 원래 프로젝트로 돌아올 수 있다.
- 같은 WorkItem의 여러 Workspace와 외부 reference가 서로 덮어쓰이지 않는다.
- 프로젝트 보드와 Workspace 보드의 상태 변경이 암묵적으로 연동되지 않는다.
