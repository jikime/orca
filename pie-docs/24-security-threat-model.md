# 보안 위협 모델

## 범위와 보안 목표

Pie는 소스 코드, 고객 데이터, AI 대화, 비밀, 터미널과 원격 제어를 한 앱에서 다룬다. 일반 업무
앱보다 endpoint compromise와 권한 혼동의 영향이 크다. 이 위협 모델은 Electron 앱, Runtime,
Control Plane, MCP, Relay와 AI 수집 경로를 포함한다.

우선 보안 목표는 다음과 같다.

1. 조직, 고객, 프로젝트와 visibility 경계를 우회해 데이터를 읽거나 변경할 수 없다.
2. Renderer, 원격 콘텐츠와 LLM이 OS·Runtime 권한을 직접 획득할 수 없다.
3. AI 수집은 명시된 정책과 사용자 상태 안에서만 동작하고 비밀을 최소화한다.
4. 승인, artifact, 원격 명령과 감사 이력의 행위자·대상·결과를 바꿔치기할 수 없다.
5. 네트워크 중단, 재시도, 악성 payload가 로컬 개발 자체를 불필요하게 중단시키지 않는다.

## 보호 자산

| 등급 | 자산 | 예시 |
|---|---|---|
| Critical | 인증·암호화 비밀 | refresh token, device key, signing key, KMS key, relay capability |
| Critical | 실행 권한 | PTY input, file write, Git push, remote command, desktop control |
| Restricted | 고객·프로젝트 원문 | 요구사항, 계약, source, transcript, tool output, recording |
| Restricted | 보안·감사 데이터 | permission, session, audit, incident evidence, deletion tombstone |
| Internal | 운영 metadata | project health, usage, parser error, queue lag |
| Public | 의도적으로 공개한 자료 | 배포 페이지, 공개 문서, 인증 utility page |

classification은 visibility와 다르다. `Restricted` 데이터라도 `internal`, `project`, `customer` 같은
서로 다른 공개 범위를 가지며 둘 다 통과해야 조회할 수 있다.

## 신뢰 구역

```text
Untrusted
├── remote web content
├── pasted/project content
├── LLM output and MCP arguments
├── provider transcript files
└── external webhook/provider payload

User Endpoint
├── sandboxed Renderer
├── privileged Main + OS key store
├── Runtime/utility process
├── local MCP child process
└── local SQLite outbox

Remote Host
├── WSL/native SSH account
├── shared SSH host
├── Edge Agent
└── Relay transport

Control Plane
├── public edge/auth pages
├── API and Worker identities
├── PostgreSQL/Object Storage/Search
└── operator and break-glass path
```

같은 장비의 process, 같은 사설망, 같은 SSH 계정이라는 사실만으로 같은 trust domain으로 묶지 않는다.
특히 shared SSH host의 transcript 접근권한과 Pie project membership은 독립적으로 확인한다.

## 공격자와 가정

- 권한 없는 외부 사용자와 credential stuffing 공격자
- 정상 계정을 가진 다른 조직 사용자
- 같은 조직이지만 프로젝트나 고객 범위가 다른 사용자
- 제한된 고객·협력사·게스트 사용자
- 악성 또는 prompt injection을 포함한 repository, 문서, issue, transcript
- 손상된 LLM provider, MCP server, webhook 또는 integration token
- local malware나 탈취된 endpoint를 가진 사용자
- 과도한 운영 권한을 가진 내부 운영자
- 오래되거나 변조된 Electron/Runtime/Edge Agent

완전히 손상된 endpoint가 생성한 `observed` event의 사실성을 Control Plane이 증명할 수 있다고 가정하지
않는다. 대신 producer identity와 trust domain을 기록하고 server·CI·Git provider가 독립 관찰한
evidence와 구분한다.

## 주요 데이터 흐름

| 흐름 | 입력 신뢰 | 주요 검증 | 실패 기본값 |
|---|---|---|---|
| Renderer → Main IPC | 낮음 | sender, schema, session, org, permission | 거부 |
| Main → Runtime | 중간 | capability audience, host, path, expiry, nonce | 거부 |
| Main → API | 인증됨 | token, membership, resource, version, policy | 거부 |
| Hook/transcript → outbox | 낮음 | parser, scope, classification, secret scan | quarantine/pause |
| outbox → ingest | client-observed | device binding, schema, sequence, quota, current auth | item reject |
| LLM → MCP | 낮음 | tool schema, active binding, permission, idempotency | 거부/승인 요구 |
| Edge Agent → Relay | device-authenticated | session, target, user consent, capability | 연결 종료 |
| webhook → Worker | 외부 서명 | signature, timestamp, replay, tenant mapping | quarantine |
| operator → customer data | 고위험 | step-up auth, approval, time limit, audit | 거부 |

## P0 위협과 통제

### Electron·IPC

| ID | 위협 | 필수 통제 | 검증 |
|---|---|---|---|
| ELC-001 | XSS나 remote navigation이 preload 권한을 호출한다. | local content, sandbox, context isolation, CSP, navigation/window allowlist | 악성 frame·redirect IPC 거부 E2E |
| ELC-002 | Renderer가 범용 IPC로 shell·file을 조작한다. | 도메인별 preload API, schema, path scope, command registry | 임의 channel·executable fuzz |
| ELC-003 | iframe/child window가 privileged IPC sender로 위장한다. | 모든 handler의 `senderFrame`과 origin 검증 | child frame attack fixture |
| ELC-004 | 외부 URL이 custom protocol로 명령을 주입한다. | strict URL parser, action allowlist, state/nonce, 사용자 확인 | malformed deep-link corpus |
| ELC-005 | DevTools, Node option, ASAR 변조로 권한을 높인다. | production fuse, ASAR integrity, code signing, update signature | 변조 package 부팅·업데이트 거부 |

[Electron 공식 보안 체크리스트](https://www.electronjs.org/docs/latest/tutorial/security)의 secure content,
context isolation, sandbox, CSP, navigation 제한, IPC sender 검증과 fuse 기준을 최소선으로 사용한다.

### 인증·세션

| ID | 위협 | 필수 통제 | 검증 |
|---|---|---|---|
| AUT-001 | OAuth code, redirect 또는 issuer를 바꿔 계정을 연결한다. | system browser, PKCE, exact redirect, state, nonce, issuer | mix-up·code interception test |
| AUT-002 | 탈취한 refresh token을 재사용한다. | rotation, token family, reuse detection, device/session revoke | 이전 token 동시 재사용 |
| AUT-003 | Electron client secret을 confidential secret으로 믿는다. | native app을 public client로 등록 | binary secret 부재 검사 |
| AUT-004 | 초대·재설정 token을 다른 조직이나 계정에 쓴다. | one-time hash, audience, expiry, intended identity, consume transaction | replay·cross-tenant test |
| AUT-005 | 탈퇴·권한 회수 후 offline 기능이 계속 쓰기한다. | short access, revoke event, online reauthorization, capability expiry | outbox/Runtime revoke E2E |
| AUT-006 | MFA 복구가 주 인증보다 약하다. | rate limit, step-up, recovery audit, owner safeguard | recovery abuse test |

### 테넌트·RBAC

| ID | 위협 | 필수 통제 | 검증 |
|---|---|---|---|
| TEN-001 | URL의 organization/project ID만 바꿔 다른 tenant를 조회한다. | membership + ownership + permission, RLS, object namespace | 모든 endpoint cross-tenant suite |
| TEN-002 | app DB role이 RLS를 우회한다. | owner/BYPASSRLS 분리, forced policy test role | direct SQL negative test |
| TEN-003 | connection pool에 이전 tenant 문맥이 남는다. | transaction-local context, reset, no context default deny | pool reuse concurrency test |
| TEN-004 | customer role이 internal field·artifact를 본다. | field-level projection, visibility policy, cache key 분리 | role snapshot·search leak test |
| TEN-005 | 마지막 owner 제거로 조직이 잠긴다. | owner invariant와 별도 transfer flow | concurrent owner removal test |
| TEN-006 | entitlement 오류를 permission 우회에 이용한다. | entitlement와 authorization 독립 판정 | 조합 행렬 test |

### AI 수집·Artifact

| ID | 위협 | 필수 통제 | 검증 |
|---|---|---|---|
| CAP-001 | 앱 밖 session이나 다른 project 원문을 자동 업로드한다. | explicit binding, deny path, unassigned queue, host scope | shared folder/SSH fixture |
| CAP-002 | prompt·tool output의 비밀이 server·log·search에 남는다. | local/server redaction, object quarantine, log schema | seeded secret canary scan |
| CAP-003 | transcript parser가 악성 JSON·대용량 line으로 장애난다. | bounded parser, streaming, size/depth limits, quarantine | fuzz·decompression bomb test |
| CAP-004 | transcript 수정이 기존 evidence를 바꾼다. | content hash, immutable revision, reconciliation event | mutation/truncation fixture |
| CAP-005 | agent의 “완료” 주장을 검증된 결과로 표시한다. | assertion/trust domain, CI/Git evidence 분리 | declared result UI/API test |
| CAP-006 | 권한 회수 전에 쌓인 outbox가 나중에 업로드된다. | per-batch current auth and capture policy recheck | revoke while offline test |
| CAP-007 | 삭제 후 summary, embedding, backup에 내용이 남는다. | deletion lineage, tombstone, projection purge, backup expiry record | restore-and-delete drill |
| CAP-008 | Artifact path 바꿔치기나 TOCTOU가 발생한다. | open/hash/upload/finalize identity, immutable revision | file mutation during upload |

raw transcript 수집은 기본 opt-in 정책, 기록 상태 표시, pause와 삭제 경로가 완성되기 전 외부 알파에서
활성화하지 않는다. metadata-only가 항상 privacy-safe한 것은 아니므로 cwd, branch, file name에도 같은
분류 정책을 적용한다.

### MCP·LLM 도구

| ID | 위협 | 필수 통제 | 검증 |
|---|---|---|---|
| MCP-001 | repository prompt injection이 업무 상태나 원격 명령을 바꾼다. | read/additive-write 우선, sensitive tool 승인, active context 확인 | hostile README/issue E2E |
| MCP-002 | remote MCP에 사용자 token을 그대로 전달한다. | token exchange/resource audience, passthrough 금지 | wrong-audience token test |
| MCP-003 | tool annotation을 권한 근거로 믿는다. | server-side permission과 side-effect registry | false readOnly annotation test |
| MCP-004 | retry가 댓글·artifact·명령을 중복 생성한다. | required idempotency key, operation lookup | disconnect-after-commit test |
| MCP-005 | 로컬 HTTP MCP가 다른 process에 노출된다. | `stdio` 기본, HTTP 사용 시 loopback+auth+Origin | local port attack test |
| MCP-006 | tool output으로 비밀·과도한 원문을 LLM에 반환한다. | 최소 projection, classification, output size cap | permission/size snapshot |

### 원격지원·Relay

| ID | 위협 | 필수 통제 | 검증 |
|---|---|---|---|
| REM-001 | 승인한 대상과 실제 실행 host/command가 다르다. | signed immutable target and command digest | target substitution test |
| REM-002 | 임의 shell 문자열로 allowlist를 우회한다. | command definition + typed args, no shell default | metacharacter/property test |
| REM-003 | 세션 종료 후 capability를 재사용한다. | short TTL, nonce, session binding, server revoke | replay after terminate |
| REM-004 | 고객 동의 없이 화면·터미널을 기록한다. | explicit consent, visible indicator, capture policy | consent state E2E |
| REM-005 | relay가 plaintext나 사용자 token을 볼 수 있다. | E2EE data channel, scoped control token | relay log/content inspection |
| REM-006 | output flood가 제어·감사 채널을 막는다. | channel separation, bounded queue, rate/credit | sustained PTY flood test |
| REM-007 | file transfer가 path traversal·symlink를 따른다. | target-side canonicalization, root, no-follow policy | cross-platform path corpus |

## P1 위협

| 영역 | 위협 | 기준 통제 |
|---|---|---|
| Availability | event·chat·terminal 폭주가 process와 DB를 고갈 | traffic class 분리, quota, backpressure, circuit breaker |
| Webhook | 서명된 payload replay와 tenant mapping 혼동 | timestamp window, delivery ID, body signature, explicit installation mapping |
| Search | 권한 회수 전 색인·cache가 결과를 노출 | authorization-aware query, short invalidation SLO, no raw snippet cache |
| Export | 정상 사용자가 대량 고객 데이터를 반출 | 별도 permission, step-up, watermark/manifest, 감사·rate limit |
| Operator | 운영자가 이유 없이 원문을 열람 | just-in-time approval, break-glass, dual control, alert |
| Supply chain | dependency/update/server image가 변조 | lockfile, provenance, SBOM, signing, staged update, rollback |
| Parser update | 새 parser가 내용을 잘못 연결·분류 | signed version, canary, raw replay, kill switch |
| Backup | 복원본이 폐기된 계정·token·데이터를 재활성화 | token revoke epoch, tombstone replay, post-restore validation |
| On-prem | 고객별 설정 fork가 보안 수정에서 이탈 | capability/config variation, signed supported baseline |

## 개인정보와 보존

- 조직은 capture mode, 데이터 분류, 보존 기간과 고객 제출 범위를 결정한다.
- 사용자는 현재 session의 기록 여부와 연결된 organization/project/work item을 항상 확인할 수 있어야
  한다.
- 입력, 응답, tool output, file, summary, embedding, audit와 backup은 별도 데이터 종류로 inventory한다.
- 수집 목적, 처리 근거, 지역, 하위 처리자, 삭제·내보내기 절차는 운영 정책에서 확정한다.
- 법적 보존은 일반 삭제를 덮어쓰는 숨은 flag가 아니라 사유, 범위, 기간, 승인과 감사가 있는 hold다.
- E2EE 채팅은 서버 검색, moderation, eDiscovery와 충돌한다. E2EE 범위는 제품 문구보다 먼저 별도
  threat model과 key recovery 정책으로 확정한다.
- AI provider로 전달되는 내용은 Pie 저장소 보존과 별개다. provider별 data use와 retention 설정을
  integration metadata에 기록한다.

## 감사 무결성

- audit record는 actor, effective permissions, organization, target, before/after digest, result,
  request/correlation ID와 server time을 가진다.
- 사용자 event와 운영 trace/log를 같은 보존소로 합치지 않는다.
- audit 수정·삭제 대신 correction 또는 redaction marker를 추가한다.
- 중요한 event batch는 sequence gap과 writer identity를 검증한다.
- 감사 열람과 export 자체도 감사한다.
- tamper-evident hash chain이나 외부 WORM 저장은 규제·계약 요구를 확인한 뒤 ADR로 선택한다. 이름만
  “immutable”로 붙이고 무결성을 보장한다고 표현하지 않는다.

## 보안 개발과 검증 기준

- application control 목록은 [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/)
  요구사항 ID와 연결한다.
- 개발 lifecycle과 공급망 활동은 [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)을
  release checklist에 매핑한다.
- dependency·container·secret·IaC scan만으로 완료하지 않고 tenant, IPC, capture, remote command의
  misuse test를 실행한다.
- Critical/P0 finding은 release 차단, 예외는 owner, 만료일, 완화와 재검증 일정을 요구한다.
- 보안 사고 시 capture kill switch, token revoke, integration disable, parser rollback과 고객 통지
  Runbook을 독립적으로 실행할 수 있어야 한다.

## 외부 알파 보안 gate

- 모든 BrowserWindow와 IPC handler가 Electron security test를 통과한다.
- cross-tenant, customer/internal visibility, stale cache 부정 테스트가 통과한다.
- auth redirect, refresh reuse, invite replay와 session revoke를 재현한다.
- secret canary가 ingest, object, log, trace와 search 결과에 남지 않는다.
- raw capture의 고지, pause, unassigned, 삭제와 kill switch가 작동한다.
- MCP hostile-content와 duplicate side-effect test가 통과한다.
- 원격 명령은 외부 알파 범위에서 제외하거나 immutable approval binding을 증명한다.
- restore 환경에서 tombstone, permission, token revoke와 audit continuity를 검증한다.
