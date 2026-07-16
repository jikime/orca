# API·이벤트·동기화 계약

## 목표

Electron, Runtime, Control Plane과 Worker가 네트워크 단절, 중복, 순서 역전과 버전 차이를 같은
의미로 처리하게 한다. 이 문서는 wire contract의 설계 기준이며 실제 구현의 권위자는 버전이 고정된
OpenAPI, JSON Schema와 compatibility fixture다.

파일 구조, AsyncAPI, 생성물과 CI 권위는
[Contract Specification과 변경 관리](./33-contract-specification-governance.md)를 따른다.

## 통신 경계

| 경계 | transport | 권위와 용도 |
|---|---|---|
| Renderer ↔ Preload/Main | Electron IPC | 좁은 사용자 명령과 상태 구독 |
| Main ↔ Runtime | local socket/pipe | host 실행, session, file, Git, PTY, collector |
| Main ↔ Control Plane | HTTPS JSON | 인증 세션과 사용자 업무 명령 |
| Runtime ↔ Ingest API | Main broker를 통한 HTTPS batch | 로컬 관찰 이벤트와 artifact 업로드 |
| Main ↔ Realtime | WSS | 변경 통지, 권한·세션 폐기, resync 지시 |
| LLM client ↔ Pie MCP | child-process `stdio` | 명시적인 project/work 도구 호출 |
| Runtime/Edge ↔ Relay | 전용 암호화 stream | 승인된 terminal·command·desktop data |

Renderer와 LLM child process에는 access/refresh token을 전달하지 않는다. Runtime이 서버 작업을
수행해야 하면 Main이 대상, scope, 만료와 nonce가 제한된 capability를 발급받아 전달한다.

## HTTP 공통 규칙

### URL과 표현

- API base는 `/v1`이며 organization resource는 path에 명시한다.
- 예: `/v1/organizations/{organizationId}/work-items/{workItemId}`
- ID는 opaque string이다. client는 UUID 구조, 생성 시각 또는 tenant를 해석하지 않는다.
- JSON 필드는 `camelCase`, 시각은 UTC RFC 3339, 기간은 명시적 단위를 가진 정수로 표현한다.
- 금액은 통화와 minor unit 또는 검증된 decimal string을 사용하고 IEEE 754 부동소수점으로 저장하지
  않는다.
- 목록은 stable sort key와 opaque cursor를 사용한다. offset은 관리자 소규모 목록 외에는 쓰지 않는다.
- 삭제는 자원별 정책에 따라 archive, tombstone, purge를 구분한다.

### 요청 문맥

| 값 | 의미 |
|---|---|
| `Authorization` | Main만 소유하는 bearer access token |
| path `organizationId` | 사용자가 선택한 조직. token membership과 서버에서 대조 |
| `traceparent` | W3C 운영 trace 문맥 |
| `Idempotency-Key` | 재시도 가능한 생성·명령의 업무 멱등 키 |
| `If-Match` | 수정할 resource의 strong ETag |
| `Pie-Client-Version` | Electron semantic version |
| `Pie-Protocol-Version` | API contract major/minor |

서버는 client가 보낸 organization, actor, permission을 사실로 신뢰하지 않는다. 인증된 subject,
membership, resource ownership과 server policy로 문맥을 다시 만든다.

### 성공 응답

- 단일 resource는 resource representation을 직접 반환하고 `ETag`를 포함한다.
- 생성은 `201 Created`와 `Location`, 비동기 명령은 `202 Accepted`와 operation resource를 반환한다.
- 목록은 `{ "items": [], "nextCursor": null }` 형태를 기본으로 한다.
- 삭제나 상태 전이가 이미 같은 결과에 도달한 재시도라면 멱등 계약에 따라 기존 결과를 반환한다.
- 서버가 이해했지만 client가 지원하지 않는 기능은 성공 응답에서 조용히 버리지 않고 capability 또는
  validation 오류로 알린다.

### 오류 응답

오류는 `application/problem+json`으로 반환한다.

```json
{
  "type": "https://errors.pielab.ai/work-item/version-conflict",
  "title": "Work item version conflict",
  "status": 412,
  "detail": "The work item changed after it was loaded.",
  "instance": "/v1/operations/01J...",
  "code": "WORK_ITEM_VERSION_CONFLICT",
  "requestId": "01J...",
  "currentVersion": 8
}
```

- `type`, `code`, HTTP status는 안정적인 machine contract다.
- `title`, `detail`은 사용자 표시용으로 현지화될 수 있으므로 분기 조건으로 사용하지 않는다.
- validation 오류는 허용된 field path와 reason만 제공한다. SQL, stack, token, 로컬 절대 경로는
  포함하지 않는다.
- permission 거부, entitlement 부족, resource 부재는 서로 다른 내부 감사 코드를 남긴다. 외부 응답은
  resource 존재를 노출하지 않도록 일부 상황에서 같은 404를 사용할 수 있다.
- retry 가능한 429/503에는 적용 가능한 경우 `Retry-After`를 제공한다.

### 멱등성

`Idempotency-Key`는 다음 규칙을 가진다.

- scope는 authenticated principal + organization + method + canonical route다.
- 최초 요청의 canonical payload hash, 상태와 응답을 저장한다.
- 같은 key와 같은 payload 재시도는 같은 업무 결과를 반환한다.
- 같은 key와 다른 payload는 `409 IDEMPOTENCY_KEY_REUSED`로 거부한다.
- 처리 중인 key는 operation 상태를 반환하며 다른 worker가 같은 side effect를 시작하지 않는다.
- 보존 기간은 API capability에 게시하고 만료된 key를 client가 재사용하지 않게 한다.
- 메일, webhook, MCP write, remote command와 artifact finalize도 downstream idempotency key를 전달한다.

멱등성은 exactly-once 전송을 의미하지 않는다. at-least-once 전달에서 업무 결과를 한 번으로 만드는
서버 계약이다.

## Resource 수정과 충돌

각 mutable aggregate는 증가하는 `version`을 가진다. 서버는 같은 version을 표현하는 strong ETag를
응답하고 수정 요청에 `If-Match`를 요구한다.

```http
PATCH /v1/organizations/org-1/projects/proj-1/work-items/work-1
If-Match: "work-item-7"
Idempotency-Key: 018f...
Content-Type: application/json
```

- ETag가 다르면 `412 Precondition Failed`와 최신 version을 반환한다.
- client는 조용히 last-write-wins로 재전송하지 않고 변경 내용을 비교하게 한다.
- 칸반 이동은 `workItemId`, `fromStateId`, `toStateId`, `workflowVersion`, `expectedVersion`을 모두
  검증한다.
- 설명처럼 병합 가능한 field도 초기에는 server-side 자동 병합하지 않는다. CRDT 도입은 별도 ADR이
  필요하다.
- 승인, 고객 제출, 원격 실행은 offline queue에 넣지 않고 최신 권한과 version을 온라인에서 확인한다.

## 최소 Control Plane resource

```text
/v1/session
/v1/organizations
/v1/organizations/{orgId}/memberships
/v1/organizations/{orgId}/teams
/v1/organizations/{orgId}/initiatives
/v1/organizations/{orgId}/projects
/v1/organizations/{orgId}/work-items
/v1/organizations/{orgId}/projects/{projectId}/workflows
/v1/organizations/{orgId}/teams/{teamId}/cycles
/v1/organizations/{orgId}/intake-items
/v1/organizations/{orgId}/views
/v1/organizations/{orgId}/agent-sessions
/v1/organizations/{orgId}/agent-events:batch
/v1/organizations/{orgId}/artifacts
/v1/organizations/{orgId}/changes
/v1/operations/{operationId}
```

실제 route와 DTO는 OpenAPI에서 확정한다. `actions`, `commands`, `events` 같은 범용 endpoint 하나에
모든 side effect를 넣지 않는다.

WorkItem은 Team이 소유하고 Project 연결이 선택적이므로 canonical resource는 organization 하위에
둔다. Team·Project·Cycle·assignee별 목록은 권한이 적용된 query filter로 제공하고 같은 WorkItem을
여러 nested URL의 서로 다른 resource처럼 만들지 않는다.

## Agent event wire format

내부 [AgentEventEnvelope](./19-ai-project-portal.md)의 wire 표현은 CloudEvents 1.0 structured event와
호환한다. organization은 URL과 인증 문맥에서 먼저 확인하고 event 안의 값과 대조한다.

```json
{
  "specversion": "1.0",
  "id": "018f4a5d-...",
  "source": "urn:pie:installation:client-7:runtime:runtime-2",
  "type": "ai.pielab.agent.turn.completed.v1",
  "subject": "agent-sessions/session-3/turns/turn-9",
  "time": "2026-07-15T04:12:31.417Z",
  "datacontenttype": "application/json",
  "dataschema": "https://schemas.pielab.ai/events/agent-turn-completed.v1.json",
  "pieorgid": "org-1",
  "piestream": "session-3",
  "piesequence": 42,
  "data": {
    "context": {
      "projectId": "project-1",
      "workItemId": "work-7",
      "workspaceId": "workspace-2",
      "hostId": "host-4",
      "launchId": "launch-8",
      "agentSessionId": "session-3",
      "agentRunId": "run-2",
      "turnId": "turn-9"
    },
    "producer": {
      "type": "transcriptReconciler",
      "provider": "claude-code",
      "parserVersion": "1.2.0",
      "trustDomain": "client-observed"
    },
    "assertion": "observed",
    "classification": "project-confidential",
    "visibility": "internal",
    "payloadObject": {
      "objectId": "object-9",
      "sha256": "...",
      "sizeBytes": 18342
    },
    "correlationId": "corr-2",
    "causationId": "018f4a5c-...",
    "capturedAt": "2026-07-15T04:12:32.003Z"
  }
}
```

- `source + id`는 producer가 재시도해도 바꾸지 않는다.
- `type`의 마지막 major schema version은 의미가 호환되지 않을 때만 올린다.
- `piesequence`는 한 `piestream` 안에서만 단조 증가한다. host 사이의 전역 순서를 만들지 않는다.
- `time`은 발생 시각, `capturedAt`은 수집 시각이며 서버 수신 시각은 저장 시 추가한다.
- 원문이 event 크기 한도를 넘으면 `payloadObject`를 사용한다. presigned URL이나 로컬 경로를 event에
  영구 저장하지 않는다.
- secret scanner와 visibility policy를 통과하지 않은 object는 quarantine 상태이며 projection에
  노출하지 않는다.

## Batch ingest와 ack

```json
{
  "batchId": "batch-17",
  "producerId": "runtime-2",
  "protocolVersion": "1.0",
  "events": [],
  "clientCheckpoint": {
    "streamId": "session-3",
    "lastServerAck": 36
  }
}
```

정상적으로 해석한 batch는 각 item의 결과를 반환한다.

```json
{
  "batchId": "batch-17",
  "results": [
    { "id": "event-37", "status": "accepted" },
    { "id": "event-38", "status": "duplicate" },
    { "id": "event-39", "status": "retryableRejected", "code": "OBJECT_PENDING" },
    { "id": "event-40", "status": "permanentRejected", "code": "SCHEMA_UNSUPPORTED" }
  ],
  "streamAcks": [
    { "streamId": "session-3", "contiguousThrough": 38, "gaps": [39] }
  ]
}
```

- batch 전체의 인증·크기·JSON이 잘못되면 item을 처리하지 않고 HTTP 오류를 반환한다.
- item 오류가 다른 유효 item의 저장을 막지 않는다.
- `accepted`와 `duplicate`만 outbox에서 ack 처리한다.
- `retryableRejected`는 backoff 후 같은 event ID로 재시도한다.
- `permanentRejected`는 원문과 사유를 제한된 local quarantine에 두고 사용자에게 조치를 표시한다.
- contiguous ack는 gap 뒤의 item을 암묵적으로 승인하지 않는다.
- unknown event type은 정책에 따라 quarantine할 수 있지만 ingest process를 crash시키지 않는다.

## 로컬 outbox 상태 머신

DB 파일 소유권, single-writer, encryption fallback과 host isolation은
[`ADR-0003`](../docs/adr/0003-local-sqlite-outbox.md), 실제 table·migration은
[데이터베이스 물리 설계](./30-database-physical-design.md)를 따른다.

```text
pending -> leased -> accepted -> compacted
   ^          |
   |          +-> retryable failure
   +----------+
   |
   +-> permanent_rejected
```

필수 local table은 다음 책임을 분리한다.

| table | 책임 |
|---|---|
| `capture_event` | immutable normalized event와 content hash |
| `outbox_delivery` | 시도, lease, next attempt, server result |
| `provider_cursor` | provider file identity, byte offset 또는 opaque cursor |
| `stream_checkpoint` | local sequence와 contiguous server ack |
| `capture_policy_cache` | 만료가 있는 server policy snapshot |
| `object_upload` | chunk hash, upload 상태, finalize 결과 |

- transcript parsing, event insert, cursor advance는 한 SQLite transaction이다.
- network 전송은 transaction 밖에서 수행한다.
- lease에는 owner와 expiry가 있으며 crash 후 회수할 수 있다.
- retry는 exponential backoff와 jitter를 사용하되 server `Retry-After`를 우선한다.
- quota는 metadata, raw payload, object staging을 각각 계측한다.
- quota 도달 시 오래된 미전송 원문을 조용히 삭제하지 않고 capture pause 또는 metadata-only로 전환한다.
- logout, membership revoke, capture kill switch 시 새 upload를 멈추고 남은 item을 재인가하기 전 보내지 않는다.
- DB integrity failure는 원본 transcript를 수정하지 않고 진단·새 outbox 생성·reconcile 절차로 복구한다.

## Artifact 업로드

1. Main/Runtime이 metadata, size, SHA-256, classification으로 upload intent를 요청한다.
2. 서버가 permission, quota, object key와 짧은 upload capability를 결정한다.
3. client가 chunk 또는 multipart upload를 수행한다.
4. client가 object hash와 part 결과로 finalize를 요청한다.
5. 서버가 저장 객체를 검증하고 `available`, `quarantined`, `rejected` 중 하나를 확정한다.
6. Artifact와 Evidence는 `available` object의 immutable revision만 참조한다.

로컬 파일 경로, presigned URL, multipart upload ID는 다른 사용자에게 노출하는 Artifact identity가 아니다.
파일 내용이 바뀌면 같은 Artifact의 새 revision을 만들고 기존 Evidence를 다시 쓰지 않는다.

## Realtime과 재동기화

Realtime message는 작은 invalidation envelope다.

```json
{
  "type": "resource.changed",
  "organizationId": "org-1",
  "serverSequence": 9182,
  "resourceType": "workItem",
  "resourceId": "work-7",
  "version": 8,
  "reason": "updated"
}
```

- 연결 시 마지막 적용한 `serverSequence`를 제시한다.
- 보존 범위 안이면 server가 delta를 보내고, 아니면 `resync.required`를 보낸다.
- client는 `/changes?after=` 또는 resource snapshot을 받아 transaction으로 local cache를 교체한다.
- notification 수신 자체를 resource 변경 성공으로 간주하지 않는다.
- permission, membership, session revoke는 우선순위가 높은 control event이며 Main이 즉시 cache와 Runtime
  capability를 폐기한다.
- terminal, transcript body, file, media frame은 Realtime Gateway에 싣지 않는다.

## IPC와 Runtime 계약

모든 request는 `requestId`, `method`, `protocolVersion`, `sessionContext`, `payload`를 가지고 모든
response는 `ok`, typed result 또는 typed problem을 가진다.

- preload는 `project.list`, `workItem.update`, `workspace.open`처럼 도메인별 함수를 노출한다.
- Renderer가 임의 channel 이름, filesystem path, executable과 argument를 조합하는 범용 bridge를
  제공하지 않는다.
- Main은 sender frame, window role, 로그인 session, organization과 payload schema를 검사한다.
- Runtime은 Main의 판정을 그대로 신뢰하지 않고 capability의 audience, host, operation, path scope,
  expiry와 nonce를 다시 검사한다.
- native, WSL, SSH, Relay path는 host adapter에서 정규화하고 비교한다.
- stream은 bounded buffer, credit/window 또는 pause/resume을 가져야 하며 느린 Renderer 때문에 Main
  메모리가 무한 증가하지 않는다.
- handshake는 protocol range, runtime version, host type, SQLite version, Git capabilities, provider
  parser versions와 optional features를 반환한다.

## MCP tool 계약

초기 tool은 read와 제한된 additive write로 시작한다.

```text
pie.projects.list
pie.work_items.get
pie.work_items.search
pie.work_items.comment.create
pie.artifacts.register
pie.execution_context.get
```

- 상태 이동, 승인, 고객 제출, remote execution은 초기 MCP 범위에서 제외한다.
- 각 write에는 organization/project/work scope와 `idempotencyKey`를 요구한다.
- tool output은 전체 transcript나 access token을 반환하지 않는다.
- LLM이 전달한 ID, path, visibility와 완료 주장을 신뢰하지 않고 현재 session binding과 permission을
  확인한다.
- tool 호출 결과와 실제 server side effect를 correlation ID로 연결해 감사한다.
- MCP task가 experimental인 동안 장기 작업의 권위자는 Pie operation resource다.

## 호환성 정책

- additive optional field는 같은 minor에서 허용한다.
- required field 제거, enum 의미 변경, side effect 변경은 major schema/type 변경이다.
- consumer는 알 수 없는 optional field를 무시하지만 알 수 없는 enum을 임의 기본값으로 바꾸지 않는다.
- server는 최소 client version, 지원 protocol range와 disabled capability를 session 응답에 포함한다.
- parser는 provider format fixture 버전을 선언하고 unknown record 비율이 임계치를 넘으면 capture를
  metadata-only 또는 pause로 전환한다.
- compatibility CI는 현재 버전뿐 아니라 최소 지원 Electron, Runtime과 한 단계 이전 schema를
  실행한다.

## 계약 완료 기준

- OpenAPI와 schema에서 생성한 valid/invalid fixture가 Main, Runtime, 서버에서 같은 결과를 낸다.
- 같은 생성·MCP·Worker 요청을 반복해도 업무 결과는 하나다.
- event batch의 item ack, gap, permanent reject와 crash recovery를 재현한다.
- stale ETag 수정과 workflow version 불일치를 덮어쓰지 않는다.
- revoke 직후 local outbox, Runtime capability와 Realtime subscription이 재인가 전 fail closed한다.
- 구버전 client가 모르는 capability를 실행하지 않고 업데이트·제한 모드를 정확히 표시한다.
