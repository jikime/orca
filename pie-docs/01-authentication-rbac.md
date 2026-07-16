# 회원가입·로그인과 RBAC

## 목표

Pie의 내부 직원, 고객, 협력사, 게스트가 같은 Electron 설치본을 사용하므로 인증과 권한은
다른 업무 기능보다 먼저 구현한다. 사용자가 누구인지 확인하는 인증과 사용자가 무엇을 할 수
있는지 판정하는 인가를 분리하고, 조직과 리소스 경계를 모든 요청에서 다시 확인한다.

## 인증 아키텍처

- 기본 Identity Provider는 Keycloak이다.
- 하나의 Pie instance는 기본적으로 하나의 realm을 사용하며 organization마다 realm을 만들지 않는다.
- Keycloak은 credential, 이메일 확인, 비밀번호 복구, MFA, Passkey와 외부 OIDC·SAML broker를 소유한다.
- Pie는 issuer + subject 계정 매핑, Organization, Membership, Role, Permission, ResourceGrant와
  entitlement를 소유한다.
- Keycloak group·role과 email만으로 Pie resource 권한을 부여하지 않는다.
- SaaS와 Self-hosted는 같은 OIDC adapter와 시스템 브라우저 PKCE 흐름을 사용한다.

상세 경계는 [`ADR-0009`](../docs/adr/0009-identity-provider-and-application-authorization.md)와
[Reference Architecture v1](./32-reference-architecture-v1.md)을 따른다.

## 우선순위

### P0

- 최초 조직 소유자 회원가입과 이메일 확인
- 이메일·비밀번호 로그인, 로그아웃, 비밀번호 재설정
- 내부 직원·고객·협력사 초대와 초대 수락
- MFA, 복구 코드, 중요 작업의 추가 인증
- 기기·세션 조회, 개별 세션 폐기, 전체 로그아웃
- 기본 역할, 사용자 정의 역할, 리소스 범위 권한
- Renderer, Main, Runtime, Control Plane, Relay의 권한 재검증
- 인증·권한 변경 감사 이벤트

### P1

- Passkey/WebAuthn 로그인
- OIDC 기업 SSO와 조직별 로그인 정책
- 조직 이메일 도메인 확인과 계정 연결 정책
- 접근권한 요청·승인·기간 만료
- 정기 접근권한 검토
- 유효 권한 미리보기와 권한 변경 시뮬레이션

### P2

- SAML SSO와 SCIM 사용자 프로비저닝
- 위험 기반 추가 인증과 비정상 로그인 탐지
- 서비스 계정, API 자격증명, 세분화된 키 회전 정책

## 계정 등록 방식

| 대상 | 등록 방식 | 기본 범위 |
|---|---|---|
| 최초 조직 소유자 | 공개 가입 또는 관리자가 발급한 개설 코드 | 새 조직의 소유자 |
| 내부 직원 | 조직 소유자·관리자의 이메일 초대 | 조직과 배정된 팀·업무 |
| 고객 사용자 | 고객 관리자나 내부 담당자의 이메일 초대 | 지정 고객사와 허용 리소스 |
| 협력사 | 프로젝트 관리자의 기간 제한 초대 | 배정 프로젝트·업무·저장소 |
| 게스트 | 원격지원 세션의 일회성 초대 | 단일 세션과 허용된 기능 |

운영 환경에서는 조직별로 공개 가입 허용 여부를 설정한다. 공개 가입을 허용하더라도 기존 조직에
임의로 참여할 수 없고 새 조직만 생성할 수 있다. 고객 사용자와 협력사는 스스로 고객사나
프로젝트를 선택하지 않으며 반드시 초대에 포함된 범위를 사용한다.

앱이 설치되지 않은 사용자의 이메일 확인과 초대 복구는
[데스크톱 배포와 수명주기](./16-desktop-lifecycle.md)의 최소 공개 HTTPS 표면을 사용한다.

## 최초 회원가입 흐름

1. Electron Main이 시스템 브라우저에서 Keycloak 등록 흐름을 연다.
2. 사용자가 이메일·비밀번호 또는 허용된 Passkey 흐름으로 identity를 등록한다.
3. Keycloak이 계정 존재를 과도하게 노출하지 않는 응답과 일회성 이메일 확인을 처리한다.
4. Main이 OIDC callback의 issuer·subject를 검증하고 Control Plane provisioning을 요청한다.
5. Control Plane은 `UserAccount` mapping, `Organization`, 소유자 `Membership`, 감사와 outbox를 하나의
   Pie 트랜잭션으로 생성한다.
6. 소유자는 Keycloak에서 MFA와 복구 수단을 등록한다.
7. Pie에서 조직명, 데이터 지역, 기본 보안 정책을 설정하고 앱으로 진입한다.

마지막 조직 소유자는 탈퇴하거나 소유자 역할을 스스로 제거할 수 없다. 소유권 이전 또는 조직
폐쇄 절차를 먼저 완료해야 한다.

## 초대와 수락

초대에는 조직, 사용자 유형, 이메일, 고객사·프로젝트 범위, 역할 템플릿, 만료 시각을 포함한다.
원본 토큰은 이메일이나 딥링크에 한 번만 전달하고 서버에는 해시만 저장한다.

1. 관리자가 초대를 생성한다.
2. 사용자는 `pie://invite/<token>` 또는 시스템 브라우저 링크를 연다.
3. 서버는 토큰 해시, 만료, 사용 여부, 대상 이메일과 조직 상태를 확인한다.
4. 기존 사용자는 로그인하고 신규 사용자는 이메일 확인과 인증수단 등록을 완료한다.
5. 서버는 초대에 고정된 역할과 리소스 범위로 `Membership`을 생성한다.
6. 초대를 단일 사용 처리하고 생성자·수락자·부여 권한을 감사 이벤트로 남긴다.

관리자는 수락 전 초대를 취소할 수 있다. 초대의 이메일이나 범위를 바꿔 재사용하지 않고 기존
초대를 폐기한 뒤 새 초대를 발급한다.

## 로그인과 계정 복구

### 기본 인증

- 이메일·비밀번호
- Passkey/WebAuthn
- 조직에서 허용한 OIDC 또는 SAML SSO
- TOTP 기반 MFA와 일회용 복구 코드

비밀번호 hash와 credential policy는 Keycloak이 소유하며 Pie database에는 비밀번호를 저장하지 않는다.
알려진 유출 비밀번호를 차단하고 임의의 문자 조합 규칙이나 주기적 변경을 강제하지 않는다. 로그인,
가입, 재설정 응답은 계정 존재 여부를 쉽게 추측할 수 없도록 구성하고 반복 요청은 속도 제한한다.

### 복구

- 비밀번호 재설정 링크는 짧게 만료되고 한 번만 사용할 수 있다.
- 복구 코드는 각 코드를 해시해 저장하며 사용 즉시 폐기한다.
- MFA 초기화는 기존 인증수단, 복구 코드 또는 관리자 승인과 대기시간을 요구한다.
- 이메일, MFA, SSO 연결 변경 후 기존 세션을 검토하고 필요하면 전체 폐기한다.

## 계정 생명주기

- 이메일 변경은 기존 인증수단의 추가 인증과 새 이메일 확인을 모두 요구한다.
- 동일 이메일이나 SSO subject를 근거로 계정을 자동 병합하지 않는다.
- 조직 도메인 소유권은 DNS 또는 관리 이메일로 확인하고 기존 계정 편입은 별도 승인을 받는다.
- 퇴사·계약 종료·SCIM 비활성화 시 Membership, 세션, resource grant, API 키를 함께 폐기한다.
- 조직 탈퇴 후에도 감사·계약 증빙의 행위자 참조는 익명화 정책에 따라 보존한다.
- 관리자와 고위험 역할은 정기적으로 유효 권한을 검토하고 재승인한다.
- IdP 장애 시 사용할 break-glass 계정은 일상 로그인과 분리하고 사용 즉시 경보한다.
- 마지막 조직 소유자와 마지막 break-glass 관리자는 자동 비활성화하지 않는다.

SCIM 동기화는 create와 update뿐 아니라 disable, group 변경, 재활성화의 멱등성을 검증한다.
표준 계약은 [RFC 7644](https://www.rfc-editor.org/info/rfc7644/)를 따른다.

## Electron 인증 흐름

### 공통 OIDC Native App 흐름

1. Main이 PKCE verifier와 challenge, `state`, `nonce`를 생성한다.
2. Electron 내부 WebView가 아니라 기본 시스템 브라우저에서 Keycloak 인증 페이지를 연다.
3. 임의 포트의 loopback callback을 우선 사용하고, 불가능하면 등록된 `pie://auth/callback`을 쓴다.
4. Main이 callback의 `state`, 발급자, 대상, `nonce`를 검증한 후 authorization code를 교환한다.
5. Control Plane이 issuer·subject와 Pie account·Membership을 연결하고 현재 permission을 계산한다.
6. callback listener와 임시 값을 즉시 폐기하고 Renderer에는 인증 결과만 전달한다.

외부 인증 제공자의 페이지에 Pie의 privileged preload를 연결하지 않는다. 사용자 브라우저를
사용하는 네이티브 앱 OAuth 흐름과 Authorization Code + PKCE를 기본으로 한다. 이메일·비밀번호,
Passkey와 외부 기업 SSO 중 어떤 수단을 선택하더라도 Electron 관점에서는 같은 OIDC 흐름이다.

로그인 성공 후 짧은 수명의 access token은 Main 메모리에만 유지하고 회전되는 refresh token은 Main이
OS 보안 저장소에 보관한다. Renderer에는 원본 token 대신 session state와 유효 permission만 전달한다.
Linux에서 안전한 시스템 keyring을 사용할 수 없으면 평문 저장으로 자동 강등하지 않고 로그인 유지
기능을 제한한다.

## 세션과 토큰

| 항목 | 원칙 |
|---|---|
| Access token | 짧은 수명, Main 메모리 보관, 조직·대상·scope 검증 |
| Refresh token | 매번 회전, OS 보안 저장소 보관, 재사용 탐지 시 token family 폐기 |
| 기기 세션 | 기기명, 플랫폼, 생성·최근 사용 시각, 위치 요약, 폐기 상태 표시 |
| 게스트 토큰 | 단일 원격 세션과 capability에 한정, 짧은 만료, 재사용 제한 |
| Runtime capability | 사용자 토큰을 전달하지 않고 작업·호스트·리소스가 제한된 서명 토큰 사용 |

사용자는 현재 기기를 제외한 세션 폐기, 특정 기기 로그아웃, 전체 로그아웃을 수행할 수 있다.
비밀번호·MFA·소유자 변경이나 refresh token 재사용 탐지는 정책에 따라 전체 세션을 폐기한다.
오프라인에서는 이미 동기화한 비민감 읽기 데이터만 허용하고 쓰기, 승인, 원격조작, 권한 변경은
온라인 세션 검증을 요구한다.

## RBAC 모델

```text
User
└── Membership (Organization)
    ├── Role ── RolePermission ── Permission
    ├── ProjectMembership and ProjectOrganizationRelation
    └── ResourceGrant
        └── Customer, Project, WorkItem, AgentSession, Artifact, Repository, Asset, Ticket, RemoteSession
```

역할은 업무별 기본 권한 묶음이고 `ResourceGrant`는 해당 역할을 사용할 수 있는 실제 범위를
제한하거나 예외적으로 확장한다. 역할 이름만 확인하지 않고 permission과 리소스 범위를 함께
판정한다. 모든 정책은 기본 거부이며 명시적 거부가 허용보다 우선한다.

조직 역할과 프로젝트 역할을 분리한다. 프로젝트의 소유 조직, 고객사, 수행사, 협력사 관계를 먼저
확인한 뒤 해당 프로젝트의 PM·PL·개발자·검토자 역할과 WorkItem 참여자 권한을 판정한다.

### Permission 이름

Permission은 `resource.action` 형식을 사용한다.

| 영역 | 예시 |
|---|---|
| 조직 | `organization.read`, `member.invite`, `role.manage` |
| 고객 | `customer.read`, `customer.update`, `contract.read` |
| 프로젝트 | `project.read`, `project.manage`, `change.approve` |
| 업무 | `work_item.read`, `work_item.update`, `work_item.assign`, `work_item.approve` |
| 개발 | `workspace.open`, `workspace.execute`, `repository.push` |
| AI 기록 | `agent_session.read`, `agent_turn.read_raw`, `artifact.publish`, `agent_capture.manage` |
| MCP | `mcp.project.read`, `mcp.work_item.write`, `mcp.remote.execute` |
| 서비스 | `ticket.read`, `ticket.respond`, `ticket.internal-note` |
| 원격지원 | `remote.request`, `remote.view`, `remote.control`, `remote.file-transfer` |
| 재무 | `finance.read`, `finance.export`, `billing.approve` |
| 관리 | `audit.read`, `policy.manage`, `session.revoke` |

화면 단위 권한보다 업무 행위 단위 권한을 사용한다. 예를 들어 티켓 조회와 내부 메모 조회,
원격 화면 보기와 조작, 보고서 조회와 원가 필드 조회를 서로 다른 permission으로 둔다.

### 기본 역할 템플릿

기본 역할은 [역할과 내비게이션](./01-roles-and-navigation.md)의 역할 정의를 따른다. 조직은
템플릿을 복제해 사용자 정의 역할을 만들 수 있지만 시스템 permission 자체를 재정의할 수 없다.
초기 버전에서는 복잡한 역할 상속을 지원하지 않고 역할에 permission을 직접 연결한다.

- 조직 소유자: 결제·소유권 이전을 포함한 최상위 계정 책임
- 조직 관리자: 사용자·역할·정책 관리, 소유권·결제 권한 제외
- 업무 역할: 사업 관리자, 영업, PM, PL, 개발자, 지원 엔지니어, 품질 담당자
- 외부 역할: 고객 관리자, 고객 사용자, 협력사, 감사자, 게스트

## 권한 판정 순서

각 Control Plane API, IPC, Runtime 명령, Relay 참여 요청은 다음 순서로 판정한다.

1. 계정, 조직, Membership, 세션이 활성 상태인지 확인한다.
2. 요청의 `organizationId`가 세션과 일치하는지 확인한다.
3. 명시적 거부와 보안 정책을 먼저 적용한다.
4. 역할에 필요한 permission이 있는지 확인한다.
5. 고객사, 프로젝트, 저장소, 자산, 티켓, 원격 세션 범위를 확인한다.
6. AgentSession·turn·tool output·Artifact의 classification과 visibility를 확인한다.
7. 만료 시각, 네트워크, 기기 신뢰, 추가 인증, 승인자 분리 조건을 확인한다.
8. 허용·거부 결과와 근거를 필요한 수준으로 감사한다.

권한 캐시는 짧게 유지하고 역할·grant·세션 폐기 이벤트를 받으면 즉시 무효화한다. 고객 데이터와
원격 호스트를 가진 서버가 최종 판정자이며 Renderer의 메뉴 숨김이나 로컬 캐시를 신뢰하지 않는다.
오프라인에서 수집한 AI event도 upload 시점의 현재 Membership, capture policy와 visibility를 다시
검사한다.

## 강제 지점

| 계층 | 책임 |
|---|---|
| Renderer | 허용된 메뉴와 명령만 표시하고 거부 상태를 설명 |
| Electron Main | sender, 세션, IPC 명령, OS 기능 접근 검증 |
| Pie Runtime | 실행 호스트, Workspace, 파일 경로, 명령 capability 검증 |
| Control Plane | 테넌트, permission, 리소스 범위, 정책의 최종 판정 |
| Relay·Edge Agent | 세션 참여, view/control, PTY, 파일 전송 capability 재검증 |

SSH, WSL, relay 호스트에서도 같은 정책 문맥을 사용한다. 원격 대상에는 전체 사용자 세션 대신
대상과 작업이 제한된 단기 capability token을 전달한다.

## 추가 인증과 업무 분리

다음 행위는 최근 MFA 또는 Passkey 인증을 요구하는 step-up 대상으로 둔다.

- 조직 소유권, 관리자 역할, SSO·보존·내보내기 정책 변경
- 원격 데스크톱 조작, 파일 전송, 관리자 터미널 진입
- API 자격증명 생성과 비밀 조회
- 대량 고객 데이터·재무 데이터 내보내기
- 모든 기기 로그아웃과 MFA 재설정

요청자와 승인자, 원격지원 승인자와 조작자, 청구 작성자와 승인자를 분리할 수 있어야 한다.
본인이 만든 고위험 요청을 본인이 승인하지 못하도록 정책으로 설정한다.

## 관리 화면

- 가입 허용, 이메일 도메인, 필수 MFA, 세션 만료 정책
- SSO 연결과 로그인 방식 우선순위
- 사용자, 초대, Membership, 팀
- 역할 템플릿과 사용자 정의 역할
- 고객·프로젝트·저장소·자산별 접근 범위
- 사용자의 유효 permission과 그 근거 미리보기
- 접근 요청, 승인, 만료 예정 권한
- 기기와 로그인 세션, 강제 로그아웃
- 서비스 계정과 API 자격증명
- 인증·권한 감사 로그

권한 편집기는 저장 전에 영향받는 사용자와 새로 허용·거부되는 고위험 permission을 보여준다.
관리자가 다른 사용자를 확인할 때는 실제 계정으로 가장하지 않고 읽기 전용 권한 미리보기를 쓴다.

## 서비스 계약

| 서비스 | 주요 기능 |
|---|---|
| Authentication | register owner, verify email, login, refresh, logout, recover account |
| Federation | begin OIDC/SAML, validate callback, map enterprise identity |
| Invitation | create, resend, revoke, inspect, accept invitation |
| Session | list devices, revoke session, revoke all, perform step-up |
| Authorization | evaluate permission, explain decision, list effective permissions |
| Role | create role, assign permissions, bind membership, manage resource grants |

외부 API의 실제 URL과 IPC 채널 이름은 구현 시 타입 계약으로 확정한다. 범용 `isAdmin` 플래그나
Renderer가 전달한 역할명만으로 접근을 허용하는 계약은 만들지 않는다.

## 감사 이벤트

- 회원가입, 이메일 확인, 초대 생성·취소·수락
- 로그인 성공·실패, 로그아웃, 토큰 재사용 탐지
- 비밀번호 재설정, MFA·Passkey·SSO 변경
- 기기 등록, 세션 갱신·폐기
- 역할·permission·리소스 grant 변경
- 접근 요청·승인·거부·만료
- step-up 성공·실패와 고위험 작업의 최종 결과

비밀번호, 원본 토큰, 인증 코드, Passkey 개인키는 로그에 기록하지 않는다. 사용자에게 보여줄
로그인 이력과 관리자용 보안 감사 이벤트는 보존 범위와 상세 수준을 분리한다.

## 완료 기준

- 신규 사용자가 이메일을 확인하고 조직 소유자로 가입할 수 있다.
- 조직 소유자가 내부 직원과 고객을 서로 다른 범위로 초대할 수 있다.
- 로그인, 갱신, 로그아웃, 비밀번호 재설정, MFA 복구가 완료된다.
- 역할 변경과 리소스 grant가 다음 요청부터 모든 강제 지점에 반영된다.
- 고객 사용자가 다른 고객사 ID를 직접 요청해도 데이터가 반환되지 않는다.
- 원격지원 게스트가 초대된 세션 밖의 채널, IPC, Runtime 명령을 실행할 수 없다.
- 세션을 폐기한 뒤 access token 만료와 무관하게 refresh와 새 capability 발급이 차단된다.
- SCIM 비활성화와 계약 종료가 활성 세션·grant·API 자격증명까지 폐기한다.
- 이메일 변경, 계정 연결, 조직 탈퇴가 다른 사용자의 계정을 획득하는 경로가 되지 않는다.
- 허용과 거부 시나리오를 역할·리소스·호스트별 자동화 테스트로 검증한다.

## 참고 기준

- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700)
- [NIST SP 800-63B-4: Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [RFC 7644: SCIM Protocol](https://www.rfc-editor.org/info/rfc7644/)
