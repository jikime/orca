# SaaS·Self-hosted 배포와 Instance 연결

## 목표

하나의 Pie Electron 앱이 Pie SaaS, 같은 PC의 Local Docker, 사내망 또는 고객망의 Self-hosted
Control Plane에 연결되게 한다. 일반 사용자가 PostgreSQL, Object Storage, Realtime, Relay와 Media
주소를 각각 이해하거나 입력하게 하지 않고, Control Plane bootstrap URL 하나로 안전하게 전체
instance를 발견하고 연결해야 한다.

이 문서의 연결 bootstrap 결정은
[`ADR-0007`](../docs/adr/0007-instance-discovery-and-connection-profiles.md), process 경계는
[Electron 시스템 아키텍처](./12-electron-system-architecture.md), local profile과 update는
[데스크톱 배포와 수명주기](./16-desktop-lifecycle.md)를 따른다.

## 지원 배포 형태

| 형태 | 예시 | 특징 |
|---|---|---|
| Pie SaaS | `https://app.pielab.ai` | Pie 운영자가 Control Plane과 저장소를 관리 |
| Local Docker | `http://127.0.0.1:7410` | Electron과 Docker가 같은 PC, loopback 전용 HTTP 허용 |
| LAN Self-hosted | `https://pie.company.internal` | 사내 DNS, reverse proxy와 조직 CA 또는 공인 인증서 |
| Customer On-prem | `https://pie.customer.example` | 고객 인프라, proxy·폐쇄망·별도 backup 정책 |
| HA Self-hosted | `https://pie.company.example` | 다중 API·Worker·Relay와 외부 PostgreSQL·Object Storage |

동일한 Electron binary와 API contract를 사용한다. 배포 형태가 달라도 UI 기능을 fork하지 않고
server capability와 permission으로 노출 범위를 정한다.

## 연결 경계

사용자가 입력하는 필수 값은 Control Plane bootstrap URL 하나다.

```text
Pie Electron
  -> https://pie.company.internal/.well-known/pie
     -> API URL
     -> authentication method
     -> Realtime URL
     -> Relay URL
     -> Media URL
     -> protocol and capability
```

Electron 설정에 다음 값을 입력하게 하지 않는다.

- PostgreSQL host, port, database와 credential
- Object Storage internal endpoint, bucket access key와 secret key
- Worker와 queue endpoint
- Docker container name 또는 internal network address
- KMS·SMTP·OIDC client secret

이 값은 Self-hosted 관리자와 server deployment의 책임이다.

## Electron 연결 설정

로그인 전에도 접근 가능한 `Settings > Connections`에서 instance profile을 관리한다.

```text
연결 방식
  Pie Cloud
  Self-hosted / Local Docker

서버 주소
  https://pie.company.internal

고급 설정
  시스템 proxy / 사용자 proxy
  사용자 CA 인증서
  연결 timeout

[연결 테스트]  [저장하고 연결]
```

- SaaS 기본 profile은 제품이 제공하지만 사용자가 명시적으로 선택한다.
- Self-hosted URL은 scheme, host와 port까지만 받으며 path는 canonical bootstrap path로 정규화한다.
- 일반 설정에는 API, Realtime, Relay와 Media 개별 override를 제공하지 않는다.
- 개발자 진단 override가 필요하면 별도 developer setting과 경고를 사용하고 일반 profile로 동기화하지
  않는다.
- 연결 테스트는 DNS, TLS, discovery schema, protocol compatibility, server time과 최소 앱 version을
  단계별로 보여준다.
- 실패 시 SQL, container path, secret과 전체 인증서 material을 오류 본문에 노출하지 않는다.

## Instance discovery contract

### Request

```http
GET /.well-known/pie
Accept: application/json
Pie-Client-Version: <desktop-version>
```

이 endpoint는 로그인 전 bootstrap에 사용하므로 업무 데이터와 사용자별 permission을 반환하지 않는다.
응답은 짧게 cache할 수 있지만 매 로그인과 reconnect 전에 expiry와 instance identity를 확인한다.

### Response

```json
{
  "schemaVersion": 1,
  "instanceId": "company-pie-prod",
  "displayName": "Company Pie",
  "deploymentType": "self_hosted",
  "apiBaseUrl": "https://pie.company.internal/v1",
  "auth": {
    "protocol": "oidc",
    "issuer": "https://pie.company.internal/realms/pie",
    "clientId": "pie-desktop",
    "redirectModes": ["loopback", "private_uri_scheme"]
  },
  "realtimeUrl": "wss://pie.company.internal/realtime",
  "relayUrl": "wss://relay.company.internal",
  "mediaUrl": "https://media.company.internal",
  "protocol": {
    "api": "1.0",
    "realtime": "1.0",
    "relay": "1.0"
  },
  "minimumClientVersion": "0.1.0",
  "capabilities": {
    "objectUpload": true,
    "remoteSupport": true,
    "videoMeeting": false
  },
  "expiresAt": "2026-07-15T12:00:00Z"
}
```

### 규칙

- `instanceId`는 설치 후 안정적으로 유지하는 opaque ID이며 display name이나 URL에서 유도하지 않는다.
- URL은 absolute HTTPS URL이어야 한다. loopback profile에서만 HTTP를 허용한다.
- discovery redirect가 origin을 바꾸면 자동으로 token을 전송하지 않고 사용자에게 새 origin을 보여준다.
- unknown optional field는 무시하지만 필수 endpoint와 지원 protocol이 없으면 연결하지 않는다.
- Main은 `auth.issuer`의 OIDC discovery와 TLS origin을 검증하고 `clientId`를 public native client로만
  사용한다. password·Passkey·기업 SSO 선택은 Identity Provider 인증 화면의 책임이다.
- capability는 기능 존재를 뜻할 뿐 현재 사용자의 permission이나 entitlement를 대신하지 않는다.
- service URL 변경은 같은 `instanceId`와 유효한 TLS 신뢰 안에서만 profile update 후보로 처리한다.
- Object Storage endpoint는 discovery에 필수로 노출하지 않는다. upload intent가 permission과 quota를
  확인한 뒤 짧은 presigned URL을 반환한다.

## Connection profile 격리

하나의 설치본에서 여러 SaaS·Self-hosted instance를 저장할 수 있다.

```text
ConnectionProfile
├── localProfileId
├── bootstrapOrigin
├── instanceId
├── displayName
├── trust configuration reference
├── last successful discovery
└── last selected account / organization reference
```

- access token은 Main memory, refresh token은 OS key store에 보관한다.
- key store entry는 canonical origin, `instanceId`, subject와 device를 포함해 namespace를 분리한다.
- Portal cache, recent route, download metadata와 Realtime cursor도 profile·instance·organization별로
  분리한다.
- 다른 instance로 전환하면 기존 Runtime capability, Realtime subscription과 pending server request를
  종료한다.
- 같은 email이라도 다른 instance account를 같은 identity로 자동 병합하지 않는다.
- `instanceId`가 갑자기 바뀐 URL은 server 재설치 또는 impersonation 가능성이 있으므로 새 profile처럼
  다시 확인한다.

## Server와 Docker 설정

Self-hosted 관리자는 Compose secret, environment file 또는 secret manager로 service를 구성한다.

```env
PIE_INSTANCE_ID=company-pie-prod
PIE_DISPLAY_NAME=Company Pie
PIE_PUBLIC_URL=https://pie.company.internal
PIE_API_PUBLIC_URL=https://pie.company.internal/v1
PIE_REALTIME_PUBLIC_URL=wss://pie.company.internal/realtime
PIE_RELAY_PUBLIC_URL=wss://relay.company.internal
PIE_MEDIA_PUBLIC_URL=https://media.company.internal

DATABASE_URL=postgresql://...

OBJECT_STORAGE_INTERNAL_ENDPOINT=http://object-storage:8333
OBJECT_STORAGE_PUBLIC_ENDPOINT=https://objects.company.internal
OBJECT_STORAGE_BUCKET=pie-objects
OBJECT_STORAGE_ACCESS_KEY=...
OBJECT_STORAGE_SECRET_KEY=...
```

- 실제 이름은 server configuration schema에서 version을 고정한다. 위 값은 책임과 방향을 보여주는
  예시다.
- secret 값은 Compose file, image, discovery response와 진단 로그에 직접 넣지 않는다.
- `*_INTERNAL_ENDPOINT`는 Docker network에서만 사용한다.
- `*_PUBLIC_URL`은 Electron이 실제로 접근 가능한 DNS·port와 인증서를 사용한다.
- Object Storage가 presigned URL을 만들 때 internal container name이 아니라 public endpoint를 사용한다.
- container가 정상이어도 public URL에서 접근하지 못하면 deployment health를 ready로 표시하지 않는다.

## Docker network와 Gateway

```text
Electron / Browser auth utility
              |
              v
        Reverse Proxy
        ├── Control Plane API
        ├── Keycloak and Pie auth utility pages
        ├── Realtime Gateway
        ├── Object upload/download endpoint
        ├── Relay public endpoint
        └── Media SFU endpoint

Docker private network
├── Keycloak
├── Control Plane
├── Worker
├── PostgreSQL
├── SeaweedFS or compatible Object Storage
├── Realtime
├── Relay when support profile is enabled
└── LiveKit when meeting profile is enabled
```

- PostgreSQL과 Worker는 public port를 열지 않는다.
- Object Storage admin console과 internal API는 public endpoint와 분리한다.
- Relay·Media처럼 client가 직접 연결해야 하는 service는 discovery에서 public URL을 제공한다.
- 가능한 service는 하나의 reverse proxy origin 아래 path routing할 수 있지만 WebSocket, large upload와
  media 특성을 고려해 별도 hostname을 허용한다.
- reverse proxy가 전달한 actor, organization과 permission header를 신뢰하지 않고 Control Plane token과
  capability를 다시 검증한다.
- Keycloak은 별도 database credential을 사용하며 Pie application이 IdP table을 직접 query하지 않는다.

## Local Docker

Electron과 Docker가 같은 장비에서 실행될 때는 다음 제한을 적용한다.

- bootstrap URL은 `http://127.0.0.1:<port>` 또는 `http://[::1]:<port>`를 허용한다.
- `0.0.0.0`, 임의 LAN IP와 hostname에는 HTTP 예외를 적용하지 않는다.
- browser auth callback과 Realtime도 loopback 또는 검증된 custom scheme을 사용한다.
- default credential은 first-run bootstrap에서 교체하고 image나 repository에 고정하지 않는다.
- Local Docker instance도 고유 `instanceId`, migration, backup과 update 상태를 가진다.
- 같은 장비의 process라는 이유로 DB credential이나 root Object Storage credential을 Electron에
  전달하지 않는다.

다른 PC가 접속해야 하면 Local Docker가 아니라 LAN Self-hosted profile로 취급하고 실제 DNS와 HTTPS를
구성한다. `localhost`를 server public URL로 광고하지 않는다.

## Object upload와 download

```text
Electron -> Control Plane: upload intent(metadata, hash, size)
Control Plane -> Electron: short-lived presigned URL
Electron -> Object Storage public endpoint: upload
Electron -> Control Plane: finalize(hash, parts)
Control Plane -> Worker: scan / quarantine / available
```

- Electron에는 bucket access key와 secret key를 저장하지 않는다.
- presigned URL은 instance, tenant, object, method, size와 짧은 expiry로 제한한다.
- URL origin은 discovery 또는 upload response에서 오더라도 Main의 허용된 transfer context에서만 연다.
- download는 permission을 다시 확인하고 public bucket URL을 영구 Artifact URL로 사용하지 않는다.
- S3-compatible backend 제품은 server adapter와 contract test로 교체 가능하게 유지한다.
- Local Docker 기본 backend는 SeaweedFS다. AWS S3와 기존 MinIO 설치는 같은 adapter contract를
  통과한 경우 지원한다.
- MinIO community server는 upstream archive 이후 신규 기본 image로 제공하지 않는다.

## TLS, Proxy와 신뢰

- SaaS와 non-loopback Self-hosted 연결은 HTTPS·WSS만 허용한다.
- `인증서 오류 무시` 옵션을 제공하지 않는다.
- 조직 CA는 OS trust store 또는 사용자가 명시적으로 가져온 CA reference로 처리한다.
- proxy는 system/PAC를 기본으로 하고 profile별 override는 credential을 OS key store에 보관한다.
- custom CA·proxy 변경은 profile trust 변경으로 감사 가능한 local event를 남긴다.
- remote page, deep link, QR과 chat message가 사용자 확인 없이 새 instance를 등록하거나 기존 profile의
  URL을 바꾸지 못한다.

## Deep link와 provisioning

관리자는 설치 안내나 device management로 bootstrap URL을 제공할 수 있다.

```text
pie://connect?profile=<signed-or-user-confirmed-bootstrap-reference>
```

- arbitrary deep link parameter를 즉시 신뢰하지 않는다.
- origin, instance display name, certificate와 조직 정보를 보여주고 사용자가 확인한 뒤 profile을 만든다.
- enterprise managed configuration은 서명·device policy와 source를 검증한다.
- 초대·로그인 token과 bootstrap URL을 하나의 장기 URL에 같이 넣지 않는다.

## 상태와 진단

Connection 화면은 다음 상태를 구분한다.

```text
Resolving -> TLS verifying -> Discovering -> Compatible -> Authenticating -> Connected
                     |              |             |
                     v              v             v
                Trust error    Schema error   Upgrade required
```

- API, Realtime, Relay, Media와 Object transfer의 health를 하나의 `연결됨`으로 뭉개지 않는다.
- 사용하지 않는 capability의 service가 꺼져 있어도 core API를 장애로 표시하지 않는다.
- 진단 export에는 hostname과 protocol result를 포함할 수 있지만 token, DB URL, S3 secret과 presigned
  query를 제거한다.

## 구현 순서

1. `ConnectionProfile` local schema와 OS key store namespace를 정의한다.
2. `/.well-known/pie` JSON Schema와 compatibility fixture를 만든다.
3. Main의 URL canonicalization, TLS·redirect와 discovery client를 구현한다.
4. Settings의 Cloud·Self-hosted profile 생성, 연결 테스트와 전환 UI를 구현한다.
5. Control Plane의 discovery response와 public URL validation을 구현한다.
6. Local Docker Compose의 `core` profile에 reverse proxy, Keycloak, PostgreSQL과 SeaweedFS를 연결한다.
7. upload intent·presigned URL·finalize가 internal/public endpoint를 혼동하지 않는지 검증한다.
8. LAN, proxy, custom CA, offline, server reinstallation과 instance ID mismatch E2E를 추가한다.

## 완료 기준

- 사용자가 Control Plane URL 하나만 입력해 API, 인증과 사용 가능한 service를 발견한다.
- Electron과 Renderer에 DB·Object Storage root credential이 전달되지 않는다.
- Local Docker는 loopback HTTP로 동작하고 LAN·On-prem은 HTTPS 없이는 연결되지 않는다.
- 같은 email·organization 이름을 가진 두 instance의 token, cache, route와 Realtime cursor가 섞이지 않는다.
- Object upload presigned URL이 client가 접근 가능한 public endpoint를 사용한다.
- discovery URL 변경, cross-origin redirect와 `instanceId` mismatch가 사용자 확인 없이 profile을 바꾸지
  못한다.
- disabled Relay·Media capability가 core Portal 연결을 실패시키지 않는다.
- cloud와 Self-hosted가 같은 discovery, auth, API와 Object Storage contract test를 통과한다.
