# ADR-0006: 원문·binary와 Object Storage 경계

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture and Security
- 관련 문서: `pie-docs/18-data-governance-integrations.md`, `pie-docs/19-ai-project-portal.md`,
  `pie-docs/30-database-physical-design.md`

## 맥락

LLM transcript, tool output, patch, report, 문서, 첨부, 원격지원 녹화와 회의 media는 크기가 크고
보존·분류·검역 요구가 서로 다르다. 이를 PostgreSQL row에 누적하면 backup, replication, index와
transaction latency가 binary 크기에 종속된다.

반대로 Object Storage key나 presigned URL만 업무 ID로 사용하면 tenant permission, immutable evidence,
삭제 lineage와 검색 재생성을 보장하기 어렵다.

## 결정

1. 큰 원문과 binary는 S3-compatible Object Storage에 저장한다.
2. PostgreSQL은 object의 권위 있는 metadata를 저장한다.
   - opaque object ID와 `organization_id`
   - storage provider·bucket을 숨긴 logical storage key
   - SHA-256, size, media type, classification와 retention
   - upload actor, source, parser version과 lineage
   - `staging`, `available`, `quarantined`, `rejected`, `deleting`, `deleted` 상태
3. object key는 tenant namespace와 무작위 ID를 사용한다. tenant를 넘는 global hash deduplication을 하지
   않는다.
4. transcript와 tool output은 content-addressed chunk로 나눌 수 있지만 chunk identity와 deduplication은
   같은 tenant·classification boundary 안에서만 사용한다.
5. client는 upload intent를 요청하고 짧은 수명의 capability로 multipart upload한 뒤 hash와 part 결과를
   finalize한다. presigned URL과 upload ID는 resource identity가 아니다.
6. Artifact, Evidence, ProjectUpdate, 승인과 검수는 `available` immutable object revision만 참조한다.
   새 파일은 기존 revision을 덮어쓰지 않는다.
7. download, preview, export와 search fetch마다 tenant, resource permission, classification와 retention을
   다시 확인한다.
8. secret scan, malware scan 또는 policy 검사가 필요한 object는 quarantine을 통과하기 전 다른 사용자에게
   노출하지 않는다.
9. Realtime과 일반 업무 event에는 raw object body를 싣지 않는다.
10. 삭제는 PostgreSQL metadata, object revision, search, cache, legal hold와 backup expiry를 잇는 비동기
    workflow로 처리하고 tombstone을 남긴다.
11. cloud와 on-prem 구현은 S3 domain adapter 뒤에 두며 특정 provider URL, ETag 의미와 credential을
    domain model에 노출하지 않는다.

## 저장 흐름

```text
upload intent
-> permission·quota·classification 확인
-> staging object capability 발급
-> client multipart upload
-> hash·size·part finalize
-> scan / quarantine decision
-> immutable object revision available
-> Artifact·Evidence relation 생성
```

finalize와 Artifact relation 생성은 idempotency key를 사용한다. Object Storage 성공 후 DB finalize가
실패하면 orphan staging sweeper가 보존 기간 뒤 정리하며, DB가 `available`로 확정하지 않은 object를
정상 Artifact로 표시하지 않는다.

## 검토한 대안

### PostgreSQL `bytea`에 모든 content 저장

작은 원자적 payload에는 가능하지만 transcript·녹화가 backup, WAL과 query latency를 지배하므로 기본
방식으로 선택하지 않는다.

### 로컬 파일 경로 공유

native, WSL, SSH와 다른 사용자 장비에서 의미가 없고 permission·retention을 통제할 수 없으므로
선택하지 않는다.

### Global hash deduplication

tenant 간 content 존재를 추측하게 만들고 encryption·deletion 경계를 결합하므로 선택하지 않는다.

### Object Storage event를 업무 source of truth로 사용

관계 무결성, permission, version과 audit transaction을 제공하지 못하므로 선택하지 않는다.

## 결과와 제약

- PostgreSQL과 Object Storage 사이에는 분산 transaction이 없으므로 staging, finalize, sweeper와
  reconciliation이 필요하다.
- preview와 검색은 object fetch latency, range와 cache 정책을 고려해야 한다.
- backup과 legal deletion은 두 저장소의 lineage를 함께 검증해야 한다.
- object provider 선택, encryption key topology와 antivirus engine은 배포·보안 ADR에서 별도로 고정한다.

## 검증

- 같은 upload intent와 finalize의 반복·순서 역전 test
- hash·size 불일치, multipart 중단과 orphan staging cleanup test
- tenant를 바꾼 presigned capability와 object ID 접근 거부 test
- quarantine 전 preview·search·download 차단 test
- Artifact revision 불변성과 Evidence pinning test
- delete·legal hold·backup expiry lineage test
- cloud S3와 on-prem compatible store contract suite
