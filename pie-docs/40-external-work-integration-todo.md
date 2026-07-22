# 외부 업무 연동 TODO

## 문서 상태

- 기준일: 2026-07-21
- 상태: `개발 보류`
- 대상: GitHub·GitLab·Linear·Jira의 외부 issue와 Pie WorkItem 연결

프로젝트·작업·Workspace 통합의 P1부터 P4까지를 현재 기준선으로 유지한다. 외부 업무 연동은 다른
핵심 메뉴 개발을 우선하기 위해 지금 구현하지 않는다. 이 문서의 계약과 작업 목록을 구현 완료로
해석하지 않는다.

## 대상 범위

- GitHub Issue
- GitLab Issue
- Linear Issue
- Jira Issue
- 외부 연결의 권한 만료, 삭제, rate limit과 동기화 지연 상태

Pull Request, Merge Request, commit과 test 결과는 외부 업무 자체가 아니라 WorkItem의 실행 결과로
분류하며 [프로젝트·작업·Workspace 통합](./39-project-workspace-integration.md)의 P6에서 별도로 다룬다.

## 유지할 원칙

1. Pie WorkItem과 외부 issue는 서로 다른 원본이다. 제목이나 URL로 같은 업무라고 추정하지 않는다.
2. 연결과 연결 해제는 사용자의 명시적인 동작으로만 수행한다.
3. provider별 필드를 WorkItem에 직접 추가하지 않고 provider-neutral `ExternalReference`로 분리한다.
4. 외부 상태는 프로젝트별 mapping 정책이 있을 때만 WorkItem 상태 변경을 제안한다.
5. 외부 업무의 완료·삭제만으로 Pie WorkItem을 자동 완료하거나 삭제하지 않는다.
6. 같은 외부 resource의 중복 연결과 재시도 중복 생성을 막는다.
7. GitHub 전용 명칭이나 동작을 공통 issue·review 계약에 사용하지 않는다.

## 계약 초안 TODO

`ExternalReference`는 최소한 다음 정보를 보존해야 한다.

```text
ExternalReference
- id
- organizationId
- workItemId
- provider
- connectionId
- resourceKind
- externalId
- externalKey
- externalUrl
- repositoryOrProjectId
- stateSnapshot
- syncStatus
- lastSyncedAt
- version
- createdBy / createdAt / updatedAt
```

- `provider + connectionId + resourceKind + externalId` 조합의 조직 내 유일성 결정
- issue 이동·저장소 이전·key 변경에도 유지되는 provider 불변 ID 확인
- 연결 해제 후 감사 이력과 tombstone 보존 기간 결정
- 외부 제목·상태·담당자 snapshot의 갱신 범위와 개인정보 보존 정책 결정
- GitHub·GitLab·Linear·Jira별 API capability와 최소 지원 버전 조사

## 재개 순서

| 순서 | Slice           | 산출물                                                      | 필수 gate                                 |
| ---- | --------------- | ----------------------------------------------------------- | ----------------------------------------- |
| 1    | E1 계약과 ADR   | ExternalReference schema, provider capability 표, 권위 원칙 | 중복 식별자, tenant 격리, provider 중립성 |
| 2    | E2 저장·API     | migration, link/unlink/list API, activity·audit             | 권한, 멱등성, OCC, 삭제 복구              |
| 3    | E3 WorkItem UI  | 외부 업무 검색·연결·열기·해제                               | 연결 확인, 오류 복구, 접근성              |
| 4    | E4 외부 업무 UI | 외부 issue에서 연결된 Pie WorkItem 열기                     | provider별 권한, 연결 누락 처리           |
| 5    | E5 동기화 상태  | webhook·poll reconciliation, 지연·rate limit·삭제 표시      | outbox, retry, dead letter, 관측성        |
| 6    | E6 상태 mapping | 프로젝트별 opt-in mapping과 변경 제안                       | 사람 승인, loop 방지, 감사 이력           |

## 검증 TODO

- 같은 외부 issue를 반복 연결해도 reference가 하나만 생성된다.
- 서로 다른 provider나 connection에서 같은 문자열 key를 사용해도 충돌하지 않는다.
- 연결 권한과 외부 issue 열람 권한을 각각 검증한다.
- 외부 API 장애와 rate limit 중에도 기존 Pie WorkItem을 정상적으로 사용할 수 있다.
- webhook 중복·역순·유실을 reconciliation으로 복구한다.
- provider 연결 해제 후 credential과 외부 상세정보가 UI에 노출되지 않는다.
- GitHub와 GitLab의 issue·review 용어 차이가 공통 계약을 오염시키지 않는다.
- macOS·Linux·Windows와 로컬·WSL·SSH Workspace에서 동일한 연결을 연다.

## 비범위

- 외부 issue를 자동으로 Pie WorkItem으로 복제하지 않는다.
- 외부 issue와 Pie WorkItem의 상태를 기본적으로 양방향 동기화하지 않는다.
- PR·MR, commit, test, Artifact 연결은 이 문서에서 구현하지 않는다.
- provider가 지원하지 않는 기능을 Pie가 지원하는 것처럼 흉내 내지 않는다.

## 재개 조건

프로젝트와 다른 핵심 메뉴의 사용자 흐름이 정리된 뒤 외부 업무 연결에 명시적인 제품 우선순위가
부여될 때 재개한다. 재개 시 provider별 API·권한·rate limit의 최신 상태를 다시 조사하고, E1 계약과
ADR부터 확정한 후 코드를 작성한다.
