# 보안과 관리

## 목표

하나의 Electron 앱에 개발, 고객정보, 원격조작 기능이 함께 존재하므로 사용자 역할, 실행 문맥,
원격 대상에 따라 최소 권한을 강제하고 모든 중요한 행위를 감사한다.

## 조직과 테넌트

- 조직 생성과 상태
- 부서, 팀, 사업부
- 고객사 데이터 경계
- 데이터 저장 지역
- 조직별 기능 플래그
- 라이선스와 사용 한도
- 조직 비활성화와 데이터 내보내기

## 인증

- 상세 흐름과 정책은 [회원가입·로그인과 RBAC](./01-authentication-rbac.md)를 기준으로 한다.
- 최초 조직 소유자 가입과 내부 직원·고객·협력사 초대
- 이메일 확인, 비밀번호 재설정, 계정 복구
- 이메일·비밀번호
- Passkey/WebAuthn
- OIDC와 SAML SSO
- MFA
- 기기 등록과 세션 조회
- 복구 코드
- 로그인 위험 탐지
- 세션 만료와 강제 로그아웃
- 서비스 계정과 API 키

## 권한

- 기본 거부와 모든 요청의 permission 검증
- 역할 기반 기본 권한
- 고객·프로젝트·자산별 권한
- 기간 제한 접근
- 협력사와 게스트 제한
- 승인자와 실행자 분리
- 보기, 수정, 승인, 내보내기, 원격조작 분리
- AgentSession 목록, raw turn, tool output, Artifact, 고객 제출 권한 분리
- MCP read, additive write, 상태 변경, 원격 실행 scope 분리
- 서버와 Runtime에서 재검증
- 역할·grant 변경 시 권한 캐시 즉시 무효화

## 라이선스와 Entitlement

RBAC는 사용자가 허용된 기능을 판단하고, entitlement는 조직이 구매·활성화한 기능과 사용 한도를
판단한다. `isAdmin`이나 역할에 요금제 조건을 섞지 않는다.

- 제품 plan과 버전이 있는 entitlement 목록
- 좌석, 저장공간, AI 사용량, 동시 원격 세션, 녹화 시간 한도
- cloud, on-premises, 평가판과 계약 기간
- 사용량 meter와 중복 집계 방지
- 한도 임박 알림, grace period, 초과 정책
- 계약 종료 시 읽기·내보내기 유예와 신규 쓰기 제한
- entitlement 변경과 운영자 override 감사

기능 접근은 `조직 entitlement → 사용자 permission → resource grant → 실행 조건` 순서로 확인한다.
entitlement 부족과 권한 거부는 사용자 메시지와 감사 코드에서 구분한다.

## Electron 보안 경계

- Renderer는 sandbox와 context isolation을 유지한다.
- preload는 감사 가능한 타입 계약만 노출한다.
- 원격 페이지는 privileged preload를 상속하지 않는다.
- 내장 브라우저 세션과 앱 세션을 분리한다.
- IPC 요청은 sender, 역할, 리소스 범위, 파라미터를 검증한다.
- 파일 경로는 실행 호스트에서 정규화하고 허용 범위를 검사한다.
- 임의 셸 실행 대신 목적별 명령과 정책을 제공한다.
- 로컬 MCP는 기본적으로 child-process `stdio`를 사용하고 사용자 token을 agent process에 노출하지 않는다.
- remote MCP는 Origin, issuer, tenant, resource·audience와 scope를 검증하고 token passthrough를 금지한다.

## 비밀과 암호화

- OS 보안 저장소에 토큰과 키 저장
- 전송 구간 TLS
- 원격 Runtime E2EE 채널
- 데이터베이스와 백업 암호화
- 고객별 비밀 참조
- 로그와 AI 입력의 비밀값 마스킹
- 프로젝트 deny path, structured field policy와 server ingest 재검사
- 키 회전과 토큰 폐기

## 감사 이벤트

- 로그인과 인증 실패
- 사용자·역할·권한 변경
- 고객·계약·재무 데이터 조회와 내보내기
- 원격 세션 요청, 동의, 참여, 권한 변경, 종료
- 터미널 명령, 파일 전송, Runbook 실행
- Git Push, PR, 배포, 롤백
- 고객 승인과 검수
- 자동화와 AI 도구 실행
- AI capture mode·pause 변경, SessionBinding 생성·수정과 미할당 세션 재분류
- raw transcript 열람·검색·공유·고객 제출·내보내기
- 보존정책 변경과 감사 로그 조회

감사 이벤트는 행위자, 조직, 고객, 리소스, 시각, 실행 호스트, 결과, 상관관계 ID를 가진다.
수정·삭제 대신 보정 이벤트를 추가한다.

## 데이터 보존

- 메시지
- 첨부파일
- 원격 터미널 기록
- 화면 녹화
- 회의 녹화와 전사
- AI 입력과 출력
- tool output, transcript chunk, AI summary와 embedding
- 감사 로그
- 프로젝트 산출물

조직과 고객 계약에 따라 보존 기간을 설정한다. 법적 보존과 사용자 삭제 요청이 충돌하는 경우
정책 근거와 처리 상태를 기록한다.

원문, 요약, embedding, 검색 색인은 서로 다른 보존 대상이지만 삭제 lineage를 공유한다. 관리자도
raw transcript를 기본 열람할 수 없으며 break-glass 열람은 추가 인증, 사유, 제한 시간과 감사를
요구한다.

## 관리자 기능

- 사용자·팀·역할
- 워크플로와 상태
- 사용자 정의 필드
- 프로젝트·티켓·문서 템플릿
- SLA, 업무시간, 공휴일
- 원격지원 정책
- AI 모델과 도구 정책
- 파일·내보내기 정책
- 통합과 Webhook
- 감사, 백업, 복원
- 시스템 상태와 작업 큐

## 운영과 공급망

- 상세 운영 기준은 [Control Plane 운영](./17-control-plane-operations.md)을 따른다.
- Electron 배포 보안은 [데스크톱 배포와 수명주기](./16-desktop-lifecycle.md)를 따른다.
- 데이터 삭제·검색·연동 정책은 [데이터 거버넌스와 연동](./18-data-governance-integrations.md)을 따른다.
- 위협 모델, SBOM, 의존성·비밀 검사, 서명된 산출물을 릴리스 증빙으로 보존한다.
- 백업 성공뿐 아니라 격리된 환경의 복원 결과를 정기 검증한다.

## P0 완료 기준

역할과 리소스 범위가 Renderer, Electron Main, Runtime, 서버에서 일관되게 강제되고, 고객 데이터
조회와 원격조작을 포함한 중요 행위가 변조하기 어려운 감사 이벤트로 기록되어야 한다.
entitlement와 permission이 분리되고, 취약한 빌드·업데이트·운영자 접근이 릴리스 게이트에서
차단되어야 한다.
