# ADR-0010: Contract-first wire specification과 생성물 권위

- 상태: Accepted
- 결정일: 2026-07-15
- 소유자: Pie Architecture
- 관련 문서: `pie-docs/23-api-event-sync-contracts.md`,
  `pie-docs/33-contract-specification-governance.md`

## 맥락

Pie Electron, Runtime, Control Plane, Worker, Relay와 Edge Agent는 다른 release cadence와 언어를 가질
수 있다. TypeScript interface만 공유하면 runtime validation과 Go service가 같은 의미를 보장하지
못하고, server code에서 client type을 직접 import하면 Desktop·Server lockfile과 배포 경계가 결합된다.

OpenAPI, WebSocket message, event, IPC, Runtime RPC와 MCP tool이 각각 다른 방식으로 정의되면 ID,
오류, permission과 version 규칙이 쉽게 어긋난다.

## 결정

1. repository root의 `contracts`가 언어 독립 wire specification과 compatibility fixture를 소유한다.
2. HTTP API는 OpenAPI 3.1.2를 사용한다.
3. 공통 payload는 JSON Schema 2020-12를 사용한다.
4. Realtime WebSocket은 AsyncAPI 3.0.0을 사용한다.
5. 영속 event envelope는 CloudEvents 1.0 의미와 호환한다.
6. HTTP 오류는 RFC 9457, 수정 경쟁은 RFC 9110의 strong ETag와 `If-Match`를 사용한다.
7. MCP implementation baseline은 `2025-11-25`로 고정한다.
8. Fastify request·response validator는 `contracts/schemas`의 같은 JSON Schema를 소비한다.
9. Electron Main과 server type은 schema에서 생성한다. Renderer는 generated network client를 직접
   사용하지 않고 preload view model을 사용한다.
10. generated file은 수동 편집하지 않으며 generator, option과 runtime version을 lockfile과 manifest에
    고정한다.
11. Zod 또는 TypeScript type은 local implementation에 사용할 수 있지만 독립적인 wire authority가
    되지 않는다. wire boundary에서는 versioned schema와 fixture를 통과해야 한다.
12. SQL migration은 physical database schema의 권위자이며 OpenAPI DTO와 database row를 같은 type으로
    사용하지 않는다.
13. additive change도 minimum supported client fixture와 unknown optional field test를 통과해야 한다.
14. required field, 의미, 단위, authorization scope와 error 의미를 바꾸는 변경은 새 protocol/schema
    major 또는 endpoint를 사용한다.
15. Product, API, payload schema, protocol, parser와 migration version을 서로 분리한다.
16. schema syntax, valid·invalid fixture, generated drift, implementation validation, tenant negative와
    compatibility test를 contract CI의 merge gate로 둔다.

OpenAPI version은 [공식 version 목록](https://spec.openapis.org/oas/)을 기준으로 하되 첫 구현은
toolchain compatibility를 위해 3.1.2에 고정한다. AsyncAPI 형식은
[AsyncAPI 3.0.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0)을 따른다.

## Contract flow

```text
OpenAPI / AsyncAPI / JSON Schema
             |
             +-> lint and fixture validation
             +-> Fastify runtime validator
             +-> Main/server generated types
             +-> Go model generation or validation adapter
             +-> documentation examples
             +-> compatibility suite
```

생성물이 source schema와 달라지면 CI는 drift를 실패시킨다. 생성 도구가 표현하지 못하는 schema 기능은
조용히 제거하지 않고 generator 변경 또는 명시적 adapter와 fixture로 해결한다.

## 검토한 대안

### TypeScript type을 단일 권위로 사용

runtime validation, Go Relay와 외부 integration이 compile-time type을 공유할 수 없으므로 선택하지
않는다.

### Fastify route code에서 OpenAPI를 사후 생성

빠르게 시작할 수 있지만 IPC, Runtime, event와 다른 언어의 계약 권위를 server package 안에 가두므로
선택하지 않는다. route는 root contract를 소비한다.

### Zod schema를 모든 wire format의 원본으로 사용

현재 Desktop에서 유용하지만 OpenAPI·JSON Schema·Go 변환과 dialect 차이가 별도 권위를 만들 수 있어
wire의 유일한 원본으로 선택하지 않는다.

### OpenAPI 3.2를 즉시 사용

표준에는 포함됐지만 generator, validator와 ecosystem compatibility를 먼저 검증해야 하므로 첫 구현에
선택하지 않는다.

### gRPC/Protobuf로 모든 경계 통합

HTTP resource, browser auth, JSON 기반 MCP와 Electron IPC까지 하나의 transport에 맞추는 비용이 크고
현재 interoperability 요구와 맞지 않으므로 선택하지 않는다.

## 결과와 제약

- schema review와 fixture 작성이 route 구현 전에 필요하다.
- generator upgrade가 큰 diff를 만들 수 있어 별도 PR과 compatibility test가 필요하다.
- JSON Schema와 OpenAPI가 표현하지 못하는 domain invariant는 application service와 database constraint에
  남고 negative test로 연결해야 한다.
- OpenAPI operation과 shared schema의 circular reference를 제한하는 authoring rule이 필요하다.
- generated client가 authorization, retry와 offline policy를 자동 결정하지 않게 Main adapter가 필요하다.

## 검증

- OpenAPI·AsyncAPI·JSON Schema lint와 `$ref` resolution test
- valid fixture accept와 invalid fixture reject test
- generated output clean-tree test
- Fastify validator와 fixture parity test
- Main generated type compile test
- minimum supported Desktop·Runtime compatibility test
- unknown optional field, event type와 capability test
- RFC 9457 error code와 sensitive detail redaction test
- cross-tenant ID와 unauthorized field negative test
- migration expand-contract와 이전 API fixture upgrade test
