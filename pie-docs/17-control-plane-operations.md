# Control Plane 운영

## 목표

Control Plane을 단순 API 서버가 아니라 identity 연동, 테넌트 데이터, 실시간 이벤트, 작업 큐, 파일,
Relay 제어를 책임지는 운영 제품으로 설계한다. 기능 출시 전에 관측, 복구, 배포, 보안 사고 대응의
최소 경로를 확보한다.

## 서비스 구성

```text
Public Edge
├── API Gateway and Rate Limiter
├── Keycloak and Pie Auth Utility Pages
└── Realtime Gateway

Control Plane
├── Identity Adapter and Pie Authorization
├── Domain API
├── Agent Event Ingest and Projection
├── Job Workers and Scheduler
├── Notification Delivery
├── Relay and Media Control
└── Audit Pipeline

Data Plane
├── Pie and Keycloak PostgreSQL databases
├── S3-compatible Object Storage and Quarantine
├── PostgreSQL Outbox and Operations
├── Derived Search Projection
└── Observability Backend
```

Control Plane은 Fastify 모듈형 모놀리스와 별도 API·Worker process로 시작한다. 인증, 도메인 API,
비동기 작업, 실시간 연결, Relay 스트림의 책임과 용량 지표는 분리해 이후 독립 확장이 가능해야 한다.
상세 topology와 optional profile은 [Reference Architecture v1](./32-reference-architecture-v1.md)을 따른다.

## 테넌트와 서비스 신원

- 모든 요청과 작업에 검증된 `organizationId` 문맥 전달
- DB 쿼리와 Object Storage key에 테넌트 경계 포함
- 사용자, 서비스, Worker, Relay, Edge Agent를 서로 다른 신원으로 관리
- 서비스 간 최소 scope 자격증명과 정기 회전
- Edge Agent 인증서 발급, 갱신, 폐기, 복제 감지
- 운영자 접근의 승인, 기간 제한, 명령·조회 감사
- 네트워크 위치만으로 내부 요청을 신뢰하지 않음

서비스와 기기 신원을 포함한 접근 정책은 네트워크 내부 여부를 신뢰 근거로 삼지 않는
[NIST Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)의 원칙을 따른다.

## 이벤트와 비동기 작업

- DB 변경과 이벤트 발행 사이의 유실을 막는 transactional outbox
- 소비자의 멱등 키와 처리 체크포인트
- 재시도 횟수, 지수 backoff, timeout, 취소
- 재처리 불가 작업의 dead-letter queue와 관리자 재실행
- 이벤트 이름, 버전, 행위자, 테넌트, correlation ID
- agent event stream ID, source sequence, item별 ack와 permanent·retryable reject
- 구버전 소비자를 위한 이벤트 스키마 호환 정책
- 예약 작업의 시간대, 중복 실행, leader 선출 정책
- malformed·unknown provider event를 격리하고 정상 event 처리를 계속하는 quarantine

메일, Webhook, 검색 색인, 보고서, AI 요약, 녹화 후처리는 사용자 요청 트랜잭션 안에서 직접
완료하려 하지 않고 영속 작업으로 전환한다.

## 관측성

로그, 메트릭, trace를 같은 서비스·테넌트·요청·작업·세션 correlation ID로 연결한다.

| 신호 | 필수 항목 |
|---|---|
| 로그 | 구조화 이벤트, 수준, 서비스, 결과, 오류 코드, 민감정보 마스킹 |
| 메트릭 | 요청률·오류율·지연, 큐 적체, ingest·reconcile lag, DB, Realtime, Relay, SFU, 저장공간 |
| Trace | Electron 요청부터 API, DB, Worker, Relay 제어까지의 흐름 |
| 클라이언트 진단 | 앱 버전, OS, Runtime 상태, 재연결, crash fingerprint |

- 조직별 업무 데이터와 토큰을 관측 백엔드 label에 넣지 않는다.
- 사용자에게 영향을 주는 SLO와 내부 용량 지표를 분리한다.
- 고객 데이터 조회가 필요한 운영 진단은 별도 승인과 감사를 요구한다.
- 경보는 담당자와 Runbook, 최근 배포, 관련 대시보드에 연결한다.

신호의 공통 의미와 전파는 [OpenTelemetry Signals](https://opentelemetry.io/docs/concepts/signals/)를
기준으로 한다.

## SLO와 용량

- 로그인과 권한 판정 성공률·지연
- Control Plane API 가용성과 쓰기 지연
- Realtime 메시지 전달 지연과 재연결 성공률
- Relay 연결 성공률, RTT, throughput, 중단률
- SFU 참여 성공률과 미디어 품질
- 작업 큐 대기시간과 실패율
- agent event ingest ack 지연, sequence gap, parser unknown record와 transcript reconcile 지연
- 조직별 outbox·Object Storage 사용량과 capture quota 도달률
- 검색 색인 지연과 권한 회수 반영시간
- 백업 성공률과 복원 검증 시각

기능별 목표값은 트래픽과 계약 등급을 확인한 뒤 정한다. 처음부터 다중 리전을 전제하지 않고 단일
리전·다중 가용영역과 검증된 복구 절차를 먼저 완성한다.

## 백업과 재해 복구

| 데이터 | 복구 고려사항 |
|---|---|
| PostgreSQL | 시점 복구, 테넌트 관계 일관성, 암호화 키 |
| Keycloak database | realm·client·identity·credential 복구, Pie issuer·subject mapping 대조 |
| Object Storage | 버전, 삭제 보호, transcript chunk·녹화·산출물 보존 |
| Search Index | 원본 DB와 Object Storage에서 재생성 가능 |
| Queue | 영속 작업과 멱등 재실행, 임시 전송 버퍼 구분 |
| Audit Store | 변경 방지, 별도 보존, 복구 후 연속성 검증 |

- 데이터 등급별 RPO와 RTO 정의
- 자동 백업과 별도 계정·리전 복제
- 키와 설정, IaC, 비밀 복구 절차 포함
- 정기 restore drill과 결과·소요시간 기록
- 부분 테넌트 복원과 전체 서비스 복구 절차 분리
- 복구 후 중복 이벤트, 권한, 토큰, Agent 연결 검증
- projection 재생성 후 session binding, turn revision, Artifact hash와 삭제 tombstone 대조

계획 수립은 [NIST SP 800-34 Rev. 1](https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final)의
업무 영향 분석과 복구 우선순위 원칙을 참고한다.

## 이메일과 알림 전달

- 메일 공급자 추상화와 환경별 발신 도메인 분리
- Keycloak의 가입·확인·재설정과 Pie의 초대·보안 경고 템플릿을 구분해 버전 관리
- 영속 발송 큐, 재시도, 중복 방지
- bounce, complaint, suppression 목록 처리
- DKIM, SPF, DMARC와 발신 평판 모니터링
- 원본 토큰을 메일 본문 외 로그와 이벤트에 기록하지 않음
- 앱 내·OS·이메일·메신저 알림의 사용자 선호와 긴급도 정책

보안 메일 전달 실패는 일반 알림 실패와 분리해 운영자와 사용자에게 복구 방법을 제공한다.

## 배포와 데이터베이스 변경

PostgreSQL role, schema, RLS, index와 migration 실행 규칙은
[데이터베이스 물리 설계](./30-database-physical-design.md)와
[`ADR-0005`](../docs/adr/0005-control-plane-persistence.md)를 따른다.

- 개발, 검증, 운영 환경과 계정·키·데이터 분리
- Infrastructure as Code와 재현 가능한 배포
- schema 변경은 expand → backfill → switch → contract 순서 적용
- 구버전 Electron과 Worker가 남아 있는 동안 호환되는 DB·이벤트 계약 유지
- canary와 단계적 배포, 자동 health gate
- 배포 실패 시 코드 롤백과 데이터 보정 절차 분리
- 운영 feature flag의 소유자, 만료일, 감사 기록

## 보안 운영

- 위협 모델과 데이터 흐름도를 릴리스마다 갱신
- 의존성, 컨테이너, IaC, 비밀, SBOM 검사
- 취약점 접수 채널과 심각도별 수정 기한
- 인증·권한·Relay 이상 징후와 토큰 재사용 경보
- break-glass 계정은 오프라인 보관, 이중 승인, 사용 즉시 경보
- 운영자 작업 기록과 정기 접근권한 검토
- 사고 타임라인, 고객 통지, 증거 보존 Runbook

개발 수명주기 기준은 [NIST SSDF](https://csrc.nist.gov/pubs/sp/800/218/final)를 따른다.

## 온프레미스 운영

Desktop bootstrap URL, Docker internal/public endpoint와 discovery health는
[SaaS·Self-hosted 배포와 Instance 연결](./31-deployment-and-instance-connections.md)을 따른다.

- 지원하는 단일 노드와 고가용성 토폴로지 명시
- 고객 관리형 PostgreSQL·Object Storage 지원 범위
- 폐쇄망 이미지와 업데이트 bundle 서명 검증
- 라이선스 검증의 오프라인 유예와 감사
- 백업 위치, KMS, 메일·SSO·프록시 연동 점검
- 익명화된 진단 번들의 수동 반출
- Control Plane과 Edge Agent의 지원 버전 행렬

## 완료 기준

- 한 사용자 요청을 Electron부터 API, DB, Worker까지 trace할 수 있다.
- 메일·Webhook·검색 작업이 재시도와 중복 상황에서도 한 번의 업무 결과만 만든다.
- 테넌트를 바꾼 서비스 자격증명과 직접 DB 요청이 차단된다.
- 정의된 RPO·RTO 안에서 백업을 별도 환경에 복원하고 결과를 검증한다.
- 구버전 앱이 있는 상태에서 무중단 schema 변경과 롤백을 수행한다.
- 운영자 break-glass 사용과 고객 데이터 조회가 즉시 감사·경보된다.
