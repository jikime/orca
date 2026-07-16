# AI 프로젝트 포털 구현 위험과 결정 목록

## 목적

[AI 작업 프로젝트 포털](./19-ai-project-portal.md)을 구현하기 전에 실패 가능성이 높은 경계와
정책 결정을 추적한다. 기능 목록이 아니라 설계·테스트·운영에서 닫아야 할 이슈 목록이다.

## 사용 방법

- `P0`: 데이터 경계, 보안, 영구 식별자처럼 구현 후 변경 비용이 매우 큰 결정
- `P1`: 첫 수직 흐름과 외부 알파 전에 닫아야 하는 결정
- `P2`: 기능 확장 전에 닫아야 하는 결정
- 각 이슈는 ADR, schema, threat model, test 중 하나 이상의 검증 가능한 산출물로 종료한다.
- `결정 필요` 항목은 코드 기본값으로 조용히 확정하지 않는다.

## P0 결정 요약

| ID | 결정 |
|---|---|
| DOM-001 | `WorkItem`, `ExecutionWorkspace`, orchestration task의 ID와 상태를 분리한다. |
| DOM-002 | 개인 공간을 예외 데이터가 아닌 `type=personal` Organization으로 모델링한다. |
| DOM-003 | Project의 소유 조직과 고객·수행·협력 참여 조직 관계를 분리한다. |
| BND-001 | 세션 연결은 유효 시점이 있는 `SessionBinding`으로 관리하고 경로 추론은 제안만 한다. |
| EVT-001 | append-only event envelope, source, assertion, sequence, idempotency 규칙을 고정한다. |
| EVT-004 | client-observed 사실과 server-verified 사실의 trust domain을 분리한다. |
| CAP-001 | Hook, transcript, MCP, Runtime observer의 책임과 신뢰 수준을 분리한다. |
| SEC-001 | AI 기록 기본 수준과 사용자 고지·일시 정지·프로젝트 정책 우선순위를 결정한다. |
| SEC-002 | turn·tool output·artifact의 visibility를 세션 전체 권한과 분리한다. |
| STO-001 | PostgreSQL metadata, Object Storage 원문, Search projection의 소유권을 고정한다. |
| SYN-001 | 로컬 outbox의 transaction, quota, retry, reject와 deletion 규칙을 고정한다. |
| MCP-001 | MCP를 자동 telemetry transport로 사용하지 않고 업무 read/write 도구로 제한한다. |
| RUN-001 | 원격 명령은 arbitrary shell이 아니라 versioned allowlist와 단기 capability로 실행한다. |

## 도메인과 소유권

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| DOM-001 | P0 | Worktree 카드, agent DAG task, 프로젝트 업무를 하나의 `Task`로 합치면 상태와 수명이 충돌한다. | `WorkItem`, `ExecutionWorkspace`, `OrchestrationTask`를 별도 aggregate로 두고 link entity를 사용한다. | 한 업무에 2개 Worktree와 3개 agent run을 연결하는 계약 테스트 |
| DOM-002 | P0 | 개인 기능을 nullable `organizationId`로 구현하면 모든 쿼리에 예외가 생기고 이전이 어렵다. | 가입 시 personal Organization을 만들고 동일한 tenant 규칙을 적용한다. | 개인·회사 간 동일 API fixture와 cross-tenant 거부 테스트 |
| DOM-003 | P0 | SI 프로젝트는 소유자, 고객사, 수행사, 협력사가 다를 수 있다. 하나의 `customerId`만으로 권한을 표현할 수 없다. | `ProjectOwnerOrganization`과 `ProjectOrganizationRelation`을 분리하고 relation role을 둔다. | 고객사 2곳과 협력사 1곳이 참여하는 프로젝트 권한 행렬 |
| DOM-004 | P1 | 하나의 세션이 여러 업무를 오가거나 하나의 업무에 여러 세션이 붙는다. | session에는 한 시점의 primary binding을 두고 cross-reference와 binding history를 별도로 둔다. | 업무 전환 전후 event가 원래 업무에 유지되는 테스트 |
| DOM-005 | P1 | Project Workflow를 수정하면 이미 승인된 단계의 의미가 달라질 수 있다. | template version과 project binding snapshot을 보존하고 실행 중 정의를 덮어쓰지 않는다. | 단계 추가·순서 변경·rollback migration 테스트 |
| DOM-006 | P1 | 외부 Jira·Linear issue와 Pie WorkItem 중 어느 쪽이 권위자인지 불명확하다. | integration별 field authority와 sync direction을 명시한다. | 양쪽 동시 수정과 sync loop 차단 테스트 |
| DOM-007 | P2 | master/subproject 간 멤버, Workflow, 예산, 산출물 상속 규칙이 불명확하다. | 상속 가능한 필드를 allowlist하고 자식 override와 snapshot을 둔다. | 부모 보관·권한 회수·템플릿 갱신 테스트 |
| DOM-008 | P1 | 삭제, 보관, 완료, 취소가 서로 섞일 수 있다. | 각 aggregate의 terminal state와 tombstone 정책을 정의한다. | 보관된 프로젝트의 세션 재개·Webhook·검색 차단 테스트 |

## 신원과 권한

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| IDN-001 | P0 | 사용자, agent process, Runtime, host, client installation의 actor가 혼동될 수 있다. | 사람 `User`, `ServicePrincipal`, `ClientInstallation`, `ExecutionHost`, `AgentSession` 신원을 분리한다. | 한 event의 human initiator와 machine actor를 모두 감사하는 테스트 |
| IDN-002 | P0 | 조직 역할만으로 고객 PM, 수행 PM, 개발자 권한을 표현할 수 없다. | Organization role, Project role, ResourceGrant를 조합하고 기본 거부한다. | 역할·리소스·visibility 허용/거부 행렬 |
| IDN-003 | P0 | offline 중 권한이 회수돼도 outbox가 민감 데이터를 나중에 업로드할 수 있다. | 업로드 때 현재 권한과 capture policy를 다시 확인하고 거부 데이터의 로컬 처리 정책을 둔다. | 권한 회수 후 offline event 재전송 테스트 |
| IDN-004 | P1 | 프로젝트 참여 기간 종료 후 로컬 cache와 transcript가 남는다. | membership 종료 event로 cache key 폐기, session 잠금, 보존·삭제 작업을 시작한다. | 기기 offline 상태에서 복귀 후 폐기 테스트 |
| IDN-005 | P1 | 관리자가 사용자를 대리하거나 agent가 사용자 대신 변경할 때 책임 주체가 흐려진다. | `actor`, `delegatedBy`, `onBehalfOf`, `reason`을 분리하고 고위험 대리는 추가 인증한다. | 관리자 대리 변경의 UI와 감사 재현 |
| IDN-006 | P1 | 마지막 조직 owner 제거, personal org 탈퇴, project owner org 삭제가 고아 데이터를 만든다. | owner invariant와 소유권 이전 transaction을 둔다. | 마지막 owner 제거 및 조직 병합 거부 테스트 |
| IDN-007 | P1 | MCP client가 Pie 사용자 token을 받으면 agent와 plugin이 탈취할 수 있다. | token은 Main에 두고 local MCP는 narrow broker API만 호출한다. | agent process env·stdout·diagnostic에 token 부재 확인 |
| IDN-008 | P0 | 공용 SSH·build host의 관리 권한이 다른 사용자의 transcript 열람 권한으로 오인될 수 있다. | OS 사용자, host identity, project scope와 transcript root allowlist를 모두 확인한다. | 같은 host의 서로 다른 OS 사용자·프로젝트 격리 테스트 |

## 세션 연결과 수집

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| BND-001 | P0 | `cwd` 기반 자동 연결은 같은 경로의 다른 host와 monorepo 업무를 오분류한다. | 명시적 ExecutionContext를 우선하고 host-aware path는 후보 점수에만 사용한다. | native·WSL·SSH 동일 경로 fixture |
| BND-002 | P0 | provider session ID가 provider·host·계정 사이에서 충돌할 수 있다. | server ID와 provider key를 분리하고 provider, account scope, host, session ID를 복합 uniqueness로 둔다. | 동일 session 문자열을 가진 서로 다른 provider 테스트 |
| BND-003 | P1 | 앱 밖에서 시작한 세션, terminal에서 agent를 재실행한 세션이 미연결될 수 있다. | `unassigned_agent_session` IntakeItem과 사용자 assign flow를 제공한다. | unmanaged session 발견·할당·재분류 테스트 |
| BND-004 | P1 | 한 terminal에서 agent를 종료하고 다른 provider를 실행하면 pane identity만으로 혼합된다. | launch와 provider session 경계를 별도 감지하고 terminal relation만 유지한다. | Claude 종료 후 Codex 실행 fixture |
| BND-005 | P1 | 세션 resume 시 원래 업무와 현재 열린 업무가 다를 수 있다. | mismatch 확인 UI와 명시적 새 run 또는 기존 업무 계속 선택을 제공한다. | resume binding 충돌 E2E |
| BND-006 | P1 | subagent와 coordinator가 같은 Worktree를 써서 작업 소유권을 잘못 추론할 수 있다. | provider subagent ID와 orchestration dispatch를 pane/worktree lineage와 분리한다. | 병렬 subagent event attribution 테스트 |
| CAP-001 | P0 | Hook만 믿으면 미지원 provider·앱 종료·hook 실패 시 turn이 사라진다. | transcript reconciliation을 별도 source로 구현하고 source·assertion을 보존한다. | hook 30% drop 후 최종 timeline 복구 테스트 |
| CAP-002 | P0 | transcript만 읽으면 실시간 상태와 tool 시작·취소 시점을 잃는다. | Hook event를 즉시 저장하고 transcript로 최종 content를 확정한다. | tool start 후 process crash fixture |
| CAP-003 | P0 | 같은 hook replay와 transcript record가 중복 turn을 만든다. | provider record key, content hash, turn key와 event ID를 분리해 dedupe한다. | replay·same-text 재실행·동일 prompt 구분 테스트 |
| CAP-004 | P1 | streaming partial response가 최종 응답보다 늦게 도착할 수 있다. | provisional revision과 finalized revision을 분리하고 sequence gap을 표시한다. | 순서 변경과 reconnect replay 테스트 |
| CAP-005 | P1 | transcript compaction이 원문을 제거하거나 요약으로 대체한다. | compaction event와 source range를 기록하고 요약을 원문처럼 표시하지 않는다. | compact 전후 lineage 테스트 |
| CAP-006 | P1 | provider schema 변경으로 parser가 조용히 빈 결과를 낼 수 있다. | parser version, unknown record metric, sample quarantine와 capability degradation을 둔다. | golden fixture와 unknown-field canary 테스트 |
| CAP-007 | P1 | 로컬 시계가 틀리거나 여러 host 시계가 달라 전역 순서가 잘못된다. | occurred/captured/received time을 분리하고 stream sequence를 우선한다. | ±30분 clock skew 테스트 |
| CAP-008 | P2 | 대용량 tool output, binary, image, terminal escape가 memory와 UI를 고갈시킨다. | byte limit, content type sniffing, chunk upload, quarantine와 virtualized rendering을 사용한다. | 수백 MB output과 malformed UTF-8 부하 테스트 |
| CAP-009 | P1 | 사용자가 수정 가능한 local transcript와 Hook payload를 tamper-proof 증거로 오인할 수 있다. | producer·trust domain을 표시하고 server/provider-verified evidence와 구분한다. | local transcript 변조 후 provenance 표시 테스트 |

## 이벤트와 동기화

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| EVT-001 | P0 | source와 신뢰 수준이 없으면 LLM 주장을 실행 사실로 오인한다. | `source`와 `assertion=observed/declared/inferred`를 필수화한다. | agent가 테스트 성공을 거짓 보고하는 fixture |
| EVT-002 | P0 | event schema 변경이 구버전 app·Runtime의 upload를 깨뜨린다. | versioned envelope, additive evolution, unknown event quarantine와 minimum version 정책을 둔다. | N-2 client fixture와 forward-compatible parser 테스트 |
| EVT-003 | P1 | event 수정 허용 시 감사와 timeline 재현이 불가능하다. | 원본은 append-only로 두고 correction·redaction·tombstone event를 추가한다. | 잘못된 binding 보정 후 과거 재현 테스트 |
| EVT-004 | P0 | client가 서명한 event도 손상된 endpoint가 만든 내용의 진실성을 증명하지 못한다. | installation key는 producer binding과 replay 방지에만 사용하고 `client-reported`, `server-observed`, `provider-verified` trust domain을 분리한다. | 위조 batch·복제 device key·server Webhook 대조 테스트 |
| SYN-001 | P0 | event 저장 후 checkpoint만 먼저 갱신되거나 반대 순서면 유실·중복된다. | local event insert와 cursor update를 한 SQLite transaction으로 처리한다. | 각 write 지점 crash injection 테스트 |
| SYN-002 | P0 | 네트워크 장기 중단으로 outbox가 디스크를 채운다. | byte quota, metadata-only degradation, capture pause와 사용자 경고를 둔다. | quota 80/95/100% 단계 테스트 |
| SYN-003 | P0 | 서버가 권한·정책·schema 이유로 batch 일부를 거부할 수 있다. | item별 ack와 permanent/retryable rejection, dead-letter export를 정의한다. | mixed batch 부분 성공 테스트 |
| SYN-004 | P1 | multi-device에서 WorkItem 상태·설명을 동시에 수정한다. | entity version, optimistic concurrency, field별 merge 가능 범위를 정의한다. | board drag와 외부 provider update 경쟁 테스트 |
| SYN-005 | P1 | 삭제 event보다 늦은 create/update replay가 데이터를 부활시킨다. | tombstone version과 deletion watermark를 유지한다. | delete 후 old outbox replay 테스트 |
| SYN-006 | P1 | 재로그인·조직 전환 시 이전 tenant outbox가 현재 token으로 전송될 수 있다. | outbox를 organization과 principal에 partition하고 전송 전에 일치 검증한다. | 계정 A logout 후 B login 테스트 |
| SYN-007 | P2 | upload 성공 후 응답 유실로 같은 Object가 반복 저장된다. | content hash와 upload reservation, finalize idempotency를 둔다. | response drop 후 재시도 테스트 |
| SYN-008 | P1 | local SQLite migration 실패·disk corruption이 outbox와 cursor를 함께 잃게 할 수 있다. | schema migration journal, backup, integrity check, read-only recovery와 raw transcript replay 경로를 둔다. | migration 중 kill·disk-full·corrupt page 복구 테스트 |

## MCP와 자동화

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| MCP-001 | P0 | model이 capture tool을 호출하지 않으면 대화가 누락된다. | telemetry는 Hook·transcript가 담당하고 MCP는 명시적 업무 도구만 제공한다. | MCP 비활성 상태에서도 session timeline 생성 테스트 |
| MCP-002 | P0 | local HTTP MCP가 모든 interface에 bind되면 악성 웹페이지와 프로세스가 호출할 수 있다. | 기본은 child-process stdio다. HTTP가 필요하면 localhost/IPC, Origin 검증과 인증을 적용한다. | DNS rebinding과 다른 로컬 사용자 접근 테스트 |
| MCP-003 | P0 | token passthrough와 generic audience가 confused deputy를 만든다. | MCP audience를 검증하고 downstream API에는 별도 교환한 token을 사용한다. | 잘못된 audience·issuer·tenant token 거부 테스트 |
| MCP-004 | P0 | tool description과 annotation은 악성 MCP server가 조작할 수 있다. | trusted server registry와 server-side permission을 사용하고 annotation만으로 승인하지 않는다. | destructive hint를 속인 도구 테스트 |
| MCP-005 | P1 | project 문서의 prompt injection이 상태 변경·파일 공개를 유도한다. | read content와 action authority를 분리하고 write·share·execute에 사람 또는 policy 승인을 요구한다. | 악성 업무 설명을 포함한 agent E2E |
| MCP-006 | P1 | client마다 resources, prompts, tools, tasks 지원 범위가 다르다. | initialize capability를 저장하고 최소 tools-only fallback을 제공한다. | Claude/Codex와 낮은 protocol fixture 테스트 |
| MCP-007 | P1 | MCP experimental task ID를 Pie 업무 ID로 사용하면 protocol 변경에 종속된다. | MCP Task는 transport execution handle로만 사용하고 WorkItem과 mapping한다. | task protocol 미지원 client fallback 테스트 |
| MCP-008 | P1 | 같은 write tool 재시도가 댓글·업무·artifact를 중복 생성한다. | mutation input에 idempotency key를 요구하고 result에 canonical resource ID를 반환한다. | timeout 후 tool retry 테스트 |
| MCP-009 | P2 | 너무 많은 도구와 큰 schema가 agent context와 선택 정확도를 악화시킨다. | capability별 server/tool group, 짧은 structured result와 pagination을 사용한다. | tool selection 평가와 token budget 회귀 테스트 |
| MCP-010 | P1 | tool call timeout 후 실제 side effect는 성공했는데 agent가 실패로 재시도할 수 있다. | mutation receipt, idempotency key와 `unknown_outcome` 조회 API를 제공한다. | response 직전 연결 종료와 결과 재조회 테스트 |

## 원격 명령과 실행 안전성

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| RUN-001 | P0 | 범용 command string은 shell injection과 권한 우회를 만든다. | versioned command definition과 typed args를 사용하고 기본 `shell=false`로 실행한다. | metacharacter·newline·path traversal 입력 테스트 |
| RUN-002 | P0 | 허용 env에 token·secret이 들어가 output과 transcript로 유출될 수 있다. | env allowlist, secret reference injection, output redaction와 child env 최소화를 적용한다. | process env dump와 crash log 검사 |
| RUN-003 | P0 | UI 승인 후 대상 host·cwd·commit이 바뀔 수 있다. | 승인 대상 snapshot을 capability token에 bind하고 실행 직전 다시 검증한다. | 승인 후 branch·host 교체 TOCTOU 테스트 |
| RUN-004 | P1 | 연결 종료를 명령 취소로 오해하거나 retry가 이중 실행을 만든다. | 명시적 cancel protocol, run ID, lease와 idempotency class를 정의한다. | disconnect·cancel 경쟁과 worker failover 테스트 |
| RUN-005 | P1 | SSH·WSL·Relay host에서 같은 command ID가 다른 binary를 실행한다. | host capability, toolchain fingerprint, working directory proof를 결과에 포함한다. | Git·Node·shell version matrix 테스트 |
| RUN-006 | P1 | kill이 child process tree를 남겨 후속 결과와 포트를 오염시킨다. | 플랫폼별 process group 종료와 orphan reconciliation을 둔다. | macOS·Linux·Windows·SSH orphan 테스트 |
| RUN-007 | P1 | 자동 상태 변경이 실패한 test나 partial output을 성공으로 해석한다. | exit code, parser result, source revision과 완전한 upload ack를 완료 조건으로 사용한다. | truncated log와 parser failure 테스트 |
| RUN-008 | P1 | 무한 stdout·stderr와 느린 upload가 PTY·Realtime·heartbeat를 막을 수 있다. | command output 전용 bounded queue, backpressure, truncation marker와 별도 control channel을 사용한다. | high-volume output 중 cancel·heartbeat 테스트 |

## 산출물과 Git 추적성

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| ART-001 | P0 | 모든 파일 편집을 서버 Artifact로 올리면 비밀·용량·노이즈 문제가 생긴다. | edit observation과 publishable Artifact를 분리하고 프로젝트 capture policy를 적용한다. | `.env`, 대형 build output, deny path 테스트 |
| ART-002 | P1 | rename, delete, symlink, repo 밖 파일을 path 문자열로만 추적하면 잘못된 파일을 가리킨다. | host pathRef, repository-relative path, operation과 content hash를 함께 저장한다. | symlink escape와 case-insensitive path 테스트 |
| ART-003 | P1 | amend·rebase·force push로 commit SHA와 PR head가 달라진다. | 당시 SHA·patch hash와 superseded relation을 보존한다. | history rewrite 후 Evidence 조회 테스트 |
| ART-004 | P1 | GitHub PR 모델을 일반 review로 쓰면 GitLab MR 등에서 필드가 깨진다. | provider-neutral review entity와 provider adapter를 분리한다. | GitHub·GitLab 동일 업무 fixture |
| ART-005 | P1 | test 결과가 다른 source revision이나 host에서 실행될 수 있다. | TestRun에 source SHA, dirty tree hash, command definition, host와 toolchain을 포함한다. | 실행 중 코드 변경 race 테스트 |
| ART-006 | P1 | Evidence로 승인한 파일이 같은 Object key로 덮어써질 수 있다. | immutable storage object와 versioned Artifact를 사용한다. | 승인 후 재업로드·삭제·legal hold 테스트 |
| ART-007 | P2 | binary artifact와 archive에 악성코드·zip bomb이 포함될 수 있다. | 격리 bucket, 크기·압축률 제한, malware scan과 safe preview를 적용한다. | archive bomb과 MIME spoof 테스트 |

## 개인정보와 보안

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| SEC-001 | P0 | 전체 prompt·response 자동 수집이 직원 감시와 고객 비밀 과수집이 될 수 있다. | 명시적 조직 정책, 프로젝트별 capture mode, 지속 표시와 pause를 제공한다. | 정책 변경 전후 수집 범위와 사용자 고지 E2E |
| SEC-002 | P0 | 세션 권한 하나로 모든 turn·artifact를 공개하면 내부 prompt가 고객에게 노출된다. | content item별 classification·visibility와 별도 customer publish workflow를 둔다. | 내부 turn과 고객 Evidence 혼합 세션 테스트 |
| SEC-003 | P0 | regex secret redaction만으로 소스·개인정보·고객 식별정보를 막을 수 없다. | deny path, structured field policy, secret scanner, 조직 DLP hook과 server 재검사를 조합한다. | 키·JWT·개인정보·connection string corpus 테스트 |
| SEC-004 | P0 | 원문은 삭제됐지만 summary·embedding·검색 snippet·backup에 남을 수 있다. | derived data lineage와 deletion fan-out, restore 후 재삭제 ledger를 둔다. | 삭제 후 모든 저장 계층 검증 |
| SEC-005 | P1 | 외부 model로 보내면 안 되는 프로젝트 데이터가 agent context에 포함될 수 있다. | project model policy, provider allowlist, data residency와 local-model option을 둔다. | 제한 프로젝트에서 외부 provider 호출 거부 테스트 |
| SEC-006 | P1 | transcript에 제3자 개인정보와 저작물이 포함될 수 있다. | 목적·보존·열람 정책과 export/redaction workflow를 둔다. | subject export와 부분 redaction 테스트 |
| SEC-007 | P1 | 운영 log와 trace에 prompt·token·path가 재복제될 수 있다. | telemetry field allowlist와 local/server 이중 redaction, payload logging 금지를 적용한다. | 로그·trace·diagnostic bundle secret scan |
| SEC-008 | P1 | 관리자와 지원 인력이 raw transcript를 광범위하게 열람할 수 있다. | break-glass, 추가 인증, reason, 제한 시간과 열람 감사를 적용한다. | 권한 없는 관리자와 break-glass 종료 테스트 |
| SEC-009 | P2 | tenant 간 content dedup이 hash side channel과 삭제 결합을 만든다. | dedup 범위를 tenant·encryption domain 안으로 제한한다. | 동일 파일 cross-tenant 관찰 불가 테스트 |
| SEC-010 | P1 | client-side E2EE를 켜면 server 검색·요약·DLP·법적 보존이 불가능하거나 불완전해진다. | server-managed encryption과 optional client-encrypted local-only mode의 기능 차이를 명시한다. | 암호화 mode별 검색·export·삭제·키 분실 테스트 |
| SEC-011 | P1 | provider 약관, 고객 계약, 근로자 고지와 데이터 처리 지역이 프로젝트마다 다를 수 있다. | model provider policy, DPA·consent metadata, 지역과 학습 사용 제한을 project policy로 관리한다. | 제한 프로젝트의 provider 선택·export 차단 테스트 |

## Workflow와 사용자 경험

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| WFL-001 | P0 | agent의 `done`과 WorkItem 완료를 같은 상태로 취급할 수 있다. | agent run, workspace, work item, workflow stage 상태 머신을 분리한다. | agent 완료 후 검토 대기 상태 테스트 |
| WFL-002 | P1 | AI 자동 상태 변경이 사용자의 칸반 이동을 되돌릴 수 있다. | 자동화는 proposal을 기본으로 하고 policy-enabled transition만 compare-and-set한다. | 수동 이동과 늦은 자동화 경쟁 테스트 |
| WFL-003 | P1 | 승인 중 요구사항·Evidence가 바뀌면 승인 근거가 사라진다. | approval request에 requirement와 artifact version snapshot을 둔다. | 제출 후 파일 변경·재승인 테스트 |
| WFL-004 | P1 | 고객 승인과 내부 승인 순서, 반려 후 재개 규칙이 프로젝트마다 다르다. | versioned transition policy와 required role·artifact를 template로 둔다. | 내부 승인 생략 금지와 reopen 테스트 |
| UX-001 | P1 | 포털 기능이 기존 terminal 공간을 밀어내면 Orca의 핵심 사용성이 훼손된다. | 포털·실행 작업면을 분리하고 업무 문맥으로 왕복한다. | 대형·소형 화면의 프로젝트→Workspace→복귀 E2E |
| UX-002 | P1 | 사용자는 어떤 프로젝트에 기록 중인지 모른 채 민감 작업을 할 수 있다. | Workspace에 project, work item, capture mode, sync 상태를 지속 표시한다. | binding 변경과 capture pause 접근성 테스트 |
| UX-003 | P1 | 긴 session timeline이 UI와 검색을 느리게 한다. | server pagination, turn virtualization, artifact lazy load와 summary projection을 사용한다. | 100만 event 프로젝트 성능 테스트 |
| UX-004 | P1 | 자동 연결 오류를 고칠 방법이 없으면 데이터 신뢰가 무너진다. | Intake에서 재분류, bulk correction과 영향 미리보기를 제공한다. | 100개 session bulk assign·undo 테스트 |
| UX-005 | P2 | offline·stale 권한·부분 동기화를 정상 완료로 표시할 수 있다. | local pending, server accepted, rejected, conflict 상태를 구분한다. | network flap과 auth expiry UI E2E |

## 외부 연동과 마이그레이션

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| INT-001 | P1 | GitHub만 가정하면 GitLab MR, self-hosted URL, provider 권한이 누락된다. | generic review 개념과 provider capability adapter를 사용한다. | GitHub.com·GitLab self-managed fixture |
| INT-002 | P1 | provider webhook의 중복·역순·삭제가 상태를 되돌릴 수 있다. | provider event ID, cursor, version과 deletion tombstone을 저장한다. | webhook replay·reorder 테스트 |
| INT-003 | P1 | provider rate limit과 장애가 사용자 요청 thread를 고갈시킨다. | queue, cache, backoff, circuit breaker와 stale 표시를 둔다. | rate-limit fault injection |
| INT-004 | P1 | email만으로 KROOT·Jira 사용자를 Pie 사용자와 합치면 계정 오연결이 생긴다. | explicit identity mapping과 관리자 확인을 요구한다. | 같은 이메일의 다른 issuer 테스트 |
| MIG-001 | P0 | KROOT 페이지가 존재한다고 기능이 완성됐다고 판단할 수 있다. | capability별 source, domain, API, persistence, auth, test, 운영 상태를 inventory한다. | 이관 matrix의 evidence link와 owner 검토 |
| MIG-002 | P0 | KROOT의 두 MCP 코드와 오래된 문서가 서로 다른 상태를 말한다. | 원격 command agent, agent-team tools, Pie MCP를 별도 capability로 분류한다. | package별 executable smoke와 contract test |
| MIG-003 | P1 | KROOT UI를 복사하면 Next.js/Tauri 상태와 Orca Runtime 기능이 중복된다. | domain rule과 DTO/test만 이관하고 Renderer는 Pie design system으로 재구현한다. | duplicate dependency와 dead route 검사 |
| MIG-004 | P1 | Orca 로컬 project ID와 새 server Project ID 전환이 기존 Workspace를 고아로 만든다. | local identity mapping, dry-run, rollback 가능한 migration journal을 둔다. | 동일 repo 여러 profile·host migration fixture |

## 운영과 비용

| ID | 우선순위 | 위험 또는 질문 | 결정·대응 | 검증 |
|---|---|---|---|---|
| STO-001 | P0 | raw transcript를 DB에 누적하면 row·index·backup 비용이 폭증한다. | metadata는 PostgreSQL, 큰 원문은 chunked Object Storage에 둔다. | 장기 프로젝트 용량·backup benchmark |
| STO-002 | P1 | content hash만 믿으면 hash algorithm 변경과 충돌 대응이 어렵다. | algorithm, size, tenant, encryption domain을 identity에 포함한다. | hash migration과 duplicate upload 테스트 |
| OPS-001 | P0 | poison event가 stream 전체 업로드를 막을 수 있다. | item ack, quarantine, dead-letter, parser metric과 사용자 복구 도구를 둔다. | malformed event 사이 정상 event 진행 테스트 |
| OPS-002 | P1 | raw content를 관측성에 넣으면 비용과 유출 위험이 커진다. | ID·size·latency·result만 metric/trace에 넣고 payload는 별도 권한 저장한다. | observability payload schema 검사 |
| OPS-003 | P1 | provider hook 실패를 사용자가 모르면 기록이 완전하다고 오해한다. | capture health, last hook, transcript lag, outbox lag와 gap을 표시한다. | hook uninstall·permission denial alert 테스트 |
| OPS-004 | P1 | parser·schema 배포 오류가 대량 데이터를 잘못 분류한다. | canary, parser version rollback, replayable raw source와 projection rebuild를 제공한다. | faulty parser rollback drill |
| OPS-005 | P1 | 조직별 transcript 저장량과 egress가 예측 불가능하다. | capture mode, quota, retention, compression, upload rate와 usage meter를 둔다. | 대규모 조직 비용 모델과 throttling 테스트 |
| OPS-006 | P1 | Control Plane 장애가 로컬 개발을 막을 수 있다. | Workspace는 제한된 offline 실행을 유지하고 share·approve·remote execute만 fail closed한다. | 24시간 server outage 시나리오 |
| OPS-007 | P2 | on-prem과 cloud의 model provider·storage·MCP URL 차이가 fork를 만든다. | deployment capability와 adapter 구성으로 차이를 표현한다. | 동일 contract의 cloud/on-prem smoke |
| OPS-008 | P1 | parser 오작동·보안 사고 시 capture와 upload를 빠르게 멈출 수 없을 수 있다. | server policy와 local emergency control을 가진 capture kill switch, drain·resume 절차를 둔다. | offline client를 포함한 kill switch 전파·복구 drill |

## 첫 구현 전 필수 산출물

1. ID, 수명주기, 채택 기술과 미결 선택은
   [아키텍처 결정과 기술 기준](./22-architecture-decisions-and-technology.md)을 ADR로 전환한다.
2. ExecutionContext, SessionBinding, AgentEvent, local SQLite outbox, MCP tool과 Realtime은
   [API·이벤트·동기화 계약](./23-api-event-sync-contracts.md)을 executable schema로 전환한다.
3. 개인·회사·고객·협력사·서비스 계정의 권한 행렬과 capture·visibility·retention·deletion은
   [보안 위협 모델](./24-security-threat-model.md)의 P0 abuse case와 연결한다.
4. native·WSL·SSH·Relay, Claude·Codex, online·offline 조합은
   [검증 매트릭스](./25-verification-test-matrix.md)의 fixture와 CI job으로 만든다.
5. KROOT capability는 [KROOT 기능 이관](./26-kroot-capability-migration.md)의 manifest와 기준 commit으로
   관리한다.
6. 전체 준비 상태와 차단 단계는 [구현 준비도](./21-implementation-readiness.md)에서 추적한다.

## 외부 알파 차단 조건

- P0 이슈에 미정 상태가 남아 있다.
- raw transcript capture가 기본으로 켜지지만 고지·pause·삭제가 없다.
- 고객 사용자가 내부 turn 또는 제한 Artifact를 조회할 수 있다.
- path heuristic만으로 session을 업무에 영구 연결한다.
- 권한 회수 후 offline outbox가 그대로 업로드된다.
- Hook 누락과 parser schema 변경을 감지하지 못한다.
- agent 완료 메시지만으로 WorkItem 또는 Workflow 승인 상태가 바뀐다.
- 원격 command가 arbitrary shell 문자열을 받거나 승인 대상과 실행 대상이 bind되지 않는다.
- event replay, app crash, server retry가 중복 업무·댓글·artifact를 만든다.
- 조직 간 데이터 격리, backup restore 후 삭제, 로그 민감정보 검증이 통과하지 않는다.
