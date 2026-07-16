# 도메인 데이터 모델

## 목표

기능별 화면보다 먼저 공유 엔터티와 관계를 정의한다. 고객 요청에서 코드 변경과 청구 증빙까지
이어지는 관계가 데이터 모델에서 끊기지 않아야 한다.

table, tenant 복합 FK, index, RLS, migration과 로컬 SQLite의 물리 구현은
[데이터베이스 물리 설계](./30-database-physical-design.md)를 따른다.

## 최상위 관계

```text
Organization
├── Memberships, Teams, Roles, Permissions
├── Invitations and Authentication Policies
├── Subscription, Entitlements, Usage
├── Teams
│   ├── Work Item Workflows and Cycles
│   └── Backlog and Work Items
├── Initiatives and Projects
│   ├── Participating Teams and Organizations
│   ├── Milestones and Project Updates
│   ├── Delivery Workflows and Approvals
│   └── Repositories, Workspaces, Agent Sessions and Artifacts
├── Intake and Saved Views
├── Customer Accounts
│   ├── Contacts and Sites
│   ├── Opportunities, Quotes, Contracts
│   ├── Services and Assets
│   └── Service Tickets
│       ├── Conversations and Meetings
│       ├── Remote Sessions
│       ├── Work Logs and Time Entries
│       └── Code Changes and Knowledge Articles
└── Audit Events
```

## 조직과 사용자

| 엔터티 | 핵심 필드 |
|---|---|
| Organization | id, type, name, status, region, policySetId |
| User | id, primaryEmail, name, status |
| Identity | id, userId, type, issuer, subject, verifiedAt |
| Authenticator | id, userId, type, credentialId, secretRef, status, lastUsedAt |
| VerificationChallenge | id, userId, type, tokenHash, expiresAt, consumedAt |
| Device | id, userId, name, platform, trustState, lastSeenAt |
| AuthSession | id, userId, deviceId, refreshFamilyId, expiresAt, revokedAt |
| RefreshTokenFamily | id, sessionId, revokedAt, reuseDetectedAt |
| RefreshTokenRecord | id, familyId, tokenHash, issuedAt, usedAt, expiresAt |
| AuthenticationPolicy | id, organizationId, signupMode, mfaPolicy, sessionPolicy, federation |
| OrganizationInvitation | id, organizationId, email, roleId, scope, tokenHash, expiresAt, consumedAt |
| Team | id, organizationId, name, identifier, parentTeamId, defaultWorkflowDefinitionId, visibility, status |
| Membership | id, userId, organizationId, status, validUntil |
| TeamMembership | id, teamId, membershipId, role, status, validUntil |
| Role | id, organizationId, name, type, status |
| Permission | id, resource, action, riskLevel |
| RolePermission | roleId, permissionId |
| MembershipRole | membershipId, roleId, validUntil |
| ResourceGrant | subjectId, resourceType, resourceId, actions, effect, validUntil |
| ServicePrincipal | id, organizationId, name, status, ownerId |
| ApiCredential | id, principalId, secretHash, scopes, expiresAt, revokedAt |
| ClientInstallation | id, deviceId, appVersion, runtimeVersion, channel, capabilities, lastSeenAt |

`User`는 전역 사람 계정이고 `Membership`은 조직별 소속이다. 같은 사용자가 여러 조직에 속할 수
있지만 각 요청은 하나의 활성 조직을 선택한다. 외부 고객 사용자는 `ResourceGrant`로 지정
`CustomerAccount`와 하위 리소스에만 접근한다.

가입 시 각 사용자에게 `type=personal`인 기본 Organization을 만든다. 개인과 회사 공간은 같은
tenant·permission·Project 모델을 사용하며 nullable organization 예외를 만들지 않는다.

personal Organization에는 기본 Team도 하나 만든다. `Membership`은 조직 소속이고
`TeamMembership`은 한 조직 안의 복수 Team 참여를 표현한다. Team은 단순 조직도 항목이 아니라 업무
식별자, WorkItem Workflow와 Cycle의 소유자다.

## 구독과 Entitlement

| 엔터티 | 핵심 필드 |
|---|---|
| ProductPlan | id, code, version, deploymentModes, status |
| Subscription | id, organizationId, planId, status, period, graceUntil |
| Entitlement | id, subscriptionId, feature, limit, policy, validUntil |
| UsageMeter | id, organizationId, feature, window, quantity, sourceVersion |
| UsageReservation | id, organizationId, feature, amount, expiresAt, releasedAt |

Entitlement는 조직이 사용할 수 있는 제품 기능과 한도를 나타내며 사용자 권한을 대신하지 않는다.
동시 원격 세션처럼 경쟁이 있는 한도는 reservation으로 원자적으로 확보하고 종료·만료 시 반환한다.

## 고객과 계약

| 엔터티 | 핵심 필드 |
|---|---|
| CustomerAccount | id, organizationId, name, status, ownerUserId |
| CustomerSite | id, customerId, name, timezone, businessCalendarId |
| Contact | id, customerId, siteId, name, email, role |
| Opportunity | id, customerId, stage, amount, probability, expectedCloseAt |
| Quote | id, opportunityId, version, pricingModel, total, status |
| Contract | id, customerId, quoteId, type, period, amount, status |
| ContractLine | id, contractId, serviceType, quantity, rate, billingRule |

## 프로젝트 수행

| 엔터티 | 핵심 필드 |
|---|---|
| Initiative | id, organizationId, name, status, priority, health, ownerMembershipId, period, visibility |
| InitiativeProject | initiativeId, projectId, contributionType, sortKey, addedBy |
| Project | id, ownerOrganizationId, customerId, contractId, name, statusId, priority, health, leadMembershipId, period, visibility |
| ProjectTeam | projectId, teamId, role, joinedAt, leftAt |
| ProjectOrganizationRelation | projectId, organizationId, relation, status, validUntil |
| ProjectMembership | id, projectId, subjectId, role, status, validUntil |
| ProjectDependency | projectId, targetProjectId, type |
| Milestone | id, projectId, name, description, targetAt, status, sortKey |
| ProjectUpdate | id, projectId, period, health, summary, progress, risks, nextActions, visibility, revision |
| WorkItem | id, teamId, projectId, milestoneId, cycleId, parentId, type, title, workflowStateId, priority, estimate, assigneeId, dueAt, sortKey |
| WorkItemIdentifier | workItemId, teamId, sequence, displayKey, validFrom, validUntil, isPrimary |
| WorkItemParticipant | workItemId, subjectId, role, status |
| WorkItemDependency | workItemId, targetWorkItemId, type |
| WorkflowDefinition | id, organizationId, ownerType, ownerId, name, version, status |
| WorkflowState | id, definitionId, name, category, sortKey, status |
| ProjectWorkflowBinding | id, projectId, definitionId, definitionVersion, policySnapshot |
| WorkflowStageState | id, bindingId, stageKey, status, progress, version |
| Cycle | id, teamId, number, name, startsAt, endsAt, status, capacityPolicySnapshot |
| CycleWorkItem | cycleId, workItemId, addedAt, removedAt, rolloverFromCycleId |
| IntakeItem | id, organizationId, sourceType, sourceId, suggestedTeamId, suggestedProjectId, status, classification, visibility, deduplicationKey |
| IntakeResolution | id, intakeItemId, action, targetWorkItemId, canonicalIntakeItemId, actorId, decidedAt |
| SavedView | id, ownerMembershipId, resourceType, scopeType, scopeId, visibility, layout, filterDefinition, groupDefinition, sortDefinition, displayDefinition, schemaVersion |
| FavoriteView | savedViewId, membershipId, sortKey, isDefault |
| Requirement | id, projectId, source, version, priority, status |
| ChangeRequest | id, projectId, requirementId, impact, effort, cost, status |
| Risk | id, projectId, probability, impact, response, ownerId |
| Decision | id, projectId, summary, rationale, decidedAt, approverId |
| Deliverable | id, projectId, milestoneId, version, storageObjectId, status |
| Acceptance | id, deliverableId, customerContactId, decision, signedAt |
| TestCase | id, projectId, requirementId, expectedResult, status |
| TestRun | id, testCaseId, releaseId, result, evidenceObjectId |

모든 `WorkItem`은 하나의 Team을 가지며 Project 연결은 team backlog와 개인 업무를 위해 선택적일 수
있다. 고객 공개, Milestone, Delivery Workflow, AI ExecutionContext와 Project Artifact를 사용하려면
Project 연결이 필요하다. Project는 `ProjectTeam`을 통해 여러 Team이 함께 수행한다.

Team이 소유한 WorkItem Workflow와 Project가 소유한 Delivery Workflow를 분리한다. 전자는 Todo,
In Progress, Review 같은 실행 상태이고 후자는 내부 승인, 고객 승인, 잠금과 필수 Evidence를 다룬다.

Initiative는 Project를 목표에 따라 수동으로 묶는다. SavedView는 권한이 허용한 최신 resource를
filter로 동적으로 계산한다. Intake는 고객 요청, 외부 issue, 서비스 티켓과 미할당 AgentSession을
WorkItem으로 승격하기 전 검토하는 공통 inbox다. 상세 계약은
[프로젝트 실행 모델](./27-project-execution-model.md)을 따른다.

## 서비스와 자산

| 엔터티 | 핵심 필드 |
|---|---|
| Service | id, customerId, name, criticality, ownerTeamId |
| Asset | id, customerId, siteId, type, name, lifecycleStatus |
| AssetIdentity | assetId, agentId, hostname, platform, certificateId |
| ServiceDependency | upstreamServiceId, downstreamResourceType, resourceId |
| Monitor | id, resourceType, resourceId, checkType, policy, enabled |
| Alert | id, monitorId, severity, startedAt, resolvedAt, ticketId |

## 서비스 데스크

| 엔터티 | 핵심 필드 |
|---|---|
| Ticket | id, customerId, contractId, serviceId, assetId, type, severity, status |
| TicketParticipant | ticketId, subjectId, visibility |
| SlaPolicy | id, contractId, calendarId, targets |
| SlaClock | ticketId, metric, targetAt, pausedAt, breachedAt |
| WorkLog | id, ticketId, authorId, visibility, content, occurredAt |
| TimeEntry | id, projectId, ticketId, userId, duration, billable, status |
| Satisfaction | id, ticketId, contactId, score, comment |

## 개발과 배포

| 엔터티 | 핵심 필드 |
|---|---|
| RepositoryLink | id, projectId, provider, remoteUrl, defaultBranch |
| ExecutionWorkspace | id, projectId, workItemId, ticketId, hostId, repositoryId, status |
| WorktreeLink | id, executionWorkspaceId, pathRef, branch, baseRef |
| ExecutionContext | id, workspaceId, launchId, actorId, policySnapshot, issuedAt, expiresAt |
| AgentSession | id, provider, providerAccountScope, providerSessionId, hostId, status |
| SessionBinding | id, agentSessionId, projectId, workItemId, workspaceId, validFrom, validUntil |
| AgentRun | id, agentSessionId, workItemId, launchId, status, startedAt, finishedAt |
| AgentTurn | id, agentSessionId, runId, providerTurnKey, revision, status, contentObjectId |
| AgentEvent | id, sessionId, runId, turnId, streamId, sequence, source, assertion, type |
| Artifact | id, projectId, type, storageObjectId, contentHash, classification, visibility |
| ArtifactProvenance | artifactId, runId, sourceArtifactId, hostId, repositoryId, revision |
| EvidenceLink | id, resourceType, resourceId, artifactId, artifactVersion, purpose |
| CodeChange | id, workItemId, ticketId, provider, commitSha, reviewId |
| BuildRun | id, codeChangeId, provider, status, url, startedAt |
| CommandRun | id, projectId, workItemId, hostId, definitionId, definitionVersion, status |
| Release | id, projectId, version, environmentId, status, deployedAt |
| Deployment | id, releaseId, changeRequestId, environmentId, result |

로컬 절대 경로는 중앙 데이터베이스의 공유 식별자로 사용하지 않는다. `hostId`와 호스트가
해석하는 `pathRef`를 저장해 native, WSL, SSH 환경을 구분한다.

`AgentSession`은 provider 대화 identity이고 `AgentRun`은 특정 업무에서 수행한 실행 시도다.
`SessionBinding`은 세션을 다른 업무에 재분류해도 기존 event의 당시 문맥을 재현할 수 있도록 유효
시점을 가진다. Runtime의 orchestration task와 중앙 `WorkItem`은 별도 ID와 상태 머신을 사용한다.

## 협업과 원격지원

| 엔터티 | 핵심 필드 |
|---|---|
| Channel | id, scopeType, scopeId, visibility |
| Message | id, channelId, authorId, body, visibility, createdAt |
| Meeting | id, scopeType, scopeId, roomId, recordingPolicy, status |
| RemoteSession | id, ticketId, assetId, mode, status, policySnapshot |
| RemoteParticipant | sessionId, subjectId, role, access, joinedAt, leftAt |
| RemoteGrant | sessionId, subjectId, capability, grantedBy, expiresAt |
| SessionArtifact | id, sessionId, type, storageObjectId, retentionUntil |
| Invite | id, sessionId, tokenHash, access, expiresAt, consumedAt |

## 지식과 자동화

| 엔터티 | 핵심 필드 |
|---|---|
| KnowledgeArticle | id, scopeType, scopeId, version, visibility, status |
| KnowledgeSource | articleId, sourceType, sourceId |
| Runbook | id, scopeType, scopeId, version, riskLevel, status |
| AutomationRule | id, trigger, condition, action, enabled |
| AutomationRun | id, ruleId, targetType, targetId, status, approvalId |
| Approval | id, resourceType, resourceId, requesterId, approverId, decision |

## 거버넌스와 연동

| 엔터티 | 핵심 필드 |
|---|---|
| StorageObject | id, organizationId, classification, hash, scanStatus, retentionPolicyId |
| DataRetentionPolicy | id, organizationId, resourceType, duration, disposition |
| LegalHold | id, organizationId, scopeType, scopeId, reason, releasedAt |
| DeletionRequest | id, organizationId, subjectType, subjectId, status, result |
| DataExportJob | id, organizationId, scope, format, status, expiresAt |
| SearchProjection | id, sourceType, sourceId, permissionVersion, indexedAt |
| IntegrationConnection | id, organizationId, provider, scopes, secretRef, status |
| ExternalReference | id, connectionId, localType, localId, externalType, externalId |
| ImportJob | id, connectionId, mappingVersion, status, checkpoint, result |
| WebhookEndpoint | id, organizationId, url, events, secretRef, status |
| WebhookDelivery | id, endpointId, eventId, attempt, status, nextAttemptAt |
| NotificationDelivery | id, userId, channel, templateVersion, status, deliveredAt |

## 공통 필드

대부분의 중앙 엔터티는 다음 필드를 가진다.

- `id`: 정렬에 의존하지 않는 전역 고유 ID
- `organizationId`: 테넌트 격리 키
- `createdAt`, `createdBy`
- `updatedAt`, `updatedBy`
- `version`: 낙관적 동시성 제어
- `archivedAt`: 논리 보관
- `classification`: 데이터 등급

## 활동과 감사

업무 타임라인은 사용자 친화적인 `ActivityEvent`를 사용하고, 보안 감사는 삭제·수정이 제한된
`AuditEvent`를 사용한다. 같은 행위에서 두 이벤트가 생성될 수 있지만 목적과 보존정책은 다르다.

| 필드 | 설명 |
|---|---|
| eventId | 이벤트 고유 ID |
| schemaVersion | 이벤트 envelope 버전 |
| organizationId | 테넌트 |
| actor | 사용자, 서비스 계정, 에이전트 |
| action | 수행한 행위 |
| resource | 대상 유형과 ID |
| context | 고객, 프로젝트, 티켓, 세션 |
| host | native, WSL, SSH, Edge Agent 실행 위치 |
| source | hook, transcript, runtime, git, test, user |
| assertion | observed, declared, inferred |
| streamId, sequence | source stream의 순서와 누락 탐지 |
| correlationId | 하나의 업무 흐름을 연결하는 ID |
| outcome | 성공, 실패, 거부 |
| occurredAt | 서버 기준 시각 |

## 데이터 규칙

- 모든 고객 데이터 쿼리는 `organizationId`와 권한 범위를 포함한다.
- 원본 비밀번호, refresh token, 초대 토큰, 복구 코드는 저장하지 않고 검증 가능한 해시만 저장한다.
- 역할·grant·세션 변경은 버전 이벤트를 발행해 Main, Runtime, Relay의 권한 캐시를 무효화한다.
- entitlement와 사용량은 permission과 분리하고 같은 업무 요청에서 일관되게 판정한다.
- 검색 색인, 캐시, Webhook payload는 원본 엔터티의 권한·분류·삭제 이벤트를 상속한다.
- SavedView 공유는 resource grant를 만들지 않으며 authorization 후 filter를 적용한다.
- Initiative는 명시적 Project 관계이고 filter 결과를 자동으로 membership으로 저장하지 않는다.
- Intake accept는 WorkItem 생성·source binding과 resolution을 하나의 멱등 transaction으로 처리한다.
- 외부 import는 원본 ID와 mapping 버전을 보존해 재실행 시 중복을 방지한다.
- 내부 메모와 고객 공개 메시지는 같은 본문 필드의 UI 플래그만으로 구분하지 않는다.
- 승인 시점의 계약, 정책, 단가, 원격 권한은 스냅샷을 보존한다.
- 첨부와 녹화 본문은 Object Storage에 두고 DB에는 메타데이터와 해시를 저장한다.
- 서버 이벤트와 클라이언트 재시도는 멱등 키를 사용한다.
- 감사 이벤트는 원본 수정 대신 보정 이벤트를 추가한다.
- 경로·브랜치 기반 AI 세션 연결은 후보만 만들고 명시적 binding 없이 영구 확정하지 않는다.
- Agent event는 append-only로 저장하고 정정, redaction, 삭제는 별도 이벤트와 tombstone으로 표현한다.
- `observed`, `declared`, `inferred`를 구분하고 inferred data를 승인·완료의 단독 근거로 사용하지 않는다.
- 세션 전체 권한만으로 개별 turn·tool output·Artifact 공개 범위를 결정하지 않는다.
- raw transcript와 대형 tool output은 Object Storage에 두고 DB에는 chunk·hash·parser version을 저장한다.
