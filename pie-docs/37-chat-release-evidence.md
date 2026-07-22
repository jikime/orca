# 채팅 릴리스 검증 기록

## 목적

이 문서는 [채팅 핵심 제품 로드맵](./36-chat-core-roadmap.md)의 안정성·운영 6단계를 실제 검증
명령과 실패 조건에 연결한다. 컴포넌트나 라우트 파일이 있다는 이유만으로 완료 처리하지 않는다.

## 사용자 흐름

1. 사용자는 채널과 스레드에서 작성 중인 본문·멘션·업로드 완료 첨부를 다시 열어 복구한다.
2. 오프라인 또는 일시 오류로 전송이 실패하면 본문을 잃지 않고 같은 요청 ID로 재시도하거나 취소한다.
3. 읽던 위치를 유지한 채 새 메시지 알림을 받고, 직접 이동했을 때만 읽음 커서를 전진시킨다.
4. 150건 이상 대화는 가상화하고, 과거 페이지와 실시간 페이지는 ID 기준으로 중복 없이 병합한다.
5. `channel.manage` 사용자는 보존 기간, 즉시 적용, JSON 내보내기와 감사 이력을 관리한다.
6. 관리자가 타인 메시지를 삭제할 때 사유가 없으면 Renderer와 서버 양쪽에서 거부한다.

## 자동화 gate

| 경계          | 검증 내용                                                     | 명령                                                                                                                    |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Renderer      | 초안, 재시도, unread, 스크롤, 가상화, 관리자 삭제, 운영 설정  | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/pie/chat`                                       |
| Main·Preload  | 신뢰된 IPC, 토큰 비노출, 요청 검증, 보존 멱등 키, 응답 schema | `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/pie-chat*.test.ts src/main/pie-chat/chat-*.test.ts` |
| 계약          | OpenAPI, JSON Schema, fixture, 멱등 mutation 규칙             | `pnpm run check:contracts`                                                                                              |
| Control Plane | 실제 PostgreSQL migration·RLS·권한·보존·내보내기·감사         | `cd platform && pnpm exec vitest run apps/control-plane-api/src/chat-*-vertical.test.ts`                                |
| 정적 검증     | Desktop·Platform typecheck, lint, max-lines, 현지화 parity    | `pnpm run typecheck`, `pnpm run lint`, `cd platform && pnpm run typecheck && pnpm run lint`                             |
| 패키징        | Main·Preload·Renderer production bundle                       | `pnpm run build:electron-vite`                                                                                          |

## 2026-07-21 실행 결과

- Desktop 채팅 회귀: 54개 파일, 233개 테스트 통과
- Control Plane·PostgreSQL 수직 검증: 17개 파일, 107개 테스트 통과
- Desktop·Platform typecheck 및 lint 통과
- 계약 검증: schema 274개, fixture 109개, HTTP operation 87개, realtime 11개, MCP 6개, gate 38개 통과
- Electron production build 통과

## 실패 조건

- Renderer가 access token이나 organization identity를 직접 보관하거나 전송한다.
- 실패 메시지 재시도가 새 요청 ID를 사용해 서버에 중복 메시지를 만든다.
- 사용자가 과거 위치를 읽는 중 새 메시지 도착이 강제로 최하단으로 이동시킨다.
- 다른 사용자의 메시지에 일반 사용자가 삭제 action을 보거나, 관리자가 사유 없이 삭제한다.
- 보존 적용 후 live body 또는 revision body가 남거나, tombstone과 감사 행이 함께 사라진다.
- 비관리자가 감사 로그 또는 채널 내보내기를 읽는다.
- 10,000건 입력에서 병합 결과 ID가 중복되거나 가상화 DOM 수가 메시지 수에 비례해 증가한다.

## 플랫폼 판정

2026-07-21 검증 호스트는 macOS다. 입력·다운로드는 Chromium 표준 API를 사용하고 단축키는 기존
플랫폼 분기 규칙을 유지하므로 Linux·Windows 전용 경로를 새로 만들지 않았다. 실제 Windows·Linux
패키지의 카메라·알림·다운로드 동작은 플랫폼 release job에서 계속 검증하며, 이 문서는 실행하지 않은
플랫폼을 수동 검증 완료로 주장하지 않는다.
