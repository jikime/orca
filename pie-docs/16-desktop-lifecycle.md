# 데스크톱 배포와 수명주기

## 목표

Pie Electron 앱의 설치, 최초 실행, Orca 데이터 전환, 인증 진입, 업데이트, 서버 호환, 장애 진단을
하나의 제품 수명주기로 관리한다. 별도 업무용 웹 프론트엔드는 만들지 않지만 데스크톱 앱이
설치되지 않았거나 실행할 수 없는 상황을 위한 최소 공개 웹 표면은 제공한다.

## 웹 프론트엔드 경계

브라우저에서 고객·프로젝트·티켓 업무 기능을 제공하지 않는다. 인증 credential flow는 Keycloak이,
Pie 초대와 설치 연결은 Control Plane이 담당하며 다음 항목만 공개 HTTPS 표면으로 제공한다.

- 이메일 확인 결과와 앱 열기
- 비밀번호 재설정 요청 결과와 앱 열기
- 초대 유효성 확인, 앱 열기, 설치본 받기
- OIDC·SAML 로그인 진행과 callback 실패 안내
- 운영체제별 설치본과 최소 지원 버전 안내
- 서비스 상태, 개인정보 처리방침, 이용약관

공개 페이지는 업무 데이터나 장기 세션을 보관하지 않는다. 토큰 원문을 분석 도구와 접근 로그에
남기지 않고, 일회성 처리 후 주소에서 제거한다. 브라우저에서 완료할 수 있는 작업과 반드시 앱에서
완료할 작업을 명확히 구분한다. 인증 경계는
[`ADR-0009`](../docs/adr/0009-identity-provider-and-application-authorization.md)을 따른다.

## Orca에서 Pie로 전환

기존 사용자의 로컬 Workspace와 설정을 잃지 않는 것이 첫 로그인보다 우선한다.

1. 기존 데이터 디렉터리와 설정 버전을 감지하고 읽기 전용 스냅샷을 만든다.
2. Pie 계정 로그인 전 로컬 Workspace를 계속 열 수 있는 제한 모드를 제공한다.
3. 사용자가 조직을 선택한 뒤 로컬 Workspace를 조직·프로젝트에 연결할지 개별 확인한다.
4. 서버로 동기화할 메타데이터와 장비에만 남길 경로·셸 이력·비밀을 구분한다.
5. 성공한 마이그레이션 버전과 항목별 결과를 기록한다.
6. 실패하면 이전 데이터로 되돌리고 진단 번들을 생성한다.

SSH 키, Git 자격증명, 로컬 환경변수, 터미널 이력은 기본적으로 업로드하지 않는다. 중앙 서버에는
호스트가 해석할 수 있는 `pathRef`와 사용자가 승인한 업무 연결만 저장한다. 마이그레이션은 여러 번
실행해도 같은 결과가 나와야 한다.

## 계정과 로컬 프로필

- 하나의 설치본에서 여러 조직을 전환할 수 있다.
- 동시에 활성화되는 보안 문맥은 하나의 사용자·조직·기기 세션으로 제한한다.
- 조직 전환 시 창, Runtime 요청, Realtime 구독, 검색 캐시를 새 문맥으로 다시 연다.
- 로그아웃하면 Main의 토큰과 해당 조직의 민감 캐시를 폐기한다.
- 공용 PC 모드는 앱 종료 시 계정 캐시와 다운로드 파일을 제거한다.
- 기기 분실 시 서버에서 세션과 해당 기기의 capability 발급을 폐기할 수 있다.

## 프로토콜 호환성

Electron 앱, Control Plane, Realtime Gateway, Pie Runtime, Relay, Edge Agent는 서로 다른 시점에
업데이트될 수 있다. 각 연결은 버전 문자열만 비교하지 않고 지원 capability를 교환한다.

| 연결 | 협상 항목 |
|---|---|
| App ↔ Control Plane | API 세대, 인증 방식, 기능 플래그, 최소 앱 버전 |
| App ↔ Realtime | 이벤트 스키마, 재동기화 방식, 압축, heartbeat |
| Main ↔ Runtime | 명령 버전, 실행 호스트, 스트리밍, 취소와 복구 |
| App ↔ Relay | room, participant, capability, backpressure |
| Control Plane ↔ Edge Agent | 에이전트 버전, 플랫폼 기능, 인증서, 업데이트 정책 |

- 알 수 없는 응답 필드는 무시하고 필수 필드 누락은 명시적 오류로 처리한다.
- 파괴적 스키마 변경은 새 버전을 추가한 뒤 구버전 사용량이 없어질 때 제거한다.
- 서버는 최소 지원 앱·Agent 버전과 지원 종료일을 반환한다.
- 보안상 강제 업데이트가 필요하면 진행 중 작업을 보존한 뒤 제한 모드로 전환한다.
- 오프라인 Agent는 재연결 후 순차 업그레이드와 데이터 재동기화를 수행한다.

## 업데이트와 릴리스

- macOS 코드 서명과 notarization, Windows 코드 서명, Linux 패키지 서명
- 서명된 업데이트 manifest와 패키지 무결성 검증
- stable, preview, 내부 검증 채널 분리
- 조직 단위 단계적 배포와 자동 업데이트 시간대
- 업데이트 전 로컬 DB 마이그레이션 점검과 백업
- 시작 실패와 crash 증가 시 이전 버전 복구
- 강제 보안 업데이트와 일반 기능 업데이트 정책 분리
- 릴리스별 서버·Runtime·Relay 호환 행렬 게시

업데이트 완료를 다운로드 성공으로 판단하지 않는다. 새 버전이 시작되고 로컬 DB와 Runtime 연결,
Control Plane handshake까지 성공해야 배포가 완료된 것으로 본다.

## Electron 보안 기준

- 모든 Renderer의 sandbox와 context isolation 유지
- 원격 콘텐츠의 Node.js integration 금지
- 좁고 타입이 있는 preload API만 노출
- CSP, 탐색, 새 창, 외부 URL, 권한 요청 allowlist
- 모든 IPC의 sender와 입력 스키마 검증
- 사용자 입력을 그대로 `shell.openExternal`에 전달하지 않음
- 사용하지 않는 Electron Fuses 비활성화
- ASAR integrity와 패키지 서명 검증
- Electron·Chromium·Node와 주요 의존성의 보안 업데이트 추적
- SBOM, 의존성·비밀 스캔, 취약점 접수·수정 정책

세부 체크리스트는 [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)와
[Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)를 기준으로 자동 검증한다.

## 엔터프라이즈 배포

SaaS, Local Docker와 On-prem profile, `/.well-known/pie`, custom CA와 instance state 격리는
[SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md)을 따른다.

- 사용자 설치와 장비 관리자 배포 패키지 분리
- Windows MSI, macOS PKG, Linux AppImage·deb·rpm 지원 범위 결정
- 프록시, PAC, 방화벽, 사설 DNS, 조직 신뢰 CA 설정
- 오프라인·폐쇄망 설치본과 업데이트 저장소
- 온프레미스 Control Plane 주소와 인증서 bootstrap
- 조직 정책으로 업데이트 채널, 진단 전송, 로컬 데이터 위치 제어

사설 CA를 허용하더라도 TLS 검증을 끄는 옵션은 제공하지 않는다. 조직이 설치한 신뢰 저장소와
명시적 인증서 설정을 사용한다.

## 진단과 복구

- Main, Renderer, Runtime, Relay 연결 상태를 한 화면에서 확인
- 사용자가 검토하고 생성하는 민감정보 제거 진단 번들
- crash report와 사용량 telemetry의 조직 정책·사용자 동의
- 네트워크, 프록시, 인증서, 시스템 키링, 미디어 장치 진단
- 손상된 로컬 캐시를 격리하고 서버에서 재동기화
- 플러그인·Agent·Runtime 없이 시작하는 안전 모드

진단 번들에는 원본 토큰, 비밀, 터미널 전체 출력, 고객 파일 본문을 기본 포함하지 않는다.

## 접근성과 국제화

- 키보드만으로 내비게이션, 명령 실행, 모달 종료 가능
- 스크린리더 이름, 역할, 상태, 오류 연결
- 고대비 모드, 확대, 동작 감소, 자막과 회의 전사
- 한글 IME와 조합 중 단축키 충돌 검증
- 언어, 날짜, 숫자, 통화, 시간대와 업무 달력 분리
- RTL 언어를 제외하더라도 레이아웃이 번역 길이에 견디도록 설계

접근성 검증 기준은 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)를 사용하고 Electron 고유의
키보드·메뉴·창 동작을 추가로 시험한다.

## 완료 기준

- 앱 미설치 사용자가 이메일 링크에서 설치 후 원래 가입·초대 흐름으로 복귀한다.
- 기존 Orca 프로필을 손실 없이 Pie 로컬 프로필로 전환하고 실패 시 복구한다.
- 지원 범위 안의 구버전 앱·Runtime·Relay가 신버전 서버와 capability를 협상한다.
- 서명 검증 실패 패키지와 허용되지 않은 Renderer 탐색·IPC가 차단된다.
- 업데이트 실패 후 이전 실행 가능 버전 또는 안전 모드로 진입한다.
- Windows, macOS, Linux에서 키보드와 스크린리더 핵심 흐름을 검증한다.
