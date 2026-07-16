# 개발 Workspace

## 목표

기존 개발 기능을 보존하면서 프로젝트, 요구사항, 변경요청, 서비스 티켓과 직접 연결한다.
업무관리 화면과 IDE를 얕게 섞지 않고 문맥을 유지한 채 전환한다.

## Workspace 진입점

- 프로젝트 작업
- 요구사항
- 변경요청
- 결함
- 서비스 티켓
- 원격지원 세션
- 저장소 목록
- 빠른 열기

업무 엔터티에서 Workspace를 열면 고객사, 프로젝트, 작업 ID, 권한, 기준 브랜치, 실행 호스트를
세션 문맥으로 전달한다.

## 저장소와 Worktree

- 로컬, WSL, SSH 저장소
- 저장소 그룹과 프로젝트 연결
- 브랜치와 Worktree 생성
- 하나의 작업에 여러 병렬 Worktree
- 에이전트 결과 비교
- 선택 결과 병합
- Worktree 정리와 안전 검사
- Git 2.25 기준 호환 동작

## 편집과 탐색

- 파일 트리와 검색
- Monaco 기반 편집
- Markdown, 이미지, PDF 미리보기
- 자동 저장과 충돌 감지
- 파일·이미지를 에이전트에 전달
- 코드 심볼과 참조 탐색
- 로컬·원격 파일시스템 동일한 인터페이스

## 터미널과 실행

- 분할 터미널
- 스크롤백과 재연결
- 로컬, WSL, SSH, 원격 Runtime
- 명령 실행 위치 표시
- 작업·티켓별 터미널 세션 연결
- 프로세스 종료와 고아 세션 정리
- 포트 감지와 포워딩
- 실행 로그 증빙 저장

## AI 에이전트

- Codex, Claude Code와 다른 CLI 에이전트
- 병렬 실행과 오케스트레이션
- 프로젝트별 모델·도구 정책
- 고객 데이터 접근 범위
- 승인형 도구 실행
- 사용량과 비용 추적
- 작업 결과와 변경 파일 요약
- 테스트, 커밋, PR 설명 생성
- 실패한 작업 재실행과 이어서 수행

## AI 세션 기록과 동기화

- 업무에서 Workspace를 열 때 조직, 프로젝트, WorkItem, Workspace, host가 포함된 실행 문맥 발급
- Agent Hook으로 실시간 prompt, response, tool, subagent와 상태 경계 수집
- provider transcript parser로 Hook 누락과 앱 재시작 구간 보완
- Hook, transcript, Runtime, Git, test event의 source와 신뢰 수준 구분
- 세션, turn, tool output, Artifact별 classification과 visibility
- Node 내장 SQLite outbox, provider cursor, byte quota와 upload checkpoint
- network 중단 후 멱등 batch 재전송과 item별 server ack
- 앱 밖에서 발견한 세션의 `unassigned_agent_session` IntakeItem과 사용자 재분류
- 기록 끄기, metadata-only, 선택 기록, 전체 기록 정책과 지속 표시

MCP는 프로젝트·업무 조회와 변경, 산출물 등록을 위한 agent 도구로 사용한다. 모든 prompt와 response의
자동 수집은 MCP 호출에 의존하지 않고 Hook과 transcript reconciliation이 담당한다. 경로와 브랜치로
추론한 프로젝트는 추천일 뿐이며 사용자가 확인하지 않은 상태로 영구 연결하지 않는다.

## Git과 리뷰

- 변경 파일과 Diff
- 라인 주석과 에이전트 피드백
- 스테이징, 커밋, Push
- PR·MR 생성과 조회
- 리뷰, 승인, 상태 확인
- 충돌 해결
- CI 결과와 로그
- GitHub, GitLab, Bitbucket, Gitea, Azure DevOps를 공급자별로 분리

## 브라우저와 Design Mode

- 프로젝트별 브라우저 세션
- 쿠키와 저장소 프로필 격리
- 페이지 탐색과 개발자 진단
- 요소 선택, HTML·CSS·스크린샷 수집
- 에이전트 프롬프트로 전달
- 브라우저 다운로드와 파일 연결
- 원격 Workspace에서도 포트 포워딩을 통해 접근

## 업무 연결

- 커밋과 PR에 프로젝트·작업·티켓 참조
- 테스트 결과를 요구사항과 검수 항목에 첨부
- 배포를 변경요청과 연결
- 원격 세션에서 생성한 로그와 파일을 Workspace에 전달
- 해결된 티켓에서 지식문서 초안 생성
- 실제 작업시간을 공수 기록 후보로 제안

## 권한 규칙

- 고객과 게스트는 Workspace에 접근하지 않는다.
- 협력사는 지정 저장소와 브랜치만 접근한다.
- 로컬 권한과 원격 호스트 권한을 별도로 검사한다.
- 고객 데이터가 포함된 로그와 파일은 프로젝트 보안 정책을 따른다.

## P1 완료 기준

프로젝트 작업이나 티켓에서 격리된 Worktree를 만들고 에이전트로 수정·테스트한 뒤 PR을 생성하며,
해당 코드 변경과 실행 결과가 원래 업무 엔터티의 타임라인에 남아야 한다.

세션과 업무 연결, event envelope, MCP, 저장과 권한의 상세 기준은
[AI 작업 프로젝트 포털](./19-ai-project-portal.md)을 따른다.
