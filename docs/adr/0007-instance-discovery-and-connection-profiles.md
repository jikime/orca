# ADR-0007: Instance discovery와 연결 프로필

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture and Security
- 관련 문서: `pie-docs/12-electron-system-architecture.md`, `pie-docs/16-desktop-lifecycle.md`,
  `pie-docs/31-deployment-and-instance-connections.md`

## 맥락

Pie Electron은 SaaS뿐 아니라 같은 PC의 Docker, 사내망과 고객 온프레미스 Control Plane에 연결해야
한다. 배포마다 API, Realtime, Relay, Media와 Object Storage의 public URL이 달라질 수 있다. 모든 주소를
사용자에게 입력시키면 구성 오류가 증가하고 DB·Object Storage credential 같은 내부 정보를 Desktop에
노출할 위험이 있다.

동시에 SaaS URL을 binary에 하나만 고정하면 Self-hosted, 폐쇄망, custom CA와 여러 고객 instance를
지원할 수 없다.

## 결정

1. Electron의 사용자 입력은 Control Plane bootstrap URL 하나로 제한한다.
2. Control Plane은 로그인 전 `GET /.well-known/pie` discovery endpoint를 제공한다.
3. discovery는 stable opaque `instanceId`, API·OIDC issuer와 public client metadata, Realtime·Relay·Media
   public URL, protocol, minimum client version, capability와 expiry를 반환한다.
4. PostgreSQL, Worker, Object Storage internal endpoint, bucket credential, KMS와 provider secret은
   discovery나 Renderer에 노출하지 않는다.
5. Object upload는 Control Plane의 upload intent가 발급한 짧은 presigned URL을 사용한다. Desktop은
   S3 root credential을 소유하지 않는다.
6. SaaS, Local Docker, LAN과 On-prem은 같은 discovery schema와 API contract를 사용한다.
7. non-loopback URL은 HTTPS·WSS만 허용한다. HTTP 예외는 literal loopback address에만 적용한다.
8. custom CA는 명시적 trust reference로 지원하지만 TLS 검증 비활성화 옵션은 제공하지 않는다.
9. 하나의 설치본은 여러 `ConnectionProfile`을 저장할 수 있다. token, key store, cache, recent route,
   Realtime cursor와 organization state는 canonical origin + `instanceId`로 격리한다.
10. cross-origin redirect, discovery의 `instanceId` 변경과 deep link 기반 profile 변경은 사용자 확인 없이
    적용하지 않는다.
11. server 관리자는 Docker environment·secret manager에서 internal/public service URL을 설정한다.
    사용자는 개별 service URL을 일반 설정에서 override하지 않는다.
12. capability discovery는 현재 사용자의 authorization을 대체하지 않는다. 로그인 후 API가 permission과
    entitlement를 다시 판정한다.

## Discovery 최소 계약

```text
schemaVersion
instanceId
displayName
deploymentType
apiBaseUrl
auth.protocol / issuer / clientId / redirectModes
realtimeUrl
relayUrl
mediaUrl
protocol
minimumClientVersion
capabilities
expiresAt
```

optional service가 비활성화되면 URL을 생략하고 capability를 false로 반환할 수 있다. Core API와 Auth
계약은 반드시 존재해야 한다.

## 검토한 대안

### 모든 service 주소를 설정 화면에서 입력

사용자 오류, internal URL 노출, profile drift와 지원 비용을 증가시키므로 선택하지 않는다.

### SaaS URL 하나를 binary에 고정

Local Docker, On-prem과 고객별 instance를 지원하지 못하므로 선택하지 않는다.

### Electron에 Docker Compose 또는 DB 설정을 직접 입력

Desktop이 infrastructure secret과 lifecycle을 소유하게 되므로 선택하지 않는다. Docker 관리 UI가
필요하면 server admin surface로 별도 제공한다.

### DNS SRV만 사용

사설 DNS와 폐쇄망에서 유용할 수 있지만 명시적 bootstrap URL, TLS trust와 instance identity를
대체하지 못하므로 기본 방식으로 선택하지 않는다.

### Object Storage를 Control Plane이 항상 proxy

작은 파일에는 가능하지만 transcript, Artifact와 녹화의 bandwidth·memory가 API process를 통과하므로
기본 방식으로 선택하지 않는다. permission 확인 후 direct presigned transfer를 사용한다.

## 결과와 제약

- Control Plane public URL 설정과 reverse proxy 검증이 deployment의 필수 단계가 된다.
- server URL 변경과 재설치 시 profile identity 복구 흐름이 필요하다.
- Electron Main에 URL canonicalization, custom CA, proxy와 discovery schema 검증이 추가된다.
- S3-compatible backend는 internal endpoint와 client-reachable public endpoint를 모두 구성해야 할 수 있다.
- optional Relay·Media 장애를 Core API 장애와 구분하는 health model이 필요하다.

## 검증

- SaaS, loopback Docker, LAN HTTPS와 custom CA discovery fixture
- HTTP non-loopback, malformed URL, redirect와 DNS rebinding 방어 test
- 같은 email·display name을 가진 두 `instanceId`의 token·cache isolation test
- `instanceId` 변경과 certificate 변경의 사용자 재확인 E2E
- internal Object Storage hostname이 presigned URL에 포함되지 않는 contract test
- disabled Relay·Media와 Core API health 분리 test
- deep link와 remote content의 silent profile mutation 거부 test
