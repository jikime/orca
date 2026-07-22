# 데이터 거버넌스와 연동

## 목표

Pie가 고객정보, 소스코드 문맥, 원격지원 기록, 녹화, 재무 데이터를 함께 다루는 만큼 수집부터
삭제까지의 책임을 정의한다. 검색과 외부 연동이 기존 권한 경계를 우회하지 않도록 동일한 테넌트와
리소스 정책을 적용한다.

## 데이터 분류와 소유권

| 등급      | 예시                                 | 기본 통제                         |
| --------- | ------------------------------------ | --------------------------------- |
| 공개      | 공개 지식문서, 배포 공지             | 무결성, 게시 승인                 |
| 내부      | 내부 공지, 일반 프로젝트 상태        | 조직 Membership                   |
| 고객 기밀 | 티켓, 계약, 산출물, 원격 기록        | 고객·프로젝트 범위, 내보내기 감사 |
| 제한      | 비밀, 소스 일부, 자격증명, 재무 원가 | 추가 인증, 최소 인원, 강한 마스킹 |

- 각 엔터티와 Object Storage 객체에 `organizationId`, 분류, 소유자, 보존정책을 둔다.
- 내부 분류와 고객 공개 여부를 하나의 UI 플래그로만 구분하지 않는다.
- 외부 시스템에서 가져온 데이터도 Pie 분류와 권한을 다시 부여한다.
- 데이터 책임자와 처리 목적, 저장 지역을 조직 정책으로 관리한다.

## 데이터 수명주기

1. 수집 전에 필수·선택 필드와 목적을 구분한다.
2. 저장 시 테넌트, 분류, 보존정책, 암호화 키를 연결한다.
3. 조회·검색·내보내기 시 유효 권한과 리소스 범위를 검증한다.
4. 보존기간 종료 시 삭제, 익명화, 법적 보존 중 하나를 결정한다.
5. 삭제 결과를 원본 DB, 검색, 캐시, Object Storage, 백업 정책에 반영한다.

- 계정 삭제와 조직 탈퇴가 감사·계약 증빙까지 무조건 지우지 않도록 익명화 규칙을 둔다.
- 법적 보존은 대상, 근거, 승인자, 시작·종료 시각을 기록한다.
- 테넌트 종료 시 기계 판독 가능한 내보내기와 삭제 증명을 제공한다.
- 백업의 만료와 복원 후 재삭제 절차를 데이터 삭제 정책에 포함한다.

## AI 작업 기록

AI 작업 기록은 prompt와 response만이 아니라 tool input·output, transcript, 변경 파일, terminal 명령,
commit, test, 문서와 검색용 파생 데이터까지 포함한다.

- 프로젝트별 capture mode를 `off`, `metadata-only`, `selected`, `full`로 구분한다.
- 조직 관리자는 목적과 기본값을 정하고 사용자는 Workspace에서 기록 상태와 동기화 대상을 확인한다.
- 사용자가 기록을 일시 정지하더라도 이미 저장된 감사 이벤트를 조용히 삭제하지 않는다.
- AgentSession 전체와 turn·tool output·Artifact의 classification과 visibility를 별도로 판정한다.
- Hook 실시간 정보, transcript 원문, AI 요약, embedding은 서로 다른 source·보존정책을 가진다.
- `.env`, credential 경로, secret pattern과 조직 deny path는 upload 전에 로컬에서 제거한다.
- client redaction만 신뢰하지 않고 server ingest와 외부 반출 전에 다시 검사한다.
- 고객 공개는 session 공유가 아니라 검토된 turn·Artifact·Evidence의 명시적 제출로 처리한다.
- source code와 고객 데이터의 model provider 전송 허용 범위, 지역, 학습 사용 여부를 프로젝트 정책으로
  관리한다.
- 관리자 raw transcript 열람은 최소 권한, 추가 인증, 사유, 유효 시간과 감사 이벤트를 요구한다.
- 직원 활동 기록의 처리 목적, 열람자, 보존기간과 조직 정책을 사용자에게 고지한다.

raw transcript 삭제는 PostgreSQL metadata, Object Storage chunk, summary, embedding, 전문·벡터 색인,
cache, export와 backup restore 후 재삭제까지 추적한다. 법적 보존과 감사 의무가 있는 경우 원문 유지와
익명화 범위를 별도로 결정한다.

## 암호화와 키

- 전송 구간 TLS와 저장 데이터 암호화
- 환경별 KMS와 키 접근 역할 분리
- 테넌트 또는 데이터 등급별 키 분리 범위 결정
- 키 버전, 회전, 폐기, 복구 이력
- 앱 토큰·SSH 키·고객 비밀은 일반 업무 데이터와 다른 저장소 사용
- 로그, trace, AI 입력, 검색 색인에 비밀값이 들어가지 않도록 수집 전 마스킹
- tenant와 encryption domain을 넘는 transcript·Artifact content dedup 금지

## 파일과 녹화

- 업로드 전에 크기, 확장자, MIME, 해시 검사
- 악성코드 검사 완료 전 격리 bucket에 저장
- 검사 실패·미지원·시간 초과 상태를 구분
- 다운로드와 외부 반출에 권한, 추가 인증, 워터마크 정책 적용
- 녹화·전사·화면 캡처의 동의와 보존정책 연결
- 저장공간·파일 크기·녹화 시간 quota
- 중복 객체 제거가 테넌트 암호화와 삭제 격리를 깨지 않도록 설계

## 권한 인식 검색

전문 검색과 의미 기반 검색은 원본 데이터와 같은 권한 모델을 사용한다.

- 색인 문서에 조직, 고객, 프로젝트, visibility, 정책 버전 포함
- 검색 시 서버가 허용 scope를 생성하고 색인과 원본 조회에서 모두 검증
- Membership·Role·ResourceGrant 변경 시 관련 검색 권한 즉시 무효화
- 삭제·보존 변경 이벤트로 전문·벡터 색인과 캐시 정리
- 제한 데이터의 embedding 생성 허용 모델과 저장 지역 통제
- 검색 결과 snippet에서 비밀과 내부 메모 노출 방지
- 색인 지연 중에는 오래된 권한으로 결과를 반환하지 않는 안전한 실패

## 공개 API

- 버전이 있는 REST 또는 명시적 RPC 계약
- 사용자 위임 OAuth와 ServicePrincipal 자격증명 분리
- API 자격증명 scope, 만료, IP·네트워크 조건, 회전
- pagination, rate limit, 멱등 키, 오류 코드, correlation ID
- 테넌트·리소스 권한을 UI와 동일하게 적용
- 대량 조회·내보내기와 관리자 API 감사
- API 버전 폐기 일정과 사용량 기반 통지

## Webhook

- 조직별 endpoint와 구독 이벤트 allowlist
- 서명, timestamp, replay 방지
- event ID와 버전, 최소 데이터 payload
- 지수 재시도, dead-letter, 수동 재전송
- 수신 측 중복 처리를 고려한 동일 event ID 유지
- endpoint 비활성화, 비밀 회전, 전달 이력
- 내부 메모와 제한 필드의 외부 전송 차단

## 가져오기와 마이그레이션

대상은 Jira, Redmine, 기존 CRM·ERP, CSV·Excel, 문서 저장소를 우선 고려한다.

1. 원본 연결과 읽기 전용 진단을 수행한다.
2. 사용자, 고객, 프로젝트, 상태, 필드 mapping을 미리보기 한다.
3. dry-run으로 생성·갱신·충돌·누락 건수를 계산한다.
4. 작은 batch로 가져오고 원본 ID와 import job을 기록한다.
5. 합계, 첨부, 관계, 권한을 원본과 대조한다.
6. 재실행은 중복 생성하지 않고 실패 항목만 복구한다.

원본의 사용자 ID를 이메일만으로 자동 병합하지 않는다. 고객사와 프로젝트 경계를 관리자가
확인하고, 원본 시스템의 삭제가 Pie 데이터를 자동 삭제할지는 별도 정책으로 둔다.

## 업무 연동

- 이메일 수신으로 티켓 생성과 원문 보존
- Microsoft 365·Google Workspace 일정과 회의 동기화
- Slack·Teams 알림과 승인 딥링크
- GitHub·GitLab·기타 Git 공급자의 저장소·검토·배포 이벤트
- 전자서명, 회계·ERP, 인사·원가 시스템
- SSO·SCIM 디렉터리
- 모니터링·경보 시스템

연동마다 동기화 방향, 권위 시스템, 충돌 정책, 삭제 전파, rate limit, 장애 시 재처리를 문서화한다.

### 회의 캘린더 adapter 운영 계약

M5의 Google Workspace·Microsoft 365 adapter는 다음 경계로 동작한다.

- 방향: 사용자가 회의 화면에서 실행하는 Pie → calendar outbound export/update
- 권위: Pie meeting이 현재 export 요청의 source이고, 반복 실행은 저장된 provider event를 갱신한다.
- 충돌: 자동 병합하지 않는다. 외부에서 바뀐 event를 import하거나 Pie meeting에 덮어쓰지 않는다.
- 삭제: 회의 취소·삭제를 외부 calendar에 자동 전파하지 않는다. 반대 방향 삭제도 수신하지 않는다.
- 실패: meeting transaction과 분리해 `pending | synced | failed`로 기록하며 provider 오류는 meeting 생성·조회·진행을 막지 않는다.
- 인증 정보: access token은 server environment에서 adapter에 주입하고 DB·응답·로그에 저장하지 않는다. 사용자별 OAuth 연결과 refresh token vault는 운영 배포의 별도 인증 vertical이다.
- 시간: Pie는 UTC occurrence와 IANA time zone을 함께 보존한다. Google에는 RFC3339 + IANA zone, Microsoft에는 같은 zone의 local wall-clock을 전달한다.
- 참석자: meeting participant의 검증된 account email만 provider attendee로 export한다. guest link bearer나 guest session token은 calendar provider로 보내지 않는다.

자동 양방향 sync, provider webhook, 충돌 해결과 삭제 전파를 켜려면 권위·재시도·rate limit·회수 정책을 ADR로 먼저 닫아야 한다.

## 완료 기준

- 역할 회수와 데이터 삭제가 검색, 캐시, Webhook에 정해진 시간 안에 반영된다.
- 악성코드 검사가 끝나지 않은 첨부와 권한 없는 녹화를 다운로드할 수 없다.
- 테넌트 내보내기와 삭제·익명화 결과를 감사 이벤트로 재현할 수 있다.
- API와 Webhook의 재시도·중복·순서 변경이 업무 데이터를 중복 생성하지 않는다.
- 외부 시스템 import를 dry-run하고 실패 후 중복 없이 재실행할 수 있다.
- 외부 연동 장애가 Control Plane의 사용자 요청과 작업 큐를 고갈시키지 않는다.
- AI capture mode 변경과 기록 일시 정지가 새 event 수집에 즉시 반영된다.
- 내부 prompt와 제한 tool output 없이 검토된 Artifact만 고객에게 제출할 수 있다.
- transcript 삭제가 summary, embedding, 검색, cache와 backup restore 후 재삭제까지 전파된다.
