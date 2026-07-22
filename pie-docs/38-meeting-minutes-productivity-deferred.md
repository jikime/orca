# 회의록 생산성 보류 설계

## 문서 상태

- 기준일: 2026-07-21
- 상태: `개발 보류`
- 대상: 회의 제품 로드맵의 M6 회의록 생산성

현재 회의 기능은 영상·음성·화면 공유, 녹화·전사, 결정·후속 조치, Recap과 업무
문맥 연결을 기준선으로 유지한다. 이 문서의 기능은 다른 메뉴 개발을 우선하기 위해
즉시 구현하지 않는다. 문서에 기록된 항목을 구현 완료로 해석하지 않는다.

## 보류 범위

1. 회의 유형별 회의록 template과 조직 custom instruction
2. 요약 길이·섹션·언어·수신자 정책
3. 전사 revision을 기준으로 한 재생성·버전 비교
4. 회의 중 권한이 있는 사용자의 `지금까지 요약`
5. 단일 회의 Q&A와 follow-up email 초안
6. PDF·DOCX·Markdown·JSON·SRT export
7. 녹화 chapter·highlight·clip과 만료되는 공유 링크

## 재개 순서

| 순서 | Slice | 산출물 | 필수 gate |
| --- | --- | --- | --- |
| 1 | M6-S1 template authority | template·instruction schema, 버전, 조직 정책 | prompt injection 방어, 권한, immutable version |
| 2 | M6-S2 generation history | 재생성, 버전 비교, provenance | transcript revision·model·prompt version 추적 |
| 3 | M6-S3 live catch-up | 회의 중 중간 요약 | 동의·guest visibility·삭제 전파 |
| 4 | M6-S4 grounded assistance | 단일 회의 Q&A, follow-up 초안 | 모든 주장의 segment 근거, 사람 검토 |
| 5 | M6-S5 controlled export | PDF·DOCX·Markdown·SRT | 수신자 정책, watermark, export 감사 |
| 6 | M6-S6 chapters and clips | chapter·highlight·clip | 원본 권한, 만료·회수, redaction 연동 |

## 재개 전 결정할 항목

- transcript correction 시 기존 요약을 `stale`로 자동 전환할지
- 조직 instruction과 사용자 instruction의 우선순위
- 수신자 기본값과 외부 수신자 승인 정책
- 지원 언어, 번역 provider, 데이터 처리 지역
- clip이 원본 보존·삭제·legal hold를 따르는 방식
- email 초안을 Pie 내부 문서로만 남길지, 외부 발송까지 포함할지

## 비범위

- 사람의 승인 없이 외부 email을 발송하거나 업무 상태를 변경하지 않는다.
- 감정·발언량·코칭 점수를 개인 평가에 사용하지 않는다.
- 복수 회의 지식 검색과 자동 브리핑은 M7이며 이 문서에 포함하지 않는다.
- 외부 회의 notetaker bot과 연결 제품 자동 가입은 별도 정책 및 entitlement 검토 대상이다.

## 재개 조건

다른 핵심 메뉴의 사용자 흐름이 안정된 후 명시적 제품 우선순위가 부여될 때만 M6를
재개한다. 재개 시 [회의·회의록 제품 로드맵](./35-meeting-product-roadmap.md)의 현재 구현 기준과
거버넌스 gate를 다시 검증한다.
