# 프로젝트 작업면 기능 가이드

## 문서 상태

- 기준일: 2026-07-21
- 구현 상태: 데스크톱 프로젝트 작업면, 개요 대시보드와 생성·편집 Dialog 구현 완료
- 상위 설계: [프로젝트·작업·Workspace 통합](./39-project-workspace-integration.md)
- 외부 업무 범위: [외부 업무 연동 TODO](./40-external-work-integration-todo.md)

이 문서는 프로젝트 메뉴에서 현재 사용할 수 있는 기능, 생성·편집 정책, Control Plane 연결과 검증
범위를 설명한다. 장기 도메인 모델과 구현 순서는 상위 설계 문서가 소유하고, 이 문서는 실제 데스크톱
동작을 기준으로 갱신한다.

## 화면 구성

```text
프로젝트
├── 개요
│   ├── 프로젝트 상태·요약
│   ├── 작업·변경·결함·위험 지표
│   ├── 납품·품질 요약
│   ├── 최근 상태보고서·결정
│   ├── 프로젝트 대화
│   └── 연결 회의·회의 예약
├── 작업
│   ├── 보드
│   ├── 목록
│   └── WorkItem 상세
├── 납품·품질
│   ├── 변경 요청
│   ├── 결과물
│   └── 결함
└── 관리
    ├── 위험
    ├── 결정
    └── 상태보고서
```

프로젝트 선택기는 네 탭 모두에서 유지한다. 선택한 프로젝트를 바꾸면 작업, 납품·품질, 관리와 개요가
같은 프로젝트 문맥을 사용한다. 개요의 요약이나 버튼을 누르면 해당 프로젝트의 세부 탭으로 이동한다.

## 개요 대시보드

| 영역            | 표시 기준                                                              |
| --------------- | ---------------------------------------------------------------------- |
| 작업 항목       | 프로젝트 WorkItem 수, 담당자 미지정 수, `urgent`·`high` 우선순위 수    |
| 대기 중 변경    | `rejected`, `applied`가 아닌 변경 요청 수                              |
| 미완료 결과물   | `accepted`가 아닌 결과물 수                                            |
| 열린 결함       | `closed`, `wontfix`가 아닌 결함 수                                     |
| 열린 위험       | 서버 governance summary의 전체 수와 `critical`·`high` 수               |
| 최근 상태보고서 | 가장 최근 보고서의 전체 상태와 요약                                    |
| 최근 결정       | 최근 결정 최대 3개와 결정일                                            |
| 프로젝트 대화   | 프로젝트 scope의 canonical 채널을 열고 없으면 내부 채널을 생성         |
| 프로젝트 회의   | 프로젝트에 연결된 회의 최대 5개를 표시하고 새 회의를 같은 scope로 예약 |

초기 조회 중에는 지표 값을 `—`로 표시한다. 일부 요청이 실패하면 성공한 데이터는 유지하고 화면 안 오류와
재시도 버튼을 제공한다. 프로젝트를 생성하거나 편집한 직후에는 목록 재조회보다 먼저 저장 응답을 화면에
반영해 이전 이름이나 상태로 되돌아가는 깜빡임을 막는다.

현재 변경 요청·결과물·결함 수는 각 목록 응답에서 데스크톱이 받은 항목을 기준으로 계산한다. 목록이 여러
페이지로 커질 때 정확한 전체 수를 제공하려면 서버 summary/count 계약을 추가해야 한다. 위험 수는 이미
서버 governance summary를 사용한다.

## 생성·편집 UX 정책

프로젝트 및 프로젝트 하위 관리 자원은 본문 안쪽 임시 입력란을 사용하지 않고 shadcn `Dialog`에서
생성·편집한다.

- 필드 수와 여러 줄 입력 수에 따라 기본 폭 또는 넓은 2열 Dialog를 선택한다.
- 긴 양식은 최대 화면 높이 안에서 내부 스크롤한다.
- 필수 필드, 문자열 길이, 숫자·날짜·선택 입력을 각 필드에 적용한다.
- 저장 중에는 중복 제출과 Dialog 닫기를 막고 버튼 문구로 진행 상태를 표시한다.
- API 오류는 입력값을 보존한 채 Dialog 안에 표시한다.
- 선택 취소는 destructive 동작이 아니므로 ghost 버튼을 사용한다.
- 편집에서 선택 필드를 비우면 nullable API 필드는 `null`로 전송해 기존 값을 제거한다.
- 생성에서 비어 있는 선택 필드는 본문에서 생략해 서버 기본값을 사용한다.

WorkItem의 보드 빠른 생성은 반복 업무를 빠르게 입력하는 주 흐름이므로 Dialog로 바꾸지 않는다. 상세
정보가 많은 프로젝트, 변경 요청, 결과물, 결함, 위험, 결정과 상태보고서에만 Dialog 정책을 적용한다.

## WorkItem 보드 이동

`내 작업`과 프로젝트의 `작업 > 보드`는 같은 WorkItem 보드 구현을 사용한다. 카드를 다른 Workflow
컬럼으로 드래그하면 다음 순서로 상태를 변경한다.

1. Electron의 네이티브 HTML5 드래그 전달에 의존하지 않고 카드에서 시작한 포인터를 추적한다. 5px 이상
   이동했을 때만 드래그로 전환하므로 일반 클릭은 상세 열기로 유지한다.
2. 포인터 좌표 아래에 있는 보드 컬럼을 직접 판별한다. 대상이 현재 상태와 다를 때만 드롭을 허용하고
   이동 중인 카드는 다시 드래그하지 못하게 한다.
3. 드롭 즉시 카드를 대상 컬럼에 표시한다.
4. 서버에는 `fromStateId`, `toStateId`, `workflowVersion`, `expectedVersion`을 함께 보내 Workflow와
   WorkItem 버전을 검증한다.
5. 성공하면 서버가 반환한 최신 WorkItem과 version으로 교체하고 목록을 다시 조회한다. 412 충돌이나
   허용되지 않은 전이면 우선 원래 컬럼으로 되돌리고 오류를 표시한 뒤, 목록을 다시 조회해 다른 사용자가
   변경한 canonical 상태와 맞춘다.

상세 패널의 상태 선택기는 드래그를 사용할 수 없는 키보드·보조기술 환경의 동일한 상태 변경 경로로
유지한다.

카드를 선택해 상세 패널을 열면 패널은 최대 24rem 폭으로 화면 오른쪽에 유지하고, 보드 영역만 남은
너비로 줄어든다. Workflow 컬럼의 전체 폭은 상세 패널을 화면 밖으로 밀지 않고 보드 내부 가로 스크롤로
탐색한다.

## 자원별 입력과 수정 범위

| 자원       | 생성·편집 필드                                                   | 정책                                      |
| ---------- | ---------------------------------------------------------------- | ----------------------------------------- |
| 프로젝트   | 이름, 요약, 상태                                                 | 생성 상태는 `planned`·`active`            |
| 변경 요청  | 제목, 설명, 범위 변경, 일정 증감, 비용 증감                      | 승인 Workflow 상태는 별도 action으로 변경 |
| 결과물     | 이름, 설명, 요구사항 ID, 마감일                                  | 제출·수락·거부는 별도 action              |
| 결함       | 제목, 설명, 심각도                                               | 분류·해결·종료는 별도 action              |
| 위험       | 제목, 설명, 범주, 발생 가능성, 영향, 완화 계획                   | 완화·종료·수용은 별도 action              |
| 결정       | 제목, 배경, 결정, 근거                                           | 생성 후 수정하지 않는 불변 기록           |
| 상태보고서 | 시작일, 종료일, 전체 상태, 요약, 주요 성과, 위험 요약, 다음 단계 | 생성·편집 가능                            |

프로젝트 편집에서는 `planned`, `active`, `paused`, `completed`, `cancelled`를 모두 선택할 수 있다. 하위
자원의 일반 편집은 내용만 수정하며 승인·검수·완료 같은 Workflow 전이는 기존 명시적 action을 사용한다.
결정 기록은 당시 근거와 책임을 보존해야 하므로 편집 버튼과 PATCH 흐름을 제공하지 않는다.

## API와 동시성

| 자원       | 생성                                         | 편집                          | ETag prefix      |
| ---------- | -------------------------------------------- | ----------------------------- | ---------------- |
| 프로젝트   | `POST /projects`                             | `PATCH /projects/{id}`        | `project`        |
| 변경 요청  | `POST /projects/{projectId}/change-requests` | `PATCH /change-requests/{id}` | `change-request` |
| 결과물     | `POST /projects/{projectId}/deliverables`    | `PATCH /deliverables/{id}`    | `deliverable`    |
| 결함       | `POST /projects/{projectId}/defects`         | `PATCH /defects/{id}`         | `defect`         |
| 위험       | `POST /projects/{projectId}/risks`           | `PATCH /risks/{id}`           | `project-risk`   |
| 결정       | `POST /projects/{projectId}/decisions`       | 제공하지 않음                 | 해당 없음        |
| 상태보고서 | `POST /projects/{projectId}/status-reports`  | `PATCH /status-reports/{id}`  | `status-report`  |

모든 편집 요청은 현재 resource version으로 `If-Match: "<prefix>-<version>"`을 만든다. 서버가 412를
반환하면 사용자의 오래된 화면으로 다른 사용자의 변경을 덮어쓰지 않고 오류를 Dialog 안에 유지한다. 위험
자원은 서버 계약과 일치하도록 `project-risk` prefix를 사용한다.

## 대화·회의 연결

프로젝트 개요에서 `대화 열기`를 선택하면 기존 프로젝트 채널을 찾는다. 채널이 없을 때만 프로젝트 ID를
scope ID로 하는 내부 채널을 생성한다. 같은 프로젝트에서 반복 실행해도 새 채널을 계속 만들지 않는다.

회의 영역은 `scopeKind=project`, `scopeId=projectId`로 조회한다. 회의를 선택하면 회의 메뉴의 해당 회의로
이동하고, 예약 버튼은 프로젝트 이름을 기본 제목으로 사용해 프로젝트 문맥이 있는 회의 작성 흐름을
연다. 프로젝트가 바뀌면 대화와 회의 scope도 함께 바뀐다.

## 오류와 권한 경계

- Renderer에서 버튼을 숨기는 것만으로 권한을 구현하지 않는다. 생성·편집·전이 권한은 Control Plane이
  다시 검사한다.
- 개요 지표, 대화 생성과 Dialog mutation 오류는 서로 독립적으로 표시한다.
- Dialog mutation 실패 시 입력 내용을 지우거나 상세 panel을 닫지 않는다.
- 생성·편집 성공 후 canonical 목록을 다시 조회한다.
- 프로젝트와 WorkItem의 상태는 Workspace, Worktree, 에이전트 실행 상태와 자동으로 동기화하지 않는다.

## 구현 파일

| 역할                       | 파일                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| 프로젝트 탭·선택·Dialog    | `src/renderer/src/pie/workspace/ProjectWorkspace.tsx`                |
| 프로젝트 전용 생성·편집    | `src/renderer/src/pie/workspace/ProjectMutationDialog.tsx`           |
| 개요 대시보드              | `src/renderer/src/pie/workspace/ProjectOverview.tsx`                 |
| 공통 자원 생성·편집 Dialog | `src/renderer/src/pie/workspace/PieResourceMutationDialog.tsx`       |
| 자원 목록·상세·수정 연결   | `src/renderer/src/pie/workspace/PieResourceScreen.tsx`               |
| 프로젝트 대화 연결         | `src/renderer/src/pie/workspace/pie-resource-conversation.ts`        |
| 자원별 필드·action 설정    | `src/renderer/src/pie/workspace/pie-portal-*-domains.ts`             |
| WorkItem 보드·드롭 연결    | `src/renderer/src/pie/workspace/WorkItemBoard.tsx`                   |
| WorkItem 이동 상태·API     | `src/renderer/src/pie/workspace/use-work-item-board.ts`              |
| WorkItem 포인터 드래그     | `src/renderer/src/pie/workspace/use-work-item-board-pointer-drag.ts` |

## 자동화 검증

2026-07-21 기준 다음 검증을 통과했다.

- Pie Renderer 및 `PieTaskPage` 테스트: 66개 파일, 214개 테스트
- 프로젝트 신규 테스트: 개요 지표·탭 이동·대화 연결, 프로젝트 POST/PATCH·ETag, 생성·편집 본문 변환
- WorkItem 보드 신규 테스트: 포인터 컬럼 이동, 클릭 임계값, 네이티브 DnD 비활성화, 낙관적 이동
  성공·실패 원복
- 실행 중인 Electron 개발 앱에서 실제 WorkItem을 `Todo → In Progress → Todo`로 이동해 서버 반영과
  원상 복구 확인
- `pnpm run typecheck:web`
- `pnpm run build:web`
- 변경 파일 oxlint
- max-lines ratchet, styled scrollbar와 reliability gate
- 영어·한국어·일본어·중국어·스페인어 카탈로그 parity와 번역 coverage

프로덕션 빌드의 기존 CSS `::highlight` 최적화 경고와 정적·동적 import 중복 경고는 빌드를 차단하지
않으며 이번 프로젝트 작업면 변경에서 새로 만든 경고가 아니다.

## 남은 범위

- 목록이 여러 페이지일 때 사용할 정확한 프로젝트 summary/count API
- 프로젝트 목록 초기 실패 화면과 권한별 read-only 설명 강화
- 프로젝트 보관·복원 UI
- ProjectUpdate, Cycle, Initiative, Intake와 SavedView를 포함한 R4 Planning Gate
- Workspace·AgentSession·commit·review·test 결과를 WorkItem Activity에 연결하는 P6
- 외부 Jira·Linear·GitHub·GitLab reference 연동

외부 업무 연동과 회의록 생산성 확장은 현재 범위에 섞지 않는다. 각각 보류 문서의 재개 조건을 만족한
후 별도 단계로 진행한다.
