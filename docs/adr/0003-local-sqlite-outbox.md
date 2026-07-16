# ADR-0003: 로컬 SQLite cache와 capture outbox

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture
- 관련 문서: `pie-docs/19-ai-project-portal.md`, `pie-docs/23-api-event-sync-contracts.md`,
  `pie-docs/30-database-physical-design.md`

## 맥락

Pie는 Claude Code, Codex 등 provider의 prompt, response, tool, Git과 test event를 로컬에서 관찰한다.
앱과 네트워크는 언제든 종료될 수 있고 native, WSL, SSH와 Relay host는 서로 다른 파일시스템과
SQLite version을 사용한다. UI cache, Agent orchestration과 고속 capture write를 한 저장소에 넣으면
lock, quota와 손상 복구의 영향 범위가 불필요하게 커진다.

중앙 업무 데이터는 PostgreSQL이 권위자이므로 로컬 DB가 Project, WorkItem, permission과 승인 상태의
독립적인 원본이 되어서는 안 된다.

## 결정

1. 로컬 상태를 lifecycle과 writer 기준으로 세 DB에 분리한다.
   - `portal-cache.sqlite`: device/profile 단위의 제한된 server projection, draft와 route state
   - `capture.sqlite`: host별 Runtime이 소유하는 capture event, cursor, delivery와 upload checkpoint
   - `orchestration.sqlite`: Agent task DAG와 dispatch 상태
2. 각 DB는 하나의 owning process만 write한다. Renderer는 SQLite를 직접 열지 않는다.
3. `capture.sqlite`는 다음 table 책임을 분리한다.
   - `capture_event`: immutable normalized event와 content hash
   - `outbox_delivery`: lease, retry, ack와 permanent rejection
   - `provider_cursor`: provider file identity와 byte 또는 opaque cursor
   - `stream_checkpoint`: local sequence, contiguous server ack와 gap
   - `capture_policy_cache`: expiry가 있는 server policy
   - `object_upload`: encrypted staging chunk와 finalize checkpoint
4. transcript parse, event insert와 cursor advance는 한 transaction이다. network와 object upload는
   transaction 밖에서 실행한다.
5. Runtime은 single writer와 짧은 transaction을 사용한다. WAL을 사용할 때 DB, `-wal`, `-shm`을
   하나의 상태로 관리하고 packaged Runtime의 SQLite capability를 시작 시 검사한다.
6. 미전송 event를 byte quota 초과나 logout 시 조용히 삭제하지 않는다. capture pause,
   metadata-only 또는 permanent rejection 상태를 사용자에게 표시한다.
7. raw payload는 SQLite BLOB에 장기 누적하지 않고 암호화된 staging object로 저장한다. 승인된 key
   source가 없는 host에서는 raw capture를 비활성화하고 metadata-only로 동작한다.
8. native, WSL distro, SSH provider와 Relay connection은 `host_id`, DB 경로, lease와 sequence를
   공유하지 않는다. provider가 소유한 DB를 Pie schema로 변경하지 않는다.
9. server ack가 `accepted` 또는 `duplicate`일 때만 local delivery를 완료한다. retryable reject와
   permanent reject를 분리한다.
10. SQLite migration은 순차적이고 idempotent해야 한다. migration 실패 시 해당 DB 기능을 fail closed
    하고 terminal·Git 같은 독립 Workspace 기능은 가능한 범위에서 유지한다.

## 이유

- capture와 cursor를 같은 transaction에 두면 crash 후 누락과 중복 범위를 결정적으로 복구할 수 있다.
- DB를 lifecycle별로 분리하면 capture 폭주나 cache 재생성이 Agent orchestration을 block하지 않는다.
- host별 outbox는 서로 다른 Git, path, provider sequence를 하나의 client clock으로 잘못 정렬하지 않는다.
- single writer는 Electron과 test Node의 SQLite version 차이, WAL checkpoint와 busy 제어를 단순화한다.

## 검토한 대안

### LocalStorage 또는 JSON file

부분 write, lease, cursor·event atomicity와 indexed retry query를 안정적으로 제공하지 못하므로 사용하지
않는다.

### 하나의 SQLite file

운영은 단순하지만 UI cache 재생성, capture quota와 orchestration의 lock·복구 범위가 결합되므로
선택하지 않는다.

### PostgreSQL에 직접 streaming

offline과 앱 종료를 견디지 못하고 Runtime에 장기 사용자 credential을 노출할 위험이 있어 선택하지
않는다.

### SQLite를 업무 데이터의 offline master로 사용

multi-user permission, 승인과 충돌을 endpoint별 원본으로 분산시키므로 선택하지 않는다.

## 결과와 제약

- schema migration, quota, integrity check와 diagnostics를 DB별로 구현해야 한다.
- local cache가 오래될 수 있으므로 UI는 offline·stale·pending 상태를 표시해야 한다.
- secure key store가 없는 remote host에서는 raw capture 기능이 제한된다.
- SQLite backup만으로 중앙 동기화 완료를 증명할 수 없으며 contiguous ack와 server snapshot을 함께
  확인해야 한다.

## 검증

- event insert 전·후, cursor update 전·후 process kill fault test
- 동일 event 재전송과 `accepted`, `duplicate`, retryable·permanent reject test
- WAL busy, checkpoint starvation, quota와 disk-full test
- native, WSL, SSH와 Relay host isolation test
- logout·membership revoke 후 upload fail-closed test
- corrupt DB에서 transcript reconciliation로 새 outbox를 만드는 recovery test
