# Pie executable contracts

이 디렉터리는 Pie 데스크톱과 서버 사이의 구현 가능한 계약 원본이다. 아키텍처 원칙과 호환성 정책은
[`pie-docs/33-contract-specification-governance.md`](../pie-docs/33-contract-specification-governance.md)를 따른다.

## 구성

- `openapi/`: discovery와 control plane HTTP API
- `asyncapi/`: realtime 변경 알림과 세션 무효화 프로토콜
- `schemas/`: 공유 JSON Schema 2020-12 모델
- `fixtures/`: 유효, 무효, 전방 호환성 회귀 데이터
- `manifests/`: 권한·역할·entitlement·MCP 도구·지원 프로토콜·보안 gate·지원 조합의 canonical 목록
- `scripts/`: schema, 참조, fixture, wire specification과 manifest 일관성 검증기

## 검증

```sh
pnpm check:contracts
```

응답과 이벤트 schema는 알 수 없는 선택 필드를 허용해 하위 버전 클라이언트의 전방 호환성을 유지한다.
반면 create/update 명령 schema는 오타와 잘못된 입력을 조기에 차단하기 위해 정의되지 않은 필드를 거부한다.

공개 예시 host와 schema ID는 `pielab.ai`를 canonical domain으로 사용한다. schema는
`https://schemas.pielab.ai/`, 오류 type은 `https://errors.pielab.ai/` 아래에 둔다.

현재 R0 기준선은 JSON Schema 59개, fixture 49개, HTTP operation 18개, Realtime message 7개,
MCP tool 6개와 P0 보안 gate 38개다. 생성 TypeScript DTO와 client는 R2 Control Plane skeleton에서
generator와 option을 고정한 뒤 추가한다.
