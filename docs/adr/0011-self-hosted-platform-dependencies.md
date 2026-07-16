# ADR-0011: Self-hosted platform dependency와 optional profile

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture and Operations
- 관련 문서: `pie-docs/08-collaboration-meetings.md`,
  `pie-docs/31-deployment-and-instance-connections.md`, `pie-docs/32-reference-architecture-v1.md`

## 맥락

Pie는 SaaS 외에 한 대의 개발 PC, 사내망과 고객 On-prem Docker 환경에서도 동작해야 한다. Project와
WorkItem만 사용하는 설치에 Relay, TURN, SFU, 전용 Search와 broker를 모두 강제하면 설치·backup·보안
update 부담이 커진다.

대형 transcript, Artifact와 녹화에는 S3-compatible storage가 필요하고 화상회의는 검증된 SFU가
필요하다. 기존 논의의 MinIO community 기본값은 2026-04-25 upstream repository archived 이후 장기
security update를 기대하기 어렵다. 기존 `cli-relay`는 유용한 room·driver 기능이 있지만 shared HS256
secret과 단순 subject pairing을 production tenant authorization으로 그대로 사용할 수 없다.

## 결정

1. Self-hosted 배포는 `core`, `support`, `meeting`, `observability` Compose profile로 나눈다.
2. `core`는 Gateway, Keycloak, Control Plane API, Worker, PostgreSQL과 S3-compatible Object Storage로
   구성한다.
3. Local Docker의 기본 Object Storage 구현은 SeaweedFS다.
4. domain과 client는 S3-compatible adapter, upload intent, presigned transfer와 logical object ID만
   사용한다.
5. AWS S3와 contract를 통과한 다른 backend를 SaaS·On-prem에서 지원한다.
6. MinIO는 기존 고객 설치 compatibility 대상으로 유지할 수 있지만 신규 기본 image와 권장 production
   backend로 제공하지 않는다.
7. `meeting` profile의 Media SFU는 self-hosted LiveKit을 사용한다. TURN과 media scale-out용 dependency는
   meeting profile에만 둔다.
8. `support` profile은 Control Plane과 분리된 Relay service를 사용한다. RemoteSession, participant,
   consent, permission, invite와 audit의 권위자는 Control Plane이다.
9. `cli-relay`의 room, participant, driver, reconnect와 terminal backpressure 개념은 protocol audit와
   fixture를 거쳐 이관한다. 현재 token·pairing contract와 server를 production 기본으로 그대로 배포하지
   않는다.
10. 기존 Orca relay의 host proof, device binding, scoped token과 E2EE 구현을 우선 security baseline으로
    사용한다.
11. 초기 Pie 업무 queue는 PostgreSQL outbox와 Worker다. Redis, Kafka, NATS와 RabbitMQ를 Core에 추가하지
    않는다.
12. 초기 검색은 PostgreSQL metadata·full-text search다. 전용 Search engine은 Core dependency가 아니다.
13. `observability` profile은 OpenTelemetry Collector와 선택 backend를 추가하지만 원문 telemetry 수집을
    자동 활성화하지 않는다.
14. optional profile의 장애는 `/.well-known/pie` capability와 component health에 반영하되 Core readiness를
    실패시키지 않는다.
15. container image는 version과 digest를 pin하고 production manifest에 `latest`를 사용하지 않는다.

MinIO archive 상태는 [공식 MinIO repository](https://github.com/minio/minio), SeaweedFS의 Apache 2.0,
S3와 Docker 지원은 [공식 SeaweedFS repository](https://github.com/seaweedfs/seaweedfs)를 기준으로 한다.
LiveKit의 self-hosting과 운영 topology는
[LiveKit Self-hosting](https://docs.livekit.io/transport/self-hosting/)을 따른다.

## Profile 구성

```text
core
├── gateway
├── keycloak
├── control-plane-api
├── control-plane-worker
├── postgres
└── seaweedfs

support
└── relay

meeting
├── livekit
├── turn
└── media-only dependency when required

observability
├── otel-collector
└── selected backend
```

Self-hosted 관리자는 외부 PostgreSQL, S3와 OIDC provider adapter를 선택할 수 있다. 이 경우에도
discovery, auth mapping, migration과 contract test는 동일해야 한다.

## 검토한 대안

### MinIO를 신규 기본값으로 유지

S3 compatibility는 우수하지만 community repository가 archived 되었고 source-only·legacy 배포의
security maintenance를 Pie가 떠안게 되므로 선택하지 않는다.

### 모든 object를 PostgreSQL에 저장

transcript, media와 Artifact가 WAL, backup과 query latency를 지배하므로 선택하지 않는다.

### WebRTC SFU를 직접 구현

NAT traversal, congestion control, multi-party media, recording과 cross-platform device 문제를 제품 팀이
직접 소유하게 되므로 선택하지 않는다.

### Media를 일반 Realtime 또는 Relay에 통합

media packet이 chat, permission revoke와 terminal control을 방해하고 protocol·scale 특성이 다르므로
선택하지 않는다.

### `cli-relay`를 변경 없이 production 배포

Control Plane tenant·session·audit와 host-bound capability가 없고 shared HMAC blast radius가 크므로
선택하지 않는다.

### 처음부터 Kafka, Redis와 OpenSearch 설치

Core 설치와 운영 부담을 증가시키지만 초기 부하 근거가 없으므로 선택하지 않는다.

## 결과와 제약

- SeaweedFS S3 compatibility 범위를 multipart, presign, range, metadata와 delete contract로 검증해야 한다.
- MinIO 기존 설치 지원 기간과 검증 version을 별도 compatibility matrix에 기록해야 한다.
- LiveKit과 TURN은 방화벽, UDP, public IP와 certificate 진단이 필요하다.
- Relay는 Go service 또는 기존 구현 재사용 전에 protocol·cryptography와 command injection audit가
  필요하다.
- profile 조합마다 backup, restore, update와 health Runbook이 필요하다.
- external dependency의 database와 cache는 Pie domain database와 source of truth가 아니다.

## 검증

- SeaweedFS와 AWS S3 adapter contract suite
- multipart 중단, presigned expiry, public/internal endpoint와 orphan cleanup test
- MinIO compatibility fixture는 지원 선언 version에서만 실행
- `core` 단독 Project·WorkItem·Artifact E2E
- Relay 중단 중 Core와 Realtime 정상 동작 test
- LiveKit 중단 중 meeting capability degraded와 Core 정상 동작 test
- short-lived meeting token의 room·participant permission test
- `cli-relay` protocol input fuzz, sender spoofing, command injection과 backpressure test
- Compose profile별 cold start, update, backup·restore와 secret leak test
- image tag·digest pin과 SBOM·vulnerability gate
