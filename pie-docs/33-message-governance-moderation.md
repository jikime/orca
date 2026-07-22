# 메시지 거버넌스와 모더레이션 (R7 후속 에픽)

## 목적

채팅(R7, 슬라이스 1~10)은 채널·메시지·스레드·리액션·멘션·DM·그룹 DM·presence·첨부·검색·@channel/@here·뮤트까지 완성됐다.
남은 채팅 항목은 **메시지 거버넌스**다: 메시지를 **수정·삭제(감사 분리)**, **고정**, 그리고 대화를 **업무(WorkItem)로 전환**해 대화가 별도 메신저에 고립되지 않고 업무 문맥에 기록되게 한다(doc 08 §목적, §메시지 기능 30행, §권한규칙 84행).

이 에픽은 **얇은 impl 슬라이스가 아니라 설계 선행이 필요한 클러스터**여서 별도 문서로 청사진을 고정한다.

2026-07-21 기준 s1~s4의 서버·Desktop 수직이 구현됐다. 이 문서에서 `연기`로 남는 범위는 AI 요약,
legal hold, eDiscovery와 조건별 자동 보존이다.

## 범위 판정 — 지금 buildable vs 연기

| 항목 | 근거 | 판정 |
|---|---|---|
| 메시지 **수정 이력** | doc 30:268 `collaboration.message_revisions` 예약; messages 마이그레이션 주석 "message_revisions is a later slice" | **지금** (R7 위) |
| 메시지 **삭제 + 감사/본문 보존 분리** | doc 08:84 "삭제된 메시지의 감사 메타데이터와 실제 본문 보존은 정책을 분리한다" | **지금** |
| **고정 메시지** | doc 08:26 | **지금** |
| **메시지→WorkItem 전환** | doc 08:30 "메시지에서 작업·티켓·결정 생성"; doc 27 IntakeItem·WorkItem(R4 `delivery.work_items` 존재) | **지금** (R4+R7 위) |
| **AI 요약·액션 아이템** | doc 08:31, doc 09 knowledge-automation | **연기** → R5 AI workspace/모델 접근 인프라 의존. 전환이 만든 링크 위에 얹는다. |
| 메시지 **보존 기간** | doc 08:29 | **기본 구현** → 채널별 1~3650일·무기한, 관리자 즉시 적용. legal hold와 조건별 정책은 별도. |
| **회의(화상)** | doc 08:36~49 | **연기** → 전용 SFU/LiveKit `meeting` 프로파일(ADR-0011). 이 에픽과 무관. |

## 불변식(모든 슬라이스 공통)

- 모든 신규 테이블은 표준 RLS pair(`*_tenant_isolation` permissive + `*_tenant_boundary_guard` restrictive) + FORCE + 복합 tenant PK/FK. org 스코프 필수, SQL 전부 파라미터화.
- 실시간은 기존 outbox→worker→gateway를 **additive 재사용**(`ResourceChangeResourceType` union에 신규 타입 추가만, 새 전송 0). worker/gateway 배달 코드 무변경.
- 전환은 **collaboration↔delivery 경계**를 넘되, 각 스키마의 RLS/권한을 각각 통과한다(메시지 읽기 권한 + WorkItem 생성 권한 동시 충족). 한 org tx 안에서 소스 링크와 WorkItem을 함께 커밋.

## 데이터 모델

### 1. 편집 이력 — `collaboration.message_revisions` (immutable revision)
doc 30 원칙(게시된 revision을 update로 덮어쓰지 않고 새 revision 추가). messages.version/updated_at는 이미 OCC.

```
message_revisions
- (organization_id, id) PK
- message_id (복합 FK → messages, on delete cascade)
- revision  bigint         -- 1부터, 편집마다 +1 (message.version과 정렬)
- body      text           -- 그 시점 본문 스냅샷
- edited_by uuid            -- 편집 행위자
- created_at timestamptz
- unique (organization_id, message_id, revision)
```
편집 시: messages.body 갱신 + version+1(OCC, `expectedVersion` 필수) + **직전 본문을 revision 행으로 보존**(최초 편집 시 원본=revision 1, 새 본문=revision 2). 편집 권한 = **작성자 본인만**(모더레이터는 편집 불가, 삭제만).

### 2. 삭제 — soft-delete tombstone + 감사/본문 분리 (doc 08:84)
messages에 컬럼 추가(신규 테이블 아님):
```
alter messages add deleted_at timestamptz          -- tombstone 시각(있으면 삭제됨)
alter messages add deleted_by uuid                 -- 삭제 행위자(감사)
alter messages add deletion_reason text            -- moderator 삭제 사유(선택)
```
- **감사 메타데이터는 항상 보존**(누가·언제·왜 삭제했는지 행 자체는 유지). **본문은 정책에 따라 분리**: 기본은 body를 tombstone 시 redact('' 또는 sentinel)하되, revision 이력의 본문 보존 여부는 body-retention 정책 축(연기 항목)과 연결. v1은 body를 즉시 redact + revision 이력도 redact(감사 메타만 남김) — 가장 보수적. 정책 훅은 남긴다.
- **권한**: 작성자 본인(자기 메시지) **또는** `channel.manage`(모더레이터가 타인 메시지). 모더레이터 삭제는 `deletion_reason`·감사 이벤트 필수.
- 읽기 모델: 삭제된 메시지는 목록에 tombstone으로 표시(body 없음, "삭제된 메시지" + 감사 메타), 리액션/스레드 포인터는 유지(스레드 붕괴 방지).

### 3. 고정 메시지 — `collaboration.message_pins`
```
message_pins
- (organization_id, id) PK
- channel_id, message_id (복합 FK)
- pinned_by uuid, created_at
- unique (organization_id, channel_id, message_id)   -- 같은 메시지 중복 고정 금지
```
- 권한: 채널 멤버(`message.post`) 또는 `channel.manage`(제품 결정 — v1은 멤버 고정 허용, 상한 캡). 고정/해제 idempotent. `GET .../pins` 목록.

### 4. 메시지→WorkItem 전환 — `collaboration.message_work_item_links`
```
message_work_item_links
- (organization_id, id) PK
- message_id (복합 FK → messages)
- work_item_id uuid           -- delivery.work_items.id (같은 org, cross-schema는 FK 대신 앱 무결성)
- created_by uuid, created_at
- unique (organization_id, message_id, work_item_id)
```
- 흐름: 소스 메시지 읽기 권한 + 대상 team의 WorkItem 생성 권한 동시 확인 → `createWorkItem({title=메시지 요지/본문 발췌, description=역링크 문맥, teamId, projectId?})` 호출 → 링크 행 기록 → 소스 메시지에 "이 대화에서 생성됨" 역참조 노출. **doc 27 IntakeItem 경로**(정규 WorkItem 전 검토)는 v2 옵션으로 남기고, v1은 직접 전환 + 링크.
- idempotency-Key 필수(전환은 mutation). 전환은 `work_item.created` 실시간을 그대로 타고, 링크는 `message` invalidation을 additive로 태운다.

## 슬라이스 분해(의존 순서)

- **s1 · 편집 + 삭제(감사 분리)** — message_revisions + messages tombstone 컬럼. 편집=작성자 OCC, 삭제=작성자|`channel.manage`+감사. moderation 코어. (독립, 먼저)
- **s2 · 고정 메시지** — message_pins + pin/unpin/list. (s1 무관, 병렬 가능하나 순차)
- **s3 · 메시지→WorkItem 전환** — message_work_item_links + 전환 라우트. collaboration↔delivery 경계. (R4 delivery 필요, 존재함)
- **(연기) AI 요약·액션아이템** — R5 AI 인프라 위, s3 링크 재사용.
- **s4 · 기본 보존·내보내기·감사 조회** — 채널별 기간, 멱등 적용, 10,000건 JSON 내보내기와 관리자 감사 화면.
- **(연기) legal hold·eDiscovery** — 삭제 정지, 조건별 정책, 대규모 자동 실행과 증거 보존.

## 보안 요점

- 편집: 작성자만. 삭제: 작성자(자기) | `channel.manage`(타인, 사유+감사). 전환: `message.read`(소스) ∧ WorkItem 생성 권한(대상 team). 고정: 멤버 이상.
- 삭제는 tombstone(하드 삭제 아님) — 감사 불변, 스레드 무결성 유지. 모더레이터 행위는 audit 이벤트.
- cross-schema 전환은 각 스키마 RLS를 각각 통과(우회 금지). 링크 테이블은 collaboration 소속, work_item_id는 앱 레벨 무결성(cross-schema FK 회피, org 일치 검증).

## 진행 방식

s1~s4의 구현과 검증 기준은 [채팅 핵심 제품 로드맵](./36-chat-core-roadmap.md)과
[채팅 릴리스 검증 기록](./37-chat-release-evidence.md)이 소유한다.
