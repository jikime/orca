# ADR-0009: Keycloak Identity Provider와 Pie Authorization 분리

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture and Security
- 관련 문서: `pie-docs/01-authentication-rbac.md`, `pie-docs/16-desktop-lifecycle.md`,
  `pie-docs/32-reference-architecture-v1.md`

## 맥락

Pie는 SaaS와 Self-hosted에서 회원가입, 이메일 확인, 비밀번호 복구, MFA, Passkey, OIDC·SAML 기업
로그인을 제공해야 한다. Electron은 public native client이므로 client secret을 안전하게 보관할 수 없고,
embedded WebView 로그인은 외부 Identity Provider와 보안 정책에 맞지 않는다.

Pie의 Organization, Customer, Project, WorkItem과 RemoteSession 권한은 제품 도메인에 속한다. 이를
Identity Provider의 realm, group과 role에 그대로 넣으면 tenant relation과 resource permission이 IdP
configuration에 종속되고 SaaS·On-prem 동작이 달라진다.

## 결정

1. Pie의 기본 Identity Provider는 Keycloak이다.
2. SaaS와 Self-hosted는 같은 OIDC adapter와 native app flow를 사용한다.
3. Electron은 시스템 브라우저에서 Authorization Code + PKCE를 사용한다. embedded WebView와 implicit
   flow를 사용하지 않는다.
4. 하나의 Pie instance는 기본적으로 하나의 Keycloak realm을 사용한다. organization마다 realm을
   생성하지 않는다.
5. Keycloak은 credential, 이메일 확인, 비밀번호 복구, MFA, Passkey, IdP brokering과 IdP session을
   소유한다.
6. Pie는 issuer + subject mapping, UserAccount, Organization, Membership, Role, Permission,
   ResourceGrant, entitlement와 업무 session metadata를 소유한다.
7. email, display name, Keycloak group과 일반 role claim은 Pie resource authorization의 영구 identity나
   최종 허용 근거가 아니다.
8. Control Plane은 token signature, issuer, audience, expiry와 필요한 authentication context를 검증한
   뒤 Pie Membership·permission·resource scope를 별도로 판정한다.
9. Keycloak administrator role을 Pie 조직 관리자나 소유자 role로 자동 매핑하지 않는다.
10. 외부 OIDC·SAML 공급자는 Keycloak broker로 연결할 수 있지만 최초 account link와 조직 편입은 Pie
    invite·domain 정책을 통과한다.
11. Keycloak과 Pie database는 lifecycle과 credential을 분리한다. Self-hosted에서 같은 PostgreSQL
    cluster를 사용할 수 있지만 별도 database를 사용하고 cross-database query를 금지한다.
12. IdP와 Pie 사이에 분산 transaction을 만들지 않는다. 가입·초대 flow는 idempotent provisioning과
    orphan reconciliation 상태를 가진다.
13. access token은 Electron Main memory, refresh token은 OS key store에 두고 Renderer·Runtime·LLM
    process에 원본 token을 전달하지 않는다.
14. Runtime, Relay, LiveKit과 Object transfer에는 대상·scope·audience·expiry가 제한된 별도 capability를
    발급한다.

Keycloak은 공식 container, OIDC, WebAuthn과 identity brokering을 제공한다. 운영 기준은
[Keycloak container 문서](https://www.keycloak.org/server/containers)와
[Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html)를 따른다.

## 가입과 초대 경계

```text
Keycloak identity registration / verification
                 |
                 v
OIDC callback -> issuer + subject verified
                 |
                 v
Pie provisioning transaction
├── user account mapping
├── organization or invitation membership
├── default role and entitlement
├── audit
└── outbox
```

Keycloak 계정 생성이 성공하고 Pie provisioning이 실패하면 다음 로그인에서 같은 idempotency key와
issuer·subject로 재개한다. 기존 조직 Membership은 email 일치만으로 만들지 않는다.

## 검토한 대안

### Control Plane에서 비밀번호와 MFA 직접 구현

credential 저장, recovery, WebAuthn, federation과 보안 update 책임이 제품 업무 기능과 결합되므로
선택하지 않는다.

### Organization마다 Keycloak realm 생성

SaaS tenant 수만큼 realm lifecycle, client, theme, migration과 운영 상태가 늘고 사용자의 여러 조직
전환이 issuer 경계로 분리되므로 선택하지 않는다.

### Keycloak role을 Pie RBAC로 사용

Customer·Project·WorkItem·Ticket·Artifact 단위 scope와 관계 무결성을 표현하기 어렵고 IdP admin이
업무 권한을 우회할 수 있으므로 선택하지 않는다.

### Electron embedded WebView 로그인

native app OAuth 보안과 외부 IdP compatibility에 맞지 않으므로 선택하지 않는다.

### SaaS와 Self-hosted에 다른 인증 구현

client, recovery, session과 audit contract가 배포 방식마다 갈라지므로 선택하지 않는다. 다른 OIDC
provider 지원은 adapter contract로 추가한다.

## 결과와 제약

- Local Docker `core` profile에도 Keycloak과 별도 IdP database 초기화가 필요하다.
- Keycloak version과 security update는 Pie server release와 별도 compatibility matrix를 가진다.
- 회원가입과 초대는 IdP·Pie 두 시스템의 부분 성공을 복구해야 한다.
- 이메일 발송, theme와 공개 utility page의 책임을 명확히 나눠야 한다.
- Passkey와 enterprise federation은 Keycloak capability가 있어도 Pie 정책·E2E 검증 전 자동 활성화하지
  않는다.
- IdP 장애 중에는 offline 비민감 읽기 외의 새 인증, 권한 변경과 privileged operation을 제한한다.

## 검증

- system browser PKCE, state, nonce, issuer와 audience negative test
- 같은 email과 다른 issuer·subject의 자동 병합 거부 test
- Keycloak group·role claim만으로 Pie permission 상승 거부 test
- organization invite와 public signup의 membership isolation test
- Keycloak 성공 후 Pie provisioning 실패·재시도 test
- refresh token rotation, reuse detection과 device revoke test
- SaaS와 Local Docker의 동일 OIDC adapter contract test
- Keycloak database credential로 Pie database 접근 거부 test
- logout, account disable과 membership revoke 전파 E2E
