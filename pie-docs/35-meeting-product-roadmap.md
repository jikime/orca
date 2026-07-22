# 회의·회의록 제품 로드맵 (R7)

## 문서 목적

이 문서는 Pie 회의 기능의 현재 구현, 목표 제품 범위, 데이터 계약 후보, 구현 순서와 완료 조건을
하나의 실행 기준으로 고정한다. [협업과 회의](./08-collaboration-meetings.md)는 제품 범위를,
[구현 로드맵](./14-implementation-roadmap.md)은 전체 R7 순서를 소유하며, 이 문서는 회의·회의록
도메인의 상세 backlog와 검증 gate를 소유한다.

문서 상태는 `기준`, `구현됨`, `부분 구현`, `계약 초안`, `결정 필요`, `확장`으로 구분한다. 미래
기능이 이 문서에 적혀 있다는 이유만으로 구현 완료로 간주하지 않는다. 완료에는 contract,
migration, 서버 권한, Renderer, 자동화 테스트와 운영 검증이 모두 필요하다.

## 제품 포지셔닝

Pie는 Zoom 전체를 복제하는 범용 화상회의 제품을 목표로 하지 않는다. 핵심 가치는 회의에서 나온
결정과 후속 조치를 원래 프로젝트·티켓·고객 문맥에 근거와 함께 연결하고, 사람이 검토한 뒤 실제
업무로 전환하는 것이다.

```text
회의 일정·업무 문맥
  -> 안전한 음성·영상·화면 공유
  -> 동의된 녹화·전사
  -> 시간·화자가 있는 근거
  -> 사람이 검토한 요약·결정·후속 조치
  -> Project·Ticket·WorkItem·Knowledge에 연결
  -> 완료 상태와 다음 회의까지 추적
```

### 제품 원칙

1. **업무 문맥 우선**: 회의는 독립 캘린더 항목이 아니라 Project·Ticket·RemoteSession 문맥을
   상속한다.
2. **근거 우선**: AI 요약과 액션 아이템은 전사 시간 구간 또는 사용자 입력으로 출처를 추적한다.
3. **명시적 동의**: 녹화, 전사, AI 처리와 화면 캡처의 목적·상태·철회를 구분한다.
4. **사람의 승인**: AI가 만든 결정·담당자·기한은 사람이 승인하기 전 공식 업무 상태를 바꾸지
   않는다.
5. **권한 재검증**: 화면 표시뿐 아니라 Control Plane, media token, Object Storage와 검색에서 같은
   권한을 다시 검증한다.
6. **미디어 경계 분리**: 영상·음성은 LiveKit SFU, 업무 진실원천은 Control Plane, 큰 녹화와 전사는
   Object Storage가 소유한다.
7. **감시 제품 금지**: 발언량·감정·코칭 점수는 고객의 명확한 목적과 정책 없이 개인 평가로
   사용하지 않는다.

## 현재 구현 기준선

2026-07-21 저장소 기준이다. `구현됨`은 현재 수직 흐름이 존재한다는 뜻이며 운영 배포 준비 완료를
뜻하지 않는다.

| 영역           | 상태      | 현재 기준                                                       | 남은 핵심                                        |
| -------------- | --------- | --------------------------------------------------------------- | ------------------------------------------------ |
| 회의 lifecycle | 구현됨    | scheduled → live → ended/cancelled, OCC, 반복 occurrence       | 취소 UX, 비정상 종료 복구                         |
| 업무 연결      | 구현됨    | Project·Ticket·RemoteSession 생성 문맥과 결과 역링크       | 실장비 사용성 검증                               |
| 참여자         | 핵심 구현 | 내부 검색, guest link/session, 대기실, 호스트·공동 호스트       | 초대를 소비하는 Desktop onboarding E2E              |
| LiveKit media  | 핵심 구현 | room 제한 단기 token, 다자간 media, 역할별 capability, 재연결 | 실장비·교차 플랫폼 E2E                           |
| 회의 화면      | 구현됨    | 갤러리·발언자 보기, 고정, 화면 공유 발표 무대, 원격 음성 분리   | 대규모 pagination, 전체 화면, 접근성 E2E         |
| 장치           | 구현됨    | 카메라·마이크·스피커 선택·미리보기·진단·hot-plug 상태   | 장치·OS별 복구 E2E                              |
| 화면 공유      | 구현됨    | 화면·창 선택, 공유 화면 우선 배치                               | 시스템 오디오, 다중 공유 정책, 주석              |
| 실시간 자막    | 부분 구현 | LiveKit text stream을 회의 중 표시                              | 영구 저장, 언어 선택, 수정·검색                  |
| 녹화           | 구현됨    | capture별 동의 gate, MP4 grid 녹화, pause/resume/stop, 재생 URL | 부분 redaction, 대규모 복구 E2E                  |
| 사후 전사      | 구현됨    | diarized 결과의 시간·화자 segment, 검색·seek·수정·revision      | 언어 선택, 대규모 접근성 E2E                     |
| AI 회의록      | 구현됨    | 요약과 근거가 연결된 결정·후속 조치 후보, provenance            | M6 생산성 확장은 개발 보류                     |
| 검토·확정      | 구현됨    | 회의록과 항목별 approve/reject/edit, OCC revision               | 템플릿별 비교 UI                                 |
| 결정·후속 조치 | 구현됨    | 독립 엔터티, 근거 segment, 담당·기한·상태, WorkItem 전환        | M7 briefing·누적 동기화는 개발 보류             |
| 채팅·파일      | 구현됨    | 영속 thread·첨부와 녹화·전사·회의록·결과를 묶은 Recap           | 권한 인식 통합 검색                              |
| 일정·알림      | 핵심 구현 | 시작·종료·시간대·반복, Desktop 알림, outbound calendar adapter     | provider OAuth 연결·갱신·회수 E2E                 |
| 검색·공유      | 부분 구현 | 회의 목록·segment 검색, Recap 근거 탐색, 감사되는 JSON export   | 복수 회의·의미 검색, 수신자 정책, clips          |
| 거버넌스       | 부분 구현 | capture별 동의, 보존·자동 삭제, legal hold, 삭제·export 감사    | 부분 redaction, 관리자 step-up, backup 재삭제    |

### 구현 근거

- Renderer: `src/renderer/src/pie/meetings/`
- media boundary: `platform/apps/control-plane-api/src/livekit-meeting-media.ts`
- meeting HTTP vertical: `platform/apps/control-plane-api/src/meeting-routes.ts`
- presence/token webhook: `platform/apps/control-plane-api/src/meeting-media-routes.ts`
- processing worker: `platform/apps/control-plane-worker/src/meeting-processing-loop.ts`
- AI transcription/minutes: `platform/apps/control-plane-worker/src/meeting-ai-client.ts`
- persistence: `platform/packages/persistence/src/meeting-*.ts`
- wire contracts: `contracts/schemas/resources/meeting-*.v1.schema.json`

### 2026-07-21 단계별 구현 결과

1. **전사 타임라인**: 구조화 segment 저장·조회, cursor pagination, 검색, 녹화 seek와 수정 revision을
   연결했다.
2. **결정과 액션 아이템**: AI 후보를 독립 엔터티로 저장하고 근거 segment, 항목별 검토와 승인된
   action의 멱등 WorkItem 전환을 연결했다.
3. **참여 전 점검과 호스트 제어**: 카메라·마이크·스피커 선택과 미리보기, 호스트의 원격 mute/remove,
   차단된 참여자의 token 재발급 거부를 연결했다.
4. **일정과 Recap**: 시작·종료 입력과 검증, 10분 전 Desktop 알림, 녹화·전사·회의록·결정·액션을
   한 화면에 모은 종료 후 Recap을 연결했다.
5. **캡처 거버넌스**: 녹화·전사·AI note·발표 화면 캡처 동의를 분리하고 정책 변경·동의 철회·새 참여자
   입장 시 서버가 캡처를 차단하거나 일시정지한다. 보존 만료·수동 삭제 worker, 파생 데이터와 객체 저장소
   연쇄 삭제, legal hold, JSON export와 감사 조회를 연결했다.

이 결과는 M1·M2의 현재 수직, M3의 핵심 수직, M4와 M5의 제품 수직을 구현한 것이다.
다만 M0 실장비 E2E, M3의 부분 redaction·관리자 step-up·backup 복원 후 재삭제,
외부 guest 소비 흐름과 calendar 자격증명 lifecycle은 운영 완결을 위해 남는다. M6은
[회의록 생산성 보류 설계](./38-meeting-minutes-productivity-deferred.md)로 이관했고 M7도 명시적 재개 전까지
보류한다.

## 목표 사용자 흐름

### 회의 전

- Project·Ticket·RemoteSession에서 회의를 생성한다.
- 제목, 안건, 시작·종료 시각, 시간대, 반복, 내부·외부 참석자와 기록 정책을 지정한다.
- Google Workspace 또는 Microsoft 365 일정과 동기화하고 만료되는 참여 링크를 발급한다.
- 참여 전 화면에서 카메라·마이크·스피커, 권한과 네트워크 상태를 확인한다.
- 이전 회의의 미완료 액션, 변경된 요구사항과 열린 위험을 안건 후보로 보여준다.

### 회의 중

- 대기실, 호스트 승인, 공동 호스트, 발표자와 참여자 권한을 강제한다.
- 음성·영상, 화면·창과 선택적 시스템 오디오를 공유한다.
- 갤러리·발언자·화면 공유 무대를 전환하고 참여자를 고정한다.
- 회의 thread에서 링크·파일·메모를 공유하고 종료 후에도 같은 문맥에서 찾는다.
- 녹화·전사·AI note 상태와 참여자별 동의를 항상 표시하고 즉시 pause/stop할 수 있다.
- 자막 언어를 선택하고 늦게 참여한 사용자는 권한이 허용한 `지금까지 요약`을 볼 수 있다.
- 연결 저하, 재연결, 장치 제거와 media 장애를 기능별로 명확히 표시한다.

### 회의 후

- 녹화, 화자·시간별 전사, 공유 파일, thread, 참석 기록, 요약을 하나의 Recap에서 본다.
- 요약 문장, 결정과 액션 아이템에서 근거가 된 전사 시점으로 이동한다.
- 잘못된 화자와 전사를 수정하되 원본·수정자·revision을 보존한다.
- 회의 유형별 템플릿으로 요약을 재생성하고 결과를 비교한다.
- 결정과 액션 아이템을 항목별로 승인해 Project·Ticket·WorkItem으로 연결한다.
- 녹화 구간을 clip으로 만들고 허용된 수신자에게 공유하거나 파일로 내보낸다.
- 권한이 허용된 단일·복수 회의에 질문하고 답변의 전사 근거를 확인한다.

## 도메인 계약 초안

이 절은 구현 방향을 고정하지만 필드 이름과 table 경계는 각 slice의 schema review에서 확정한다.

### MeetingTranscriptSegment

```text
MeetingTranscriptSegment
- id / organizationId / meetingId / transcriptId
- sequence
- speakerParticipantId? / speakerLabel
- startMs / endMs
- text / language? / confidence?
- source: live | post_recording | corrected
- supersedesSegmentId?
- createdBy? / createdAt / version
```

- 시간은 녹화 시작 기준 millisecond로 저장하며 `startMs <= endMs`를 강제한다.
- AI diarization의 임의 speaker label과 검증된 Pie participant identity를 분리한다.
- 수정은 원본을 덮어쓰지 않고 새 revision 또는 correction lineage를 남긴다.
- 긴 전사는 segment cursor pagination과 권한 인식 검색을 사용한다.

### MeetingEvidenceReference

```text
MeetingEvidenceReference
- id / organizationId / meetingId
- targetType: minutes_section | decision | action_item | knowledge_candidate
- targetId
- transcriptSegmentId
- startOffset? / endOffset?
- createdBy: ai | user
- createdAt
```

- AI 출력의 인용은 실제 segment와 같은 tenant·meeting에 있어야 한다.
- 전사 수정 또는 삭제 시 근거가 사라졌음을 표시하며 조용히 다른 문장으로 재연결하지 않는다.

### MeetingDecision

```text
MeetingDecision
- id / organizationId / meetingId
- statement
- status: proposed | confirmed | superseded | rejected
- ownerUserId?
- decidedAt?
- projectId? / ticketId?
- createdBy: ai | user
- reviewStatus / reviewedBy? / reviewedAt?
- version / createdAt / updatedAt
```

- `confirmed` 전환은 사람의 명시적 승인과 근거를 요구한다.
- 뒤집힌 결정은 삭제하지 않고 `superseded`와 후속 결정 관계를 남긴다.

### MeetingActionItem

```text
MeetingActionItem
- id / organizationId / meetingId
- task
- assigneeUserId? / dueAt? / priority?
- status: proposed | accepted | in_progress | completed | cancelled
- projectId? / ticketId? / workItemId?
- createdBy: ai | user
- reviewStatus / reviewedBy? / reviewedAt?
- version / createdAt / updatedAt
```

- AI가 추정한 담당자와 기한은 `proposed`이며 승인 전 사용자 배정이나 WorkItem을 만들지 않는다.
- WorkItem 전환은 idempotent하고 역링크를 가진다. WorkItem 상태는 회의 엔터티가 임의로 덮어쓰지 않는다.

### MeetingCaptureConsent

```text
MeetingCaptureConsent
- id / organizationId / meetingId / participantId
- captureType: recording | transcription | ai_notes | presentation_screenshot
- policyVersion / purpose
- status: pending | granted | denied | revoked
- grantedAt? / revokedAt? / expiresAt?
- version / createdAt / updatedAt
```

- 새로운 capture type을 시작하거나 정책 version이 바뀌면 기존 동의를 재사용하지 않는다.
- 새 참여자 입장, 철회, 대기실 복귀와 재참여가 capture 상태에 미치는 영향을 서버가 판정한다.
- 동의가 필요한 capture는 UI 버튼 비활성화만으로 막지 않고 서버와 media control에서 거부한다.

## 구현 단계

### M0 · 현재 수직 안정화

목표는 기존 기능을 다음 단계의 안전한 기준선으로 만드는 것이다.

- 서로 다른 인증 사용자 2명으로 영상·음성·화면 공유 E2E
- 카메라 2개 전환, 장치 제거·복귀, camera/mic mute 반영
- LiveKit reconnect와 Control Plane 재로그인 경계 검증
- 녹화 시작·중지·egress 완료·재생·전사·AI 회의록 전체 E2E
- 긴 회의의 MP3 upload 상한과 worker 재시도·terminal failure 검증
- Docker meeting profile health와 장애별 사용자 메시지 정리

완료 조건: macOS 실장비와 자동화 가능한 media mock에서 핵심 흐름이 재현되고, 실패한 단계가
`연결`, `녹화`, `전사`, `요약` 중 어디인지 UI와 로그에서 구분된다.

### M1 · 근거가 있는 전사 타임라인

1. segment contract·fixture·migration·store
2. diarized transcription 결과를 segment로 영속화
3. cursor pagination과 transcript read API
4. 화자·시간별 Renderer 타임라인
5. segment 클릭 → 녹화 seek
6. 화자 이름·본문 correction과 immutable revision
7. 검색과 AI 근거 reference

완료 조건: 사용자가 요약의 결정 문장을 눌러 근거 전사와 녹화 시점으로 이동하고, 화자 수정 후에도
원본·수정 이력과 기존 인용의 상태를 확인할 수 있다.

### M2 · 결정과 액션 아이템을 업무로 전환

1. `MeetingDecision`, `MeetingActionItem`, evidence reference contract
2. 기존 AI JSON 출력을 문자열이 아니라 후보 엔터티로 저장
3. 항목별 approve/reject/edit
4. Project·Ticket 역링크
5. 승인된 action item → WorkItem idempotent 전환
6. 담당자·기한·상태 동기화와 다음 회의 미완료 항목 표시

완료 조건: AI가 만든 항목이 승인 전에는 업무를 바꾸지 않고, 승인 후 생성된 WorkItem에서 회의와
근거 시점으로 돌아갈 수 있다.

### M3 · 동의·보존·삭제

1. capture type별 consent와 조직 정책
2. 회의 중 pause/resume/stop과 새 참여자 처리
3. 보존 기간·quota·자동 삭제 job
4. 녹화·전사·요약·embedding·검색·cache cascade delete
5. 부분 redaction, export와 legal hold
6. 관리자 열람 step-up, 사유와 감사 이벤트

완료 조건: 동의 철회가 새 capture를 즉시 막고, 삭제 요청이 파생 데이터와 복구된 backup의 재삭제까지
추적 가능한 상태로 전파된다.

### M4 · 참여 전 점검과 호스트 제어

1. camera/mic/speaker preview와 장치 선택
2. 권한·네트워크·LiveKit endpoint 진단
3. waiting room과 admit/deny
4. host/co-host/presenter/participant 권한
5. mute/remove, screen-share policy와 token capability 축소
6. reconnecting/degraded/recovered 상태와 안전한 재참여

완료 조건: 일반 참여자가 호스트 전용 동작을 API나 LiveKit token으로 우회하지 못하고, 장치·네트워크
장애가 회의 전체 장애처럼 표시되지 않는다.

### M5 · 일정·게스트·회의 문맥

1. 시작·종료·시간대·반복 UI와 reminder
2. Google Workspace·Microsoft 365 calendar adapter
3. 내부 사용자 검색 초대와 외부 guest link
4. 링크 만료·회수·대기실·guest visibility
5. Project·Ticket·RemoteSession에서 생성과 결과 역링크
6. 회의 thread·파일·agenda·recap 연결

완료 조건: 일정에서 참여한 내부·외부 사용자가 허용된 회의 문맥만 보고, 회의 종료 후 자료와 결과가
원래 업무 화면에 남는다.

### M6 · 회의록 생산성

**상태: 개발 보류.** 재개 기준과 slice는
[회의록 생산성 보류 설계](./38-meeting-minutes-productivity-deferred.md)가 소유한다.

- 회의 유형별 요약 template과 조직 custom instruction
- 요약 길이·섹션·언어·수신자 설정
- 재생성·버전 비교와 항목별 provenance
- 회의 중 권한이 있는 `지금까지 요약`
- 단일 회의 Q&A와 follow-up email 초안
- PDF, DOCX, Markdown, JSON, SRT export
- 녹화 chapter, highlight, clip과 제한 공유 링크

완료 조건: 생성 결과마다 사용한 transcript revision, model, prompt/template version과 사람 검토 상태를
확인할 수 있다.

### M7 · 누적 회의 지식과 자동화

**상태: 개발 보류.** 다른 핵심 메뉴 개발 후 명시적 우선순위가 부여될 때만 재개한다.

- Project·고객·반복 회의 단위 권한 인식 검색과 Q&A
- 이전 결정, 미완료 액션, 반복 blocker와 위험의 다음 회의 briefing
- 회의에서 요구사항·변경요청·지식문서·Runbook 후보 생성
- topic trend와 고객 요청 패턴
- 외부 Zoom·Meet·Teams 녹화 import 또는 calendar notetaker는 별도 entitlement로 검토

완료 조건: 복수 회의 답변도 각 주장에 원본 회의·전사 근거가 있고, 권한 회수와 삭제가 검색·요약에
전파된다.

## 완료된 backlog

M1은 다음 네 개의 독립 검증 가능한 slice로 구현했다.

| 순서 | Slice                       | 상태   | 산출물                                                   | 핵심 gate                                |
| ---- | --------------------------- | ------ | -------------------------------------------------------- | ---------------------------------------- |
| 1    | M1-S1 segment authority     | 구현됨 | JSON Schema, fixture, migration, persistence store       | tenant RLS, 시간·순서 불변식, pagination |
| 2    | M1-S2 processing ingestion  | 구현됨 | diarized JSON → segment 저장, retry/replay               | idempotency, 중복 segment 0, 긴 입력     |
| 3    | M1-S3 transcript timeline   | 구현됨 | 화자·시간 UI, 녹화 seek, 검색                            | keyboard/screen reader, 대량 virtualize  |
| 4    | M1-S4 correction/provenance | 구현됨 | speaker rename, text correction, revision, evidence 상태 | OCC, 감사, 원본 보존                     |

M3의 핵심 수직도 다음 순서로 구현했다.

| 순서 | Slice                         | 상태   | 산출물                                                    | 핵심 gate                             |
| ---- | ----------------------------- | ------ | --------------------------------------------------------- | ------------------------------------- |
| 1    | M3-S1 capture consent         | 구현됨 | capture별 정책 버전·목적·grant/deny/revoke                | 전 참여자 동의, 만료·정책 변경        |
| 2    | M3-S2 capture control         | 구현됨 | start/pause/resume/stop, 새 참여자·철회 처리              | 서버 재검증, LiveKit egress 중단      |
| 3    | M3-S3 retention and deletion  | 구현됨 | 보존 기한, lease worker, 객체·파생 레코드 연쇄 삭제       | RLS, retry/backoff, legal hold        |
| 4    | M3-S4 governance UI and audit | 구현됨 | 목적·보존·legal hold UI, JSON export, 감사 조회·삭제 확인 | OCC, typed confirmation, export audit |

M4도 다음 네 개의 독립 검증 가능한 slice로 구현했다.

| 순서 | Slice                           | 상태   | 산출물                                                    | 핵심 gate                                  |
| ---- | ------------------------------- | ------ | --------------------------------------------------------- | ------------------------------------------ |
| 1    | M4-S1 prejoin diagnostics       | 구현됨 | camera/mic/speaker preview, LiveKit endpoint·latency 점검 | 미디어 장애를 Core 장애와 분리             |
| 2    | M4-S2 waiting room              | 구현됨 | request/waiting/admit/deny/reinvite 상태                  | 승인 전 token 차단, host/co-host 서버 판정 |
| 3    | M4-S3 participant capabilities  | 구현됨 | host/co-host/presenter/participant, 역할 변경 UI          | screen-share source 축소, token 강제 회수  |
| 4    | M4-S4 connection recovery state | 구현됨 | reconnecting/degraded/recovered, 장치 제거 오류           | LiveKit 자동 복구 상태와 안전한 재참여     |

M5의 일정·게스트·회의 문맥도 다음 수직으로 구현했다.

| 순서 | Slice                         | 상태   | 산출물                                                             | 핵심 gate                                      |
| ---- | ----------------------------- | ------ | ------------------------------------------------------------------ | ---------------------------------------------- |
| 1    | M5-S1 schedule authority      | 구현됨 | 시작·종료, IANA 시간대, daily/weekly/monthly 반복, occurrence 알림 | DST wall-clock 보존, 잘못된 지역 시각 거부     |
| 2    | M5-S2 internal invite         | 구현됨 | 조직 사용자 이름 검색, 참가자 display name                         | active membership만 노출, 서버 invitation gate |
| 3    | M5-S3 guest lifecycle         | 구현됨 | hash-only 링크, 만료·회수, link별 신원·가시성, guest session       | 링크 회수 즉시 media session 차단, 대기실 승인 |
| 4    | M5-S4 calendar boundary       | 구현됨 | Google Workspace·Microsoft 365 export/update adapter               | 외부 실패 격리, 명시적 outbound 동작만 허용    |
| 5    | M5-S5 context backlinks       | 구현됨 | Project·Ticket·RemoteSession 생성과 관련 회의·recap 역링크         | 원래 리소스 화면에서 결과 재진입               |
| 6    | M5-S6 thread and recap bundle | 구현됨 | 회의 chat·파일, agenda, transcript, decisions/actions, recap       | guest visibility 밖의 문맥 미노출              |

회의 메뉴의 신규 생산성 기능은 더 이상 우선 개발하지 않는다. 남은 회의 작업은 다음
운영 완결 범위로 제한한다.

1. 서로 다른 인증 계정·장치와 macOS·Windows·Linux의 실장비 다자간 media E2E
2. 초대 링크 열기 → 설치·로그인 또는 limited guest → 대기실 → 참여의 Desktop 소비 흐름
3. Google·Microsoft OAuth 연결·갱신·회수와 실제 provider E2E. 현재 adapter는 배포 환경의
   access token 주입을 사용한다.
4. 부분 redaction, 관리자 step-up, backup 복원 후 재삭제 전파
5. 긴 녹화·장치 hot-plug·재연결·LiveKit/Egress 부분 장애의 복구 및 사용자 메시지 검증

이 항목을 닫으면 회의 메뉴는 기능 동결 상태로 전환할 수 있다. 누적 회의 지식·자동화
M7은 다른 메뉴 개발 후 명시적으로 재개한다.

## 검증 매트릭스

| 계층       | 필수 검증                                                                          |
| ---------- | ---------------------------------------------------------------------------------- |
| Contract   | unknown optional 호환, invalid segment/consent fixture, OpenAPI operation 연결     |
| Database   | tenant RLS, 같은 meeting FK, pagination 정밀도, OCC, immutable revision            |
| API        | 역할 허용·거부, invitation/waiting-room gate, idempotency, ETag, rate limit        |
| Media      | 2명 이상 publish/subscribe, mute, screen share, reconnect, device hot-plug         |
| Recording  | consent race, egress partial failure, stop/finalize replay, playback expiry        |
| Worker     | lease loss, retry/backoff, duplicate delivery, long recording, provider rate limit |
| Renderer   | loading/empty/error/degraded, keyboard, screen reader, 한글 IME, 작은 창           |
| Security   | cross-tenant, guest expiry, revoked member, transcript/recording presign leakage   |
| Governance | pause/withdraw, retention, cascade delete, legal hold, export audit                |
| Operations | Docker health, storage quota, queue lag, backup restore와 재삭제                   |

실제 media release gate에는 서로 다른 인증 사용자와 장치가 필요하다. mock만 통과한 상태를 다자간 회의
완료로 보고하지 않는다.

## 경쟁 제품에서 채택할 패턴

외부 제품은 UX·도메인 참고 자료이며 API·화면 호환 대상이 아니다.

| 제품            | 채택할 패턴                                                   | Pie 적용                                            |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Zoom            | 요약 template, smart chapter, highlight, next step            | M6 template·chapter·clip                            |
| Microsoft Teams | 녹화·전사·파일·agenda·task를 한 Recap에 결합                  | M5 recap, M2 WorkItem                               |
| Google Meet     | 지금까지 요약, Calendar attachment, 수신자·동의 설정          | M5 calendar, M3 consent, M6 catch-up                |
| Slack Huddles   | channel/DM thread와 canvas가 회의 후에도 유지                 | 기존 R7 chat을 M5 회의 thread로 연결                |
| Otter           | slide capture, action items, transcript Q&A                   | M2 action, M6 Q&A·presentation evidence             |
| Fireflies       | timestamped notes, topic tracker, clips, workflow integration | M1 timeline, M6 clips, M7 trends                    |
| Fathom          | meeting-type template, follow-up draft, CRM/task sync         | M2 task, M6 template·follow-up                      |
| Notion          | transcript citation, custom instruction, calendar, retention  | M1 evidence, M3 retention, M5 calendar, M6 template |

공식 참고:

- Zoom Smart Recording: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058511
- Microsoft Teams Recap: https://support.microsoft.com/en-us/teams/meetings/recap-in-microsoft-teams
- Google Meet Take Notes: https://support.google.com/meet/answer/14754931?hl=en
- Slack Huddle AI Notes: https://slack.com/help/articles/31377193680019-Use-AI-to-take-huddle-notes-in-Slack
- Otter features: https://help.otter.ai/hc/en-us/articles/360047872833-Otter-ai-features
- Fireflies summaries: https://guide.fireflies.ai/articles/9547055509-Fireflies-AI-Meeting-Summaries%3A-View%2C-Customise%2C-Expand%2C-Regenerate?lang=en
- Fathom advanced AI: https://help.fathom.video/en/articles/640768
- Notion AI Meeting Notes: https://www.notion.com/help/ai-meeting-notes

## 결정이 필요한 항목

아래 항목은 구현 중 임의로 확정하지 않는다.

1. 외부 게스트 신원: 현재 링크 생성자가 `Pie 계정 필수` 또는 `제한 guest identity`를 명시한다. 조직 기본값과 이메일 OTP 채택 여부는 별도 정책으로 결정
2. 기본 보존 기간과 지역별 녹화·전사 동의 정책
3. Google/Microsoft calendar의 자동 권위 방향과 충돌·삭제 전파. 현재는 명시적 outbound export/update만 구현하며 자동 import·삭제 전파는 하지 않음
4. transcript correction이 기존 AI summary를 자동 무효화할지 재검토 대기로 둘지
5. action item을 직접 WorkItem으로 만들지 Intake 검토를 기본으로 할지
6. 외부 회의 notetaker bot과 로컬 system-audio capture의 제품 범위
7. conversation analytics의 허용 목적, 익명화와 관리자 가시성
8. 지원 언어, 번역 provider, 데이터 처리 지역과 fallback

각 항목은 제품 정책 또는 ADR로 닫은 뒤 관련 contract를 확정한다.

## 제품 완료 정의

회의·회의록 v1은 다음을 모두 만족할 때 완료다.

- 내부·외부 참여자가 권한과 동의 정책 안에서 안정적으로 회의한다.
- 녹화·전사·요약의 상태와 실패 지점을 사용자가 이해한다.
- 요약·결정·액션 아이템이 화자·시간별 원본 근거를 가진다.
- AI 결과는 사람 승인 없이 공식 결정이나 WorkItem 상태를 변경하지 않는다.
- 승인된 후속 조치가 Project·Ticket·WorkItem에 연결되고 다음 회의까지 추적된다.
- 권한 회수, 보존 변경과 삭제가 녹화·전사·요약·검색·cache·backup에 전파된다.
- macOS, Windows, Linux와 실제 다자간 media E2E를 통과한다.
