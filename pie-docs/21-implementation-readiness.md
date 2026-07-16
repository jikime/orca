# 구현 준비도와 문서 운영

## 결론

Pie의 제품 범위, 핵심 도메인, 단계별 우선순위와 주요 위험은 구현 논의를 시작할 수준으로 정리되어
있다. 그러나 모든 구현 결정을 완료한 상태는 아니다. 현재 문서는 다음 작업에는 사용할 수 있다.

- R1 Electron 보안 경계와 Runtime 계약의 상세 설계
- R2 Fastify Control Plane 골격과 테넌트 저장소의 기술 검증
- R3 Keycloak 인증·Pie RBAC의 수직 흐름 구현
- R4~R5 Project → WorkItem → AI 실행 → Artifact 흐름의 schema·prototype 작성

외부 알파나 운영 배포는 아직 시작하면 안 된다. 이 문서에서 `결정 필요`로 분류한 항목과
[위협 모델](./24-security-threat-model.md), [검증 매트릭스](./25-verification-test-matrix.md)의 P0 gate가
먼저 닫혀야 한다.

## 문서 상태 분류

| 상태      | 의미                                            | 구현 사용법                              |
| --------- | ----------------------------------------------- | ---------------------------------------- |
| 기준      | 제품·도메인·보안의 기본 방향으로 채택           | 변경 시 ADR과 영향 분석 필요             |
| 계약 초안 | schema와 실패 의미가 있으나 코드 fixture가 없음 | contract test와 함께 구현                |
| 결정 필요 | 공급자, 라이브러리, 운영 조건이 미확정          | spike 또는 ADR 승인 전 종속 구현 금지    |
| 확장      | 현재 단계의 필수 경로가 아님                    | 인터페이스만 보존하고 후속 단계에서 구현 |

문서에 미래 기능이 적혀 있다는 이유만으로 구현 완료 또는 기술 채택으로 간주하지 않는다. 실제
완료 여부는 코드, migration, 자동화 테스트와 운영 Runbook을 함께 확인한다.

## 준비도 감사

| 영역                    | 현재 상태        | 근거                            | 남은 산출물                                          |
| ----------------------- | ---------------- | ------------------------------- | ---------------------------------------------------- |
| 제품 범위·사용자        | 기준             | `00`, `01`, 기능별 문서         | 초기 사용자 인터뷰와 사용량 가정                     |
| 프로젝트 실행·AI 도메인 | 기준             | `13`, `19`, `27`                | `28` backlog의 TypeScript schema와 migration         |
| 단계·의존성             | 기준             | `14`                            | 단계별 issue와 담당자                                |
| 인증·RBAC               | R0 계약 기준선   | `01`, `ADR-0009`, manifest      | R3 provisioning·정책 실행 테스트                     |
| Electron·Runtime 경계   | R0 계약 기준선   | `12`, `16`, IPC·Runtime schema  | R1 Main·preload 구현과 보안 E2E                      |
| API·이벤트·동기화       | R0 실행 계약     | `23`, OpenAPI·AsyncAPI·fixture  | R2 server validator와 generated client               |
| 위협 모델·개인정보      | 계약 초안        | `20`, `24`                      | 데이터 흐름도 review와 처리 근거 승인                |
| 테스트·호환성           | R0 gate 기준선   | `25`, security·support manifest | 단계별 CI job과 fault harness                        |
| KROOT 이관              | R0 manifest 고정 | `26`, source baseline           | 기능별 테스트 추출과 데이터 이관 spike               |
| Control Plane 기술      | 기준             | `22`, `32`, `ADR-0008`          | framework skeleton, 배포·비밀 관리 구현              |
| Relay·원격지원          | 계약 초안        | `07`, `32`, `ADR-0011`          | `cli-relay` 보안·프로토콜 fixture와 Go service spike |
| 화상회의·원격 데스크톱  | 일부 기준        | `07`, `08`, `ADR-0011`          | LiveKit contract, 원격 데스크톱 엔진 prototype       |
| 온프레미스·과금         | 확장             | `10`, `17`                      | 계약 요구와 운영 topology                            |

## 문서의 권위 순서

같은 항목이 충돌하면 다음 순서로 해결한다.

1. 승인된 ADR과 버전이 고정된 schema
2. 보안·데이터·호환성 계약 문서
3. 제품 기능 문서와 로드맵
4. 화면 설명과 prototype
5. 외부 저장소의 기존 구현

KROOT와 Orca의 기존 코드는 중요한 근거이지만 Pie의 중앙 도메인 계약보다 우선하지 않는다. 기존
동작을 바꾸는 경우에는 회귀 fixture를 만들고 의도한 변경을 ADR에 남긴다.

## R0에서 만들어야 할 저장소 산출물

문서만으로 R0를 완료하지 않는다. 구현 브랜치에는 다음 파일 계층을 추가한다.

```text
contracts/
├── openapi/pie-control-plane-v1.yaml
├── asyncapi/pie-realtime-v1.yaml
├── schemas/{common,discovery,events,resources,ipc,runtime,mcp}/
├── fixtures/{valid,invalid,compatibility}/
├── manifests/
│   ├── {permissions,roles,entitlements,capabilities}.json
│   ├── {protocol-support,error-codes,mcp-tools}.json
│   └── {security-gates,support-matrix,source-baselines,kroot-capability-migration}.json
└── scripts/{contract-file-io,schema-fixture-verification,wire-spec-verification,
             manifest-verification,verify-contracts}.mjs

docs/adr/
├── 0003-local-sqlite-outbox.md
├── 0004-tenant-enforcement.md
├── 0005-control-plane-persistence.md
├── 0006-object-storage-boundary.md
├── 0007-instance-discovery-and-connection-profiles.md
├── 0008-control-plane-modular-monolith.md
├── 0009-identity-provider-and-application-authorization.md
├── 0010-contract-first-wire-specifications.md
└── 0011-self-hosted-platform-dependencies.md
```

경로와 권위 규칙은 [Contract Specification과 변경 관리](./33-contract-specification-governance.md)에서
확정한다. 서버, Electron Main과 Runtime은 같은 versioned schema와 fixture를 사용하고 Renderer는 서버
DTO나 인증 토큰을 직접 소유하지 않는다.

## R0 구현 결과

2026-07-15 기준 `feat/pie-r0-contracts` 브랜치에는 JSON Schema 59개, fixture 49개, HTTP operation
18개, Realtime message 7개, MCP tool 6개와 P0 threat gate 38개가 있다. `pnpm check:contracts`는 root
lint에 포함되어 schema·fixture·wire spec·manifest 간 drift를 차단한다. KROOT·Orca·`cli-relay` 기준
commit과 OS·host·Git·provider release gate도 manifest에 고정했다.

R0 완료는 이 기능들이 동작한다는 뜻이 아니다. Electron 보안·IPC 실행 증거는 R1, server validator와
generated type drift는 R2, 실제 RBAC allow·deny와 세션 정책은 R3, provider parser fixture와 Relay 보안
E2E는 각각 R5와 R8의 gate다.

## 결정이 필요한 항목

| 결정                            | 확인 방법                                                   | 차단 단계     |
| ------------------------------- | ----------------------------------------------------------- | ------------- |
| Keycloak provisioning 운영 세부 | 이메일, theme, partial failure, upgrade와 break-glass E2E   | R3            |
| Object Storage 호환 범위        | SeaweedFS·S3 multipart, presign, quarantine와 삭제 contract | R2/R5         |
| 비밀·KMS                        | cloud KMS와 Self-hosted secret manager의 key lifecycle 비교 | production 전 |
| `cli-relay` 기능 이관 범위      | protocol, 인증, 명령 주입, backpressure, 감사 분석          | R8            |
| 검색 엔진 도입 시점             | 권한 회수 지연과 transcript 규모 부하 시험                  | R5 이후       |
| 원격 데스크톱 엔진              | OS별 권한·품질·입력·재부팅·라이선스 prototype               | R8            |

제품 핵심 흐름과 무관한 공급자 결정을 미리 모두 고정하지 않는다. 반대로 인증, 테넌트 격리,
outbox와 schema 도구처럼 후속 데이터 계약을 바꾸는 선택은 R0~R2에서 미루지 않는다.
Migration·query 계층, tenant enforcement, local outbox, Object Storage, Identity Provider, Control
Plane framework와 Media SFU는
[`docs/adr`](../docs/adr/README.md)와 [데이터베이스 물리 설계](./30-database-physical-design.md)에서
결정되었다. KMS topology와 원격 데스크톱 엔진은 아직 별도 결정이 필요하다.

## 변경 관리

- 계약 변경 PR에는 영향을 받는 Electron, Runtime, 서버, Worker와 최소 지원 버전을 적는다.
- 호환되지 않는 event payload 변경은 기존 `type`의 의미를 바꾸지 않고 새 schema version 또는 type을
  만든다.
- 문서의 상태를 `기준`으로 올릴 때 담당자, 결정일, 검증 링크를 ADR에 기록한다.
- 외부 표준은 `latest` 링크만 믿지 않고 구현에서 사용한 버전과 capability를 고정한다.
- 보안 표준과 런타임 취약점은 분기마다 다시 확인하고 긴급 이슈는 릴리스 gate로 승격한다.

## 다음 구현 순서

1. 완료: `33`의 공통 schema, OpenAPI, AsyncAPI와 compatibility fixture 계층을 만든다.
2. 완료: `23`의 error, concurrency, event와 outbox 의미를 executable contract로 옮긴다.
3. 완료: `24`의 P0 위협을 단계·gate·검증 증거 manifest로 연결한다.
4. 다음: R1의 안전한 IPC와 Runtime handshake를 구현한다.
5. R2의 임시 tenant → DB outbox → Worker → Realtime 수직 흐름을 구현한다.
6. R3 인증·RBAC 후 R4 Project·WorkItem을 추가한다.
7. R5에서 Claude Code·Codex 수집기를 한 provider씩 붙인다.

R4는 [R4 프로젝트 포털 Backlog](./28-r4-project-portal-backlog.md)의 Core Gate와 Planning Gate로
나누어 구현한다. R5 첫 수직 흐름은 Core Gate 이후 시작하되 외부 알파는 Planning Gate까지 요구한다.

## 완료 정의

“구현 자료가 정리되었다”는 말은 기능 목록이 많다는 뜻이 아니다. R0 완료 시점에는 최소한 다음이
참이어야 한다.

- R0 범위의 공통·업무·IPC·Runtime·ingest·MCP 객체와 요청·이벤트가 schema로 검증된다.
- 권한 행렬은 default-deny role manifest로 고정되고 위협은 구현 단계의 자동화 gate에 배정된다.
- offline retry와 schema mismatch의 실패 의미가 고정된다.
- KROOT 기능마다 이관 판정과 원본 근거가 있다.
- 남은 공급자 선택이 어떤 단계를 차단하는지 명시된다.
- 지원 OS, host, provider와 버전 조합이 CI 또는 수동 release gate에 배정된다.
