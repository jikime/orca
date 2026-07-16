# 검증 전략과 테스트 매트릭스

## 목표

Pie의 완료 조건을 화면 시연이 아니라 반복 가능한 증거로 판단한다. 특히 Electron 권한, 테넌트,
오프라인 outbox, AI provider parser와 원격 host는 unit test만으로 검증할 수 없으므로 contract,
실제 binary, fault injection과 복구 drill을 조합한다.

## 테스트 계층

| 계층 | 검증 대상 | 실행 시점 |
|---|---|---|
| Unit | 정책, 상태 전이, parser record, redaction, path rule | 모든 PR |
| Schema | valid/invalid JSON, enum, 크기, compatibility | 모든 PR |
| Contract | OpenAPI server/client, IPC, Runtime, MCP tool | 모든 PR |
| Integration | PostgreSQL RLS, outbox, Object Storage, identity adapter | 모든 PR 또는 merge queue |
| Real binary | Git, SQLite, Electron, provider CLI, SSH | merge queue/nightly |
| Desktop E2E | 설치, 로그인, project, workspace, revoke, update | nightly/release |
| Fault injection | crash, packet loss, retry, clock skew, disk full | nightly/release |
| Security misuse | cross-tenant, hostile content, token replay, command injection | merge queue/release |
| Operations drill | backup restore, kill switch, key rotation, rollback | milestone/release |
| Exploratory | UX, 접근성, 장시간 사용, OS integration | milestone/release |

test double로 provider나 Git을 빠르게 검증하되 release gate에는 대표 실제 binary를 포함한다. Mock만
통과한 기능은 SSH·WSL·구버전 Git·실제 transcript 형식과의 호환을 증명하지 못한다.

## 공통 fixture 체계

```text
fixtures/
├── contracts/{valid,invalid,previous-version}/
├── providers/{claude-code,codex}/
├── git/{2.25,current}/
├── hosts/{native,wsl,ssh,relay}/
├── security/{cross-tenant,hostile-content,secrets}/
├── migrations/{orca,kroot,previous-pie}/
└── recovery/{outbox,backup,realtime}/
```

- 개인정보와 실제 고객 transcript는 fixture에 넣지 않는다.
- provider fixture는 원본 형식을 최소화한 synthetic data와 schema provenance를 가진다.
- secret fixture에는 추적 가능한 canary만 넣고 실제 key처럼 작동하지 않게 한다.
- expected result에는 parser version, assertion, visibility, sequence, hash와 reject code를 포함한다.
- fixture 변경은 호환성 변경으로 review한다.

## 핵심 수직 흐름

### V1 안전한 데스크톱 경계

```text
Renderer -> typed preload -> Main validation -> Runtime handshake -> typed response
```

검증 항목:

- 허용된 main frame만 IPC를 호출한다.
- invalid payload, unknown method, stale session과 unsupported protocol을 거부한다.
- Renderer에 token, arbitrary `ipcRenderer`, Node module과 범용 shell API가 없다.
- Runtime 종료·재시작·구버전에서 UI가 제한 상태와 복구 동작을 구분한다.
- production package의 sandbox, CSP, fuses, ASAR integrity와 서명을 검사한다.

### V2 Control Plane 기반

```text
tenant fixture -> domain transaction -> DB outbox -> worker -> realtime invalidation -> resync
```

검증 항목:

- API transaction은 저장되고 outbox가 누락되지 않는다.
- commit 전 worker가 side effect를 만들지 않는다.
- 같은 outbox row를 여러 worker가 claim해도 결과는 하나다.
- Realtime 메시지를 잃어도 cursor 기반 resync로 같은 projection에 도달한다.
- 다른 tenant DB role, object key와 cache key 접근이 거부된다.

### V3 인증·RBAC

```text
owner sign-up -> verify -> organization -> invite -> login -> role -> revoke
```

검증 항목:

- system browser callback의 PKCE, state, nonce, issuer, redirect를 검증한다.
- refresh rotation과 이전 token 재사용이 token family를 폐기한다.
- 초대 수락은 intended identity, organization, expiry와 one-time 사용을 확인한다.
- 마지막 owner 불변식과 concurrent role update를 보장한다.
- revoke 뒤 Main, Runtime, Realtime, local cache와 outbox가 다음 privileged operation을 거부한다.

### V4 Project·WorkItem

```text
personal/company org -> team -> project -> work item -> board -> review -> complete
```

검증 항목:

- personal과 company가 같은 API와 tenant rule을 사용한다.
- Team Workflow와 Project Delivery Workflow를 다른 transition·permission으로 검증한다.
- 고객·협력사·내부 사용자에게 서로 다른 field/visibility projection을 반환한다.
- stale ETag, workflow version과 invalid state transition을 거부한다.
- offline draft와 online update 충돌을 숨기지 않는다.
- WorkItem, Workspace board, Worktree와 orchestration task ID를 혼동하지 않는다.
- Initiative 수동 구성, SavedView 동적 결과, Intake 승격과 ProjectUpdate revision을 검증한다.

### V5 AI 실행 추적

```text
WorkItem -> Workspace -> Claude/Codex -> Hook/transcript -> outbox -> timeline -> Artifact
```

검증 항목:

- explicit ExecutionContext가 session과 binding되고 경로 heuristic은 후보만 만든다.
- hook 누락을 transcript reconcile이 복구하고 중복 event를 만들지 않는다.
- transcript append, truncate, rotate, compaction, malformed line과 unknown record를 처리한다.
- app crash가 event insert와 cursor advance 사이의 데이터 유실을 만들지 않는다.
- event batch의 duplicate, partial reject, gap과 backoff 후 최종 projection이 일치한다.
- file이 upload 중 변경되면 hash mismatch 또는 새 Artifact revision으로 처리한다.
- agent-declared 완료와 test/CI/Git evidence를 UI와 API에서 구분한다.
- capture pause, quota, revoke, deletion과 kill switch가 online/offline에서 동작한다.

## 조합 매트릭스

모든 조합을 매 PR Cartesian product로 실행하지 않는다. risk-based pairwise를 PR/nightly에 배치하고
release 전 P0 조합을 모두 실행한다.

### 플랫폼

| 축 | 최소 조합 |
|---|---|
| macOS | 현재 지원 major의 Apple Silicon, 코드 서명·키체인·deep link |
| Windows | 현재 지원 x64, Credential Manager, installer/update, path/ACL |
| Linux | 지원 배포판 x64, Wayland/X11 범위, keyring available/unavailable |
| WSL | Windows host + WSL2, distro path, Git/PTY/agent process |

지원 OS major와 CPU는 Electron 지원 정책, 사용자 분포와 CI runner를 확인해 release matrix에 버전으로
고정한다. “macOS/Linux/Windows 지원”만 적고 검증 버전을 비워두지 않는다.

### 실행 host

| host | 필수 시나리오 |
|---|---|
| native | local repo, symlink, Unicode/space path, sleep/resume |
| WSL | distro 전환, Windows/WSL path 혼용, Runtime restart |
| SSH | reconnect, host key change, slow link, shared account boundary |
| Relay | capability expiry, disconnect, backpressure, target substitution |

### Git

| 버전 | 목적 |
|---|---|
| Git 2.25 | core workflow baseline과 fallback |
| 중간 대표 버전 | capability boundary와 cache isolation |
| 현재 stable | preferred command와 provider integration |

native, WSL distro, SSH provider와 relay connection별 capability cache가 분리되는지 검사한다. command가
global `-c` option으로 시작하는 fixture와 GitHub·GitLab remote를 함께 둔다.

### AI provider

| provider | 초기 수준 |
|---|---|
| Claude Code | Hook + transcript + resume + subagent E2E |
| Codex | event/transcript + resume + tool/artifact E2E |
| Gemini/Cursor/OpenCode | 기존 AI Vault discovery 회귀와 metadata smoke |

Claude Code와 Codex도 format version이 하나라고 가정하지 않는다. known fixture, unknown additive record,
breaking record와 parser rollback을 각각 시험한다.

### 네트워크와 로컬 자원

| 조건 | 예상 결과 |
|---|---|
| offline 시작 | 제한된 local Workspace, 명확한 sync/capture 상태 |
| request 후 response 유실 | 같은 idempotency key로 결과 조회 |
| 순서 역전·중복 | version/sequence로 일관된 projection |
| 높은 latency·packet loss | bounded retry, UI 비차단, 취소 가능 |
| disk quota 도달 | capture pause/metadata-only, 원문 silent delete 금지 |
| DB busy·process crash | lease 회수와 transaction 보존 |
| clock skew | server time 권위, token/nonce 허용 범위 테스트 |
| system sleep/resume | session/token/realtime 재검증 |

### 역할과 공개 범위

최소 역할 fixture는 owner, organization admin, project manager, member, customer approver, partner,
viewer, service account, suspended member다. 각 역할은 다음 resource scope를 조합한다.

```text
organization x project x customer x work item x agent turn x artifact x remote host
```

allow test보다 deny test를 더 넓게 둔다. 목록, detail, search, export, realtime, cached offline view와
Object Storage URL에서 같은 결과가 나와야 한다.

## Contract test

### HTTP

- OpenAPI example이 실제 server validator와 client decoder를 통과한다.
- 모든 mutation은 auth, permission, entitlement, ETag와 idempotency 조합을 시험한다.
- 모든 error code가 RFC 9457 body와 상태 코드에 매핑된다.
- pagination cursor tamper, deleted resource와 permission change를 시험한다.
- 이전 minor client가 additive field를 무시하고 unknown enum은 실패로 처리한다.

### Event

- `source + id`, organization의 deduplication unique constraint를 시험한다.
- 같은 stream의 duplicate, gap, late arrival, permanent reject와 replay를 시험한다.
- schema version마다 golden JSON과 invalid corpus를 유지한다.
- projection rebuild가 원본 event와 object에서 같은 결과를 만든다.
- audit event와 agent observation event의 trust domain이 섞이지 않는다.

### IPC·Runtime

- preload type과 runtime schema에서 generated fixture를 공유한다.
- unsupported capability를 호출하기 전에 Main이 차단한다.
- malformed length/frame, oversized payload, slow consumer와 stream cancel을 시험한다.
- native/WSL/SSH path traversal, symlink, case sensitivity와 separator를 property test한다.
- Runtime이 다른 user 또는 stale Main의 capability를 거부한다.

### MCP

- tool input/output schema와 목록 snapshot을 고정한다.
- read tool은 visibility와 output size를 지킨다.
- write tool은 idempotency, active binding과 audit correlation을 요구한다.
- response 전 연결이 끊긴 write를 재시도해도 side effect가 하나다.
- fake annotation, wrong audience token과 hostile prompt가 permission을 바꾸지 못한다.

## SQLite outbox 검증

- Runtime이 실제로 사용하는 `process.versions.sqlite`를 CI artifact에 기록한다.
- WAL 수정 버전 미만에서는 다중 writer/checkpoint test를 허용하지 않고 startup policy를 검증한다.
- 지원 수정 버전에서는 concurrent read, single writer, checkpoint, crash와 recovery를 장시간 반복한다.
- DB와 WAL을 함께 snapshot한 복구, 잘못 분리한 snapshot의 진단 동작을 시험한다.
- long reader로 checkpoint starvation을 만들고 WAL size alert와 recovery를 확인한다.
- synthetic event를 충분히 누적해 quota, batch 크기, compaction과 UI responsiveness를 측정한다.

현재 개발 shell의 SQLite 버전 값은 package runtime을 대표하지 않는다. packaged Electron, test Node,
Runtime sidecar 각각에서 version과 connection topology를 수집한다.

## 보안 자동화

| gate | 내용 |
|---|---|
| Static | type/lint, dependency, secret, license, IaC/container scan |
| Build | lockfile, reproducible inputs, SBOM, signing/provenance |
| Dynamic | auth abuse, cross-tenant, XSS/IPC, path/command injection |
| Data | secret canary, log/trace redaction, deletion lineage |
| Package | fuse, ASAR integrity, code signature, update signature |
| Operations | restore, revoke, kill switch, parser rollback, break-glass alert |

OWASP ASVS requirement ID는 test metadata에 버전과 함께 기록한다. scanner pass를 ASVS 전체 준수로
표현하지 않는다.

## 성능·안정성 기준 설정

절대 목표값은 첫 prototype 측정 없이 문서에서 임의 확정하지 않는다. R2와 R5에서 다음 baseline을
측정하고 알파 SLO를 ADR로 고정한다.

- API p50/p95/p99와 permission/RLS overhead
- DB outbox claim throughput과 retry backlog recovery 시간
- Realtime reconnect와 full resync 시간
- local event insert, parser throughput, outbox drain과 UI frame 영향
- transcript/object 일일 저장량과 조직별 비용
- terminal/relay throughput, control message latency와 memory ceiling
- search permission revoke 반영 시간
- backup RPO/RTO와 실제 restore 시간

부하 시험은 평균만 보지 않고 queue, WAL, memory, object count와 비용의 상한을 함께 기록한다.

## 단계별 release gate

| 단계 | 필수 증거 |
|---|---|
| R1 | packaged Electron security, IPC negative, Runtime compatibility, Orca workspace regression |
| R2 | tenant isolation, transactional outbox, trace, restore, previous-client compatibility |
| R3 | auth abuse, role/resource matrix, revoke propagation, owner invariant |
| R4 | Team identifier, ETag conflict, 두 Workflow, Intake 승격, SavedView 권한, customer visibility, offline cache |
| R5 | provider fixtures, crash-safe outbox, event replay, secret canary, Artifact provenance |
| R7/R8 | chat/media load, relay consent, command binding, E2EE/key recovery decision |
| R9 | migration, export/delete, on-prem upgrade/restore, billing reconciliation |

## 테스트 결과 보존

- CI 결과에는 commit, app/server/runtime version, OS, Git, SQLite, provider fixture와 schema version을
  포함한다.
- release evidence는 SBOM, signature, compatibility matrix, security exception, restore drill과 known
  limitations를 묶는다.
- flaky test는 무기한 retry하지 않고 owner와 만료가 있는 quarantine만 허용한다.
- 수동 test는 steps, expected, evidence와 tester를 기록하며 자동화 후보를 표시한다.
- 운영 사고에서 발견한 실패는 재현 fixture 또는 drill로 남긴다.
