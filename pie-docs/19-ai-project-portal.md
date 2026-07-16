# AI 작업 프로젝트 포털

## 목표

Pie를 터미널이 포함된 프로젝트 관리 도구가 아니라, 프로젝트 업무에서 시작한 AI 실행과 코드·문서
산출물을 검토·승인까지 연결하는 로컬 우선 프로젝트 포털로 정의한다. 프로젝트 관리 화면과 개발
Workspace를 하나의 화면으로 축소하지 않고, 동일한 업무 문맥을 공유하는 두 작업면으로 제공한다.

```text
개인 또는 조직
├── Team
│   ├── WorkItem Workflow and Cycles
│   └── Backlog and WorkItems
├── Initiative
│   └── Project
│       ├── Milestones and Project Updates
│       └── WorkItem
│           ├── ExecutionWorkspace
│           │   ├── Worktree 또는 Folder Workspace
│           │   ├── Terminal Session
│           │   └── Agent Session
│           │       ├── Agent Turn and Tool Events
│           │       └── Agent/Subagent Runs
│           ├── Artifacts, Commits, Reviews, Tests
│           └── Evidence, Approval, Activity
├── Intake
│   └── Unassigned Agent Sessions and External Requests
└── Saved Views
```

## 현재 소스에서 확인한 기반

### Orca에 이미 있는 기능

- AI Vault는 Claude, Codex, Gemini, Cursor, OpenCode 등 여러 CLI 에이전트의 로컬·원격 세션을
  탐색하고 세션 ID, 실행 호스트, 작업 디렉터리, 브랜치, 모델, 메시지 수를 정규화한다.
- Agent Hook은 사용자 프롬프트, 최근 응답, 도구명과 입력, provider session, 탭, pane, Worktree,
  SSH connection, subagent와 orchestration task 문맥을 수집한다.
- `Project`, `ProjectHostSetup`, `Worktree`, Folder Workspace와 GitHub·GitLab·Linear·Jira 업무
  연결이 존재한다.
- Workspace Kanban은 Worktree 상태, 사용자 정의 열, 다중 선택, Drag and Drop을 제공한다.
- Runtime orchestration은 SQLite에서 agent task DAG, dispatch, message, decision gate를 관리한다.
- 로컬 프로필, cloud-linked 프로필, 조직 선택, 조직 멤버와 초대의 기초 계약이 존재한다.

### 현재 Orca 기반의 한계

- 현재 `Project`는 저장소 그룹에 가까우며 고객, 조직, 업무, 워크플로우를 소유하는 중앙 프로젝트가
  아니다.
- AI Vault의 세션 목록은 최근 5개 메시지와 메시지당 220자 미리보기를 위한 모델이다. 전체 대화
  보존, 증분 동기화, 삭제 전파를 위한 저장 계약이 아니다.
- 세션과 프로젝트 연결은 실행 호스트와 `cwd` 경로를 이용한 추론이다. 같은 경로, 이동한 폴더,
  재개한 세션, 여러 업무가 같은 저장소를 공유하는 경우의 영구 관계가 없다.
- Workspace Kanban의 카드는 Worktree다. 하나의 업무가 여러 Worktree·세션·PR을 가질 수 있는
  프로젝트 칸반과는 목적이 다르다.
- Runtime orchestration task는 에이전트 실행 DAG다. 일정, 담당자, 고객 승인, SLA를 가지는
  비즈니스 `WorkItem`을 대신하지 않는다.

### KROOT에서 재사용할 개념

- 개인·프로젝트 업무, 담당자, 참여자, 인수인계, 승인, 의존성, 하위 작업, 반복, 템플릿
- 프로젝트·업무 채팅, 알림, 읽음, 메모, 도움 요청과 이벤트 이력
- 마스터·서브 프로젝트, 프로젝트 멤버, 고객사·개발사 관계
- 단계형 Workflow, Workflow Template, 필수 산출물, 내부 승인, 고객 승인과 잠금
- Evidence, 진행률, 일정, 보고서, 감사 이벤트
- 역할 기반 Command Definition, 실행 instance, 허용 환경변수와 명령 allowlist
- Markdown 업무 ingest의 external key, content hash, checksum, dry-run과 멱등 병합 방식

KROOT 화면과 런타임을 그대로 이식하지 않는다. KROOT의 Claude 전용 JSONL 세션 API와 AI Coding
화면은 Orca AI Vault보다 범위가 좁다. 또한 `packages/kroot-mcp-server`는 원격 명령용 scaffold이고
별도 `mcp-server`는 Claude Agent Teams용 도구 서버이므로 하나의 완성된 MCP 구현으로 간주하지
않는다. 도메인 규칙, 상태 전이, API 계약과 테스트 시나리오만 선별하여 Pie 경계에 맞게 재구현한다.

## 제품 작업면

### 포털 작업면

- 조직 전환, Inbox, My Work, Intake와 개인 업무
- Team, Workflow, Cycle과 team backlog
- Initiative, 프로젝트 생성·보관, 프로젝트 포트폴리오와 건강도
- 프로젝트 개요, 칸반·목록·간트, Workflow, 산출물, 활동, 멤버, 설정
- 업무 상세의 설명, 완료 조건, 담당자, 의존성, 대화, 세션, 산출물, 승인
- Filter·Group·Sort를 저장하는 SavedView와 ProjectUpdate
- 내부 직원·고객·협력사별 제한된 프로젝트 보기

### 실행 작업면

- 저장소·실행 호스트 선택과 Workspace 생성
- Worktree, 터미널, 파일, 브라우저, AI 에이전트, Diff와 검토
- 현재 연결된 프로젝트·업무와 기록 상태의 지속 표시
- 실행 결과를 업무에 첨부하고 포털 작업면으로 복귀

업무 카드를 터미널 카드로 대체하지 않는다. 포털의 `WorkItem`은 중앙 서버의 업무 단위이고,
Workspace Board는 현재 장비에서 실행 중인 작업 공간을 빠르게 다루는 실행 보기다.

## 개인과 조직

- 가입 시 사용자마다 `type=personal`인 기본 Organization을 하나 만든다.
- personal Organization에는 업무 identifier와 Workflow를 소유하는 기본 Team을 하나 만든다.
- 개인 공간과 회사 공간은 같은 Project, WorkItem, Session, Artifact 모델을 사용한다.
- 사용자는 여러 Organization Membership을 가질 수 있고 요청마다 활성 조직을 선택한다.
- 프로젝트에는 하나의 소유 조직과 여러 참여 조직을 연결할 수 있다.
- 참여 조직의 관계는 `customer`, `vendor`, `partner`, `auditor`처럼 명시한다.
- 조직 역할, 프로젝트 역할, 업무 참여자 역할을 분리한다.
- 개인 공간의 프로젝트를 회사 공간으로 이전할 때 소유권, 비밀, Git 연결, 세션과 산출물의 이동
  범위를 dry-run으로 확인한다.

## 핵심 엔터티 경계

| 엔터티 | 권위자 | 목적 |
|---|---|---|
| Team | Control Plane | WorkItem identifier·Workflow·Cycle을 소유하는 업무 처리 단위 |
| Initiative | Control Plane | 목표에 따라 여러 Project를 명시적으로 묶는 포트폴리오 단위 |
| Project | Control Plane | 고객·조직·Workflow·업무·산출물을 포함하는 비즈니스 경계 |
| Milestone | Control Plane | Project 내부 checkpoint와 WorkItem 진행률 집계 |
| ProjectUpdate | Control Plane | 시점별 health·진행·위험·다음 행동의 versioned 보고 |
| WorkItem | Control Plane | 칸반, 담당자, 일정, 승인과 완료 조건을 가진 업무 |
| Cycle | Control Plane | Team의 기간별 업무 계획. Release·Milestone과 별도 |
| IntakeItem | Control Plane | 외부 요청과 미할당 AI 활동을 WorkItem 전에 검토하는 원본 |
| SavedView | Control Plane | 권한 인식 filter·group·sort·layout 정의 |
| ExecutionWorkspace | Control Plane 메타 + Runtime 상태 | 업무를 실행하는 host·repo·folder·Worktree 문맥 |
| TerminalSession | Runtime | PTY 생명주기와 입력·출력 스트림 |
| AgentSession | Control Plane 메타 + 로컬 원본 | provider 대화 세션과 재개 식별자 |
| AgentRun | Runtime + Control Plane | 업무에 대해 수행한 한 번의 실행 시도 |
| AgentTurn | 수집기 | 사용자 입력부터 최종 응답까지의 논리적 turn |
| AgentEvent | 수집기 | hook, tool, status, transcript에서 관찰한 append-only 이벤트 |
| Artifact | Control Plane | 파일, 문서, patch, commit, PR, test, report의 공통 메타데이터 |
| Evidence | Control Plane | 검토·승인 판단에 사용한 Artifact와 실행 결과의 고정 참조 |
| CommandRun | Control Plane + Runtime | 승인된 원격·로컬 명령의 요청, 실행, 취소, 결과 |

한 `WorkItem`은 여러 ExecutionWorkspace, AgentSession, AgentRun과 Artifact를 가질 수 있다.
하나의 AgentSession에는 하나의 기본 WorkItem만 두되 다른 업무와의 관련 링크는 허용한다. 기본 업무
변경은 기존 이벤트를 다시 쓰지 않고 유효 시점이 있는 `SessionBinding` 이력으로 남긴다.

모든 WorkItem은 Team을 가지며 Project 연결은 backlog 단계에서 선택적일 수 있다. AI 실행을 공유하고
Artifact·Evidence를 Project에 제출하려면 Project에 연결되어야 한다. Team의 WorkItem Workflow와
Project의 Delivery Workflow를 같은 상태 머신으로 합치지 않는다. Initiative, Cycle, Intake,
SavedView와 ProjectUpdate의 상세 의미는 [프로젝트 실행 모델](./27-project-execution-model.md)을 따른다.

## 명시적 문맥 연결

업무에서 `Workspace에서 열기`를 실행할 때 Main과 Runtime이 서명된 `ExecutionContext`를 만든다.

```text
ExecutionContext
- organizationId
- projectId
- workItemId
- workspaceId
- repositoryId
- hostId
- launchId
- actorId
- visibilityPolicyId
- issuedAt / expiresAt
```

- 컨텍스트는 Renderer가 임의로 만든 문자열이 아니라 Main이 서버 권한을 확인한 뒤 Runtime에 전달한다.
- 로컬·WSL·SSH·Relay마다 host identity와 경로 해석을 분리한다.
- provider session을 처음 확인하면 `launchId`와 결합해 `AgentSession`을 생성한다.
- 세션 재개 시 provider session과 host를 먼저 확인하고, 마지막 binding과 현재 명시적 문맥이 다르면
  사용자에게 연결 대상을 확인시킨다.
- 앱 밖에서 시작했거나 연결에 실패한 세션은 `sourceType=unassigned_agent_session`인 IntakeItem으로
  넣는다.
- `cwd`·브랜치·Worktree 기반 추론은 후보를 제안할 뿐 자동 확정하지 않는다.
- 잘못 연결된 세션은 재분류할 수 있지만 원래 연결과 수정 행위를 감사 이벤트로 보존한다.
- SSH·공용 build host에서는 로그인한 OS 사용자와 project scope 밖의 transcript를 검색하거나
  upload하지 않는다. host 관리 권한과 project data 접근권한을 같은 것으로 간주하지 않는다.

## 수집 아키텍처

```text
Agent Hooks --------------------┐
Provider Transcript Reconciler -+-> Event Normalizer -> Local SQLite Outbox
Runtime/Git/Test Observers ------┘                         |
                                                         v
                              Control Plane Ingest API -> Event Store/Metadata
                                                         |       |
                                                         |       +-> Object Storage
                                                         +----------> Search/Timeline Projection

Pie MCP Server <-> LLM client <-> Project/WorkItem API
Realtime Gateway -> projection invalidation and server-side changes
Relay -> approved remote command and terminal streams
```

### 수집 채널의 역할

| 채널 | 사용 목적 | 사용하지 않는 목적 |
|---|---|---|
| Agent Hook | 실시간 상태, prompt, response preview, tool 경계 | 유일한 전체 대화 원본 |
| Transcript Reconciler | 누락 이벤트 복구, 전체 turn 정규화, compaction 확인 | 실시간 상태의 유일한 근거 |
| MCP | 프로젝트 문맥 조회, 업무·댓글·산출물 변경 | 모든 prompt·response의 자동 수집 보장 |
| Ingest API | 이벤트 batch, checkpoint, idempotency, 첨부 업로드 | LLM이 직접 호출하는 업무 도구 |
| Realtime | 서버 변경 통지와 재동기화 | 대용량 transcript·터미널 출력 전송 |
| Relay | 원격 명령·PTY·데스크톱 스트림 | 일반 업무 이벤트와 채팅 전송 |

Hook과 transcript는 상호 보완한다. Hook이 없는 provider, 앱 종료, 네트워크 중단, transcript 지연을
정상 상태로 취급하고 마지막 byte offset 또는 provider cursor부터 다시 읽는다. 원본이 삭제·압축·
회전되면 추측으로 내용을 채우지 않고 누락 구간을 명시한다.

## 이벤트 계약

모든 이벤트는 append-only envelope를 사용한다.

```text
AgentEventEnvelope
- eventId
- schemaVersion
- organizationId / projectId / workItemId
- producerId / producerType / trustDomain
- workspaceId / hostId / launchId
- agentSessionId / provider / providerSessionId
- agentRunId / turnId / subagentId
- streamId / sequence
- type
- source: hook | transcript | runtime | git | test | user
- assertion: observed | declared | inferred
- occurredAt / capturedAt / receivedAt
- classification / visibility
- payload or payloadObjectId
- contentHash
- correlationId / causationId
```

- `observed`는 Hook·Git·테스트처럼 Pie가 직접 관찰한 사실이다.
- `declared`는 에이전트 또는 사용자가 완료했다고 보고한 내용이다.
- `inferred`는 경로·브랜치·LLM 분류로 추정한 내용이며 자동 승인이나 완료의 근거로 쓰지 않는다.
- local `observed`는 해당 client installation이 관찰했다는 뜻이지 server가 사실을 독립 검증했다는
  뜻이 아니다. server-observed Webhook·provider API·서명된 CI 결과와 trust domain을 분리한다.
- upload batch는 client installation key와 session으로 producer를 bind해 전송 중 위조·재사용을
  막는다. 손상되거나 악성인 endpoint가 만든 내용을 진실로 증명하는 기능으로 표현하지 않는다.
- `eventId`는 재시도에 유지하고 서버는 조직과 event ID 조합으로 멱등 처리한다.
- 같은 stream의 sequence는 누락 탐지에 사용한다. 서로 다른 host의 전역 순서를 client time으로
  만들지 않는다.
- turn이 streaming 중이면 provisional event를 만들 수 있지만 최종 content hash가 확인된 뒤
  immutable turn revision을 확정한다.

## 데이터 저장

schema, tenant key, index, Object metadata와 로컬 SQLite 파일의 물리 구조는
[데이터베이스 물리 설계](./30-database-physical-design.md)를 따른다.

### 로컬

- Node 내장 SQLite 기반 event outbox와 upload checkpoint
- 원본 transcript의 경로·inode에 의존하지 않는 provider cursor
- 권한이 유효한 서버 projection의 제한된 cache
- outbox byte quota, 오래된 원문의 pause 정책, 사용자에게 보이는 동기화 상태
- crash 직후 event 생성과 checkpoint 갱신이 분리되지 않는 transaction

### 중앙

- PostgreSQL: Project, WorkItem, 관계, 권한, session·turn·artifact 메타데이터
- Object Storage: 큰 transcript chunk, 도구 결과, patch, report, 첨부, 녹화
- Search: 권한·분류·보존정책이 포함된 파생 projection
- Audit Store: binding 수정, 열람, 공유, 내보내기, 승인, 원격 명령

전체 transcript와 대형 도구 출력을 PostgreSQL 행에 직접 누적하지 않는다. 원본은 content-addressed
chunk로 저장하고 DB에는 hash, byte range, Object ID, parser version을 둔다. 요약과 검색 색인은
언제든 원본에서 다시 생성할 수 있는 파생 데이터로 취급한다.

## 산출물과 추적성

- 파일 편집 이벤트와 제출 가능한 Artifact를 구분한다.
- Artifact는 생성 도구, provider, agent run, 입력 source, host, repository, commit, content hash를 가진다.
- 비Git 파일은 upload 또는 명시적 link 전에는 다른 사용자에게 공유되지 않는다.
- commit rebase·force push·branch 삭제 후에도 당시 commit SHA와 patch evidence를 보존한다.
- PR·MR은 provider-neutral review reference를 사용하고 GitHub 전용 필드로 일반 모델을 만들지 않는다.
- test·build 결과는 명령, 실행 환경, source revision, exit code, parser version과 함께 저장한다.
- Evidence로 사용된 Artifact 버전은 새 파일 업로드로 덮어쓰지 않는다.
- AI 생성 문서와 요약은 사용한 source와 model·prompt policy version을 남기고 사람의 승인을 대체하지
  않는다.

## 칸반과 상태

- Project Kanban의 source of truth는 `WorkItem.status`다.
- Workspace Board의 source of truth는 로컬 실행 공간의 `workspaceStatus`다.
- 외부 Jira·Linear·GitHub·GitLab 상태는 `ExternalReference`와 명시적인 상태 mapping으로 연결한다.
- 이름이 같은 열을 자동으로 동일 상태로 간주하지 않는다.
- 세션 시작은 `진행 중` 추천, PR 생성은 `검토` 추천, 테스트 성공은 완료 조건 충족 신호로 사용한다.
- 에이전트의 완료 메시지만으로 업무를 `완료` 처리하지 않는다.
- 자동 상태 변경은 project policy가 허용하고 사전조건이 충족된 경우에만 수행하며 원인 이벤트와
  policy version을 기록한다.
- 외부 공급자와 양방향 동기화할 때 origin marker와 version을 사용해 update loop를 차단한다.

## Pie MCP 역할

초기에는 Electron이 로컬 `stdio` MCP server를 실행하고 Claude Code, Codex 등 지원 client가 이를
사용하도록 한다. MCP server는 사용자 token 원문을 agent process에 주지 않고 Main의 session broker를
통해 Control Plane을 호출한다.

### 초기 도구 그룹

- `pie.project.get`, `pie.project.search`
- `pie.work_item.get`, `pie.work_item.list`, `pie.work_item.create`
- `pie.work_item.comment`, `pie.work_item.propose_status`
- `pie.artifact.register`, `pie.evidence.attach`
- `pie.run.report`, `pie.decision.request`

읽기, 추가형 쓰기, 상태 변경, 원격 실행은 별도 scope와 승인 정책을 가진다. 파괴적 도구는 입력과
대상 리소스를 사용자에게 보여주고 호출마다 Main과 서버에서 다시 인가한다. tool annotation은 힌트일
뿐 신뢰 근거로 사용하지 않는다.

원격 MCP를 제공할 경우 Streamable HTTP, Origin 검증, OAuth resource·audience 검증, PKCE와 최소
scope를 적용한다. MCP client token을 Control Plane이나 외부 공급자에 그대로 전달하지 않는다.
프로토콜 버전과 capability를 협상하고, 실험적인 MCP Tasks를 Pie의 영구 `WorkItem` 모델로 사용하지
않는다.

## 권한과 가시성

### 역할 계층

- Organization role: owner, admin, member, billing admin
- Project organization relation: customer, vendor, partner, auditor
- Project role: customer PM, vendor PM, PL, developer, designer, QA, viewer
- WorkItem participant role: owner, assignee, collaborator, reviewer, approver, viewer
- Machine actor: service principal, client installation, runtime, relay, agent session

### 콘텐츠 가시성

- `private`: 작성자 또는 로컬 장비만
- `internal`: 수행 조직 내부
- `project`: 허용된 프로젝트 멤버
- `customer`: 고객에게 제출된 내용
- `restricted`: 별도 grant와 추가 인증 필요

AgentSession 전체와 개별 turn·artifact는 서로 다른 visibility를 가질 수 있다. 고객에게 결과 문서는
보여주되 내부 prompt, chain-of-thought로 오인될 수 있는 내부 메시지, 비밀이 포함된 tool output은
공개하지 않을 수 있어야 한다. 고객 공개는 별도 제출 행위와 review를 요구한다.

## 개인정보와 기록 정책

- 프로젝트별로 AI 활동 기록을 `off`, `metadata-only`, `selected`, `full` 중 선택한다.
- 기록 중임을 Workspace에 지속 표시하고 사용자가 일시 정지할 수 있게 한다.
- `.env`, credential path, secret pattern, 조직 deny path는 수집 전에 로컬에서 제거한다.
- 기존 observability redactor는 기초로 재사용할 수 있지만 소스코드·개인정보·고객 데이터 정책을
  판정하는 완전한 DLP로 간주하지 않는다.
- 원문, 요약, embedding, 감사 이벤트에 서로 다른 보존기간을 적용한다.
- 탈퇴, 프로젝트 이전, 계약 종료, legal hold, export와 삭제가 transcript·artifact·색인·backup에
  어떻게 전파되는지 정의한다.
- 직원 감시로 오인되지 않도록 조직 정책, 수집 목적, 관리자 열람 범위와 사용자 고지를 제공한다.

## KROOT 기능 이관 순서

기능별 실제 소스 근거와 이관 판정은 [KROOT 기능 이관](./26-kroot-capability-migration.md)을 권위
문서로 사용한다.

| 분류 | 기능 | Pie 처리 |
|---|---|---|
| 우선 이관 | 프로젝트, 멤버, 개인·프로젝트 업무, 칸반 | Control Plane 표준 모델로 재구현 |
| 우선 이관 | Workflow, 단계, 승인, Evidence, 감사 | WorkItem·Artifact와 통합 |
| 우선 이관 | Command registry, 결과, ingest checksum | Runtime·Outbox 계약에 적용 |
| 후속 이관 | 마스터 프로젝트, 회사, 고객, 일정, 보고서 | 프로젝트 포털 안정화 후 확장 |
| 후속 이관 | 업무 채팅, 알림, 템플릿, 통계 | 공통 Realtime·Notification 사용 |
| 대체 | AI Coding UI, Claude JSONL API | Orca AI Vault와 Hook 기반으로 대체 |
| 재설계 | 두 MCP 서버, Web/Tauri shell | Pie MCP와 Electron 경계로 통합 |

## 첫 수직 흐름

1. 사용자가 개인 또는 회사 조직에서 프로젝트를 만든다.
2. 프로젝트 칸반에서 업무와 완료 조건을 만든다.
3. `Workspace에서 열기`로 저장소, host와 agent를 선택한다.
4. Main이 권한을 확인하고 ExecutionContext를 Runtime에 전달한다.
5. Claude Code 또는 Codex를 실행하고 provider session을 업무에 연결한다.
6. Hook 이벤트를 즉시 표시하고 transcript reconciler가 누락된 turn을 보완한다.
7. 변경 파일, commit, test와 PR을 Artifact로 연결한다.
8. 사용자는 session timeline과 Diff를 검토하고 Evidence를 선택한다.
9. 승인자가 완료 조건과 Evidence를 확인한 뒤 업무를 완료한다.
10. 네트워크가 끊겼던 event도 동일 ID로 재전송되어 중복 없이 반영된다.

## P1 완료 기준

- 개인 공간과 회사 조직에서 프로젝트와 업무를 생성할 수 있다.
- 업무에서 native·WSL·SSH Workspace를 열고 Claude Code와 Codex를 실행할 수 있다.
- 세션, turn, tool, 변경 파일, commit, test, PR이 명시적인 업무 ID로 연결된다.
- Hook 누락, 앱 재시작, 네트워크 중단 후 transcript reconciliation과 outbox 재전송이 동작한다.
- 잘못 연결된 세션을 감사 이력을 남기며 재분류할 수 있고 미할당 세션을 잃지 않는다.
- 고객·협력사·내부 사용자가 같은 세션에서 허용된 turn과 Artifact만 조회한다.
- 에이전트 보고만으로 상태·승인·원격 명령이 확정되지 않는다.
- raw transcript를 끄거나 metadata-only로 제한하고 보존·삭제 정책을 적용할 수 있다.

Event batch, item ack, outbox, Artifact upload와 MCP write의 구체적인 실패 의미는
[API·이벤트·동기화 계약](./23-api-event-sync-contracts.md)을 따르고, release 조합은
[검증 매트릭스](./25-verification-test-matrix.md)로 검증한다.

## 참고 기준

- [MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

MCP 명세는 계속 변경되므로 구현은 특정 문서 버전을 계약으로 고정하고 initialize 단계에서 protocol과
capability를 협상한다. 최신 draft를 자동으로 따라가며 저장 형식이나 권한 의미를 바꾸지 않는다.
