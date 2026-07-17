# 실시간 협업 터미널과 Relay (R8 에픽)

## 목적

mosaic(cli-relay) 아이디어를 Pie 네이티브로 재구현해 **여러 참여자가 하나의 터미널/원격 세션을 실시간 공유**한다(doc 07 원격지원, doc 32 §Relay). 상용·비공개 제품이므로 GPL mosaic **코드는 복사하지 않고** room/participant/driver/reconnect 등 **설계 개념만 참고**한다. 로드맵 R8. Relay 인프라 선행 필요.

## 3계층 분리 (doc 32 §Relay)

| 계층 | 소유/역할 | 상태 |
|---|---|---|
| **① Control Plane** (platform 백엔드) | RemoteSession·participant·consent·capability·invite·audit **진실원천**. 세션 상태머신, 권한 등급, 단기 capability 토큰 발급, 감사 | **지금 buildable** (Postgres+RLS+Fastify, 채팅 슬라이스와 동형) |
| **② Relay 서비스** (신규) | payload 미해석 암호화 스트림 ferry. frame size·rate·stream ownership·backpressure만 강제. 업무 진실원천 아님 | **신규 인프라** (Go 후보, src/relay는 local exec adapter만 존재 — 중앙 public Relay 신규) |
| **③ Orca 클라이언트** (Electron) | 다중 뷰어 PTY attach, E2EE relay 클라, view/control, 단일 driver 중재, 라이브 커서 | **클라 작업** (기존 daemon/E2EE 확장, 포크 금지) |

## 범위 판정 — 지금 vs 신규 인프라 vs 클라

- **Phase A (지금)**: Control Plane RemoteSession 권위 모델. 세션 lifecycle·참여자·동의·capability·감사. 채팅처럼 실 인프라 라이브 검증 가능.
- **Phase B (신규 인프라)**: Relay 서비스. 암호화 스트림 전송, frame/rate/ownership/backpressure. 별도 서비스·별도 wire contract·threat test.
- **Phase C (클라)**: Orca PTY daemon 다중 attach(현재 reattach 시 이전 client evict=단일 모델 → 변경), E2EE relay 클라(모바일 페어링 framing 재사용), driver 입력 중재/handoff, 라이브 커서. Electron/renderer 동반.

## 데이터 모델 (Phase A, `support`/신규 스키마)

세션 상태머신(doc 07): `요청 → 고객동의대기 → 연결중 → 활성 → 일시중지 → 종료 → 검토완료`. 동의 철회·정책 만료 시 입력 즉시 차단·연결 종료.

- **RemoteSession**: (org, id) PK, kind(terminal|desktop|support), ticket_id?(delivery/service 연결), status(위 상태머신), created_by, host_user_id, created_at/updated_at/version. RLS pair.
- **SessionParticipant**: (org, id) PK, session_id FK, user_id, grade(관전<채팅<터미널조작<데스크톱조작<파일전송<관리자 — doc 07 권한등급), joined_at/left_at, is_driver(단일 driver). 등급은 세션 중 회수 가능.
- **SessionConsent**: (org, id) PK, session_id FK, subject_user_id(고객), granted_at, revoked_at?, scope. 철회는 즉시 반영(감사·입력차단 트리거).
- **CapabilityToken**: (org, id) PK, session_id FK, participant_id FK, capability(view|control|file...), audience(대상 제한), expires_at(단기), nonce, consumed_at?. **전체 세션 아닌 scoped·단기**. 발급/소비 감사.
- **SessionAudit**: 참여자 입퇴장, 권한변경·조작권 이전, 동의·철회, capability 발급/소비, takeover, 연결품질/중단. FK-free 감사 스트림(감사는 실패해도 best-effort, 채팅 audit 패턴 재사용).

## 보안 제약 (설계 전 고정, doc 07/24/32)

1. **view ≠ control 별도 권한**(`remote.view`/`remote.control`, 중간 downgrade 포함). 화면에서 권한 숨김만으론 입력 차단 안 함.
2. **승인자 ≠ 조작자 분리**. 모든 takeover 감사.
3. **scoped 단기 capability 토큰**(전체 세션 아님, audience·expiry·nonce). 세션 종료 후 제어 토큰·임시파일 폐기.
4. **원격 제어 = step-up MFA**.
5. **E2EE relay**(Relay가 plaintext/토큰 못 봄). Orca host-proof·device-binding baseline. shared HS256/query token/subject-only pairing 프로덕션 금지.
6. **PTY flood가 control/audit 채널을 굶기지 않음**(트래픽 등급 분리, backpressure).
7. 동의 철회·정책 만료 시 입력 즉시 차단. 재부팅·사용자 전환 중 기존 capability 재사용 금지, 새 상태 검증.
위협 REM-001~007, CAP-001~008(Agent 세션 공유 시 transcript 비밀/가시성).

## Orca 기존 재사용 (포크 금지)

- 단일 PTY daemon(`src/main/daemon/*`) — 다중 뷰어엔 attach 모델 변경 필요.
- PTY 스트리밍+backpressure(renderer `pty-dispatcher.ts`/`pty-transport.ts`).
- **기존 모바일 E2EE·host-proof relay**(`src/shared/mobile-e2ee-v2-framing.ts`) = Relay 보안 baseline(doc 32 명시).
- RBAC의 RemoteSession grant + `remote.view`/`remote.control` 권한.

## 슬라이스 분해 (의존 순서)

- **A1 · RemoteSession 권위 thin vertical** (Phase A, 지금): 세션 생성(상태머신)·참여자·동의·기본 감사. RBAC `remote.view`/`remote.control` 권한 manifest 등록. Relay/클라 없이 Control Plane API만. ← 먼저
- **A2 · capability 토큰 발급·소비**: scoped·단기·nonce·audience, step-up 연동 훅, 발급/소비 감사. 동의 철회 → capability 무효화.
- **A3 · 조작권(driver) 중재·takeover 감사**: 단일 driver, handoff/회수, 승인자≠조작자.
- **B1 · Relay 서비스 골격**: 신규 서비스, wire contract(AsyncAPI 분리), payload 미해석, frame/rate/ownership/backpressure, host/participant 단기 토큰 검증. threat test.
- **B2 · E2EE 스트림 전송**: 모바일 framing 재사용, Relay가 plaintext 못 봄.
- **C1 · 단일 뷰어 view-only over Relay** → **C2 · 다중 뷰어(daemon 다중 attach + min-size)** → **C3 · 입력 takeover+capability+중재** → **C4 · 라이브 커서/presence** → **C5 · Agent 세션 공유(transcript 가시성 CAP threat pass)**.

## 진행 방식

기존 파이프라인 동일: Fable 슬라이스 브리핑 → Opus subagent 구현 → Fable 실 인프라 라이브 검증 → main 머지. **A1(Control Plane RemoteSession)부터** 착수. Relay(B)·클라(C)는 A 권위 모델 위에서. Phase A는 채팅 검증 하네스(PG+KC) 재사용, Phase B/C는 별도 검증 환경 필요.
