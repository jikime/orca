import { createObjectStorage } from '@pie/object-storage-adapter'
import { createDatabase, createDatabasePool, pingDatabase } from '@pie/persistence'
import pino from 'pino'
import { loadWorkerConfig } from './config'
import { createOutboxClaimLoop, type OutboxBatchSummary } from './outbox-claim-loop'
import { startWorker } from './worker-runtime'
import { createMeetingAiClient } from './meeting-ai-client'
import { createMeetingProcessingLoop } from './meeting-processing-loop'
import { createMeetingRetentionDeletionLoop } from './meeting-retention-deletion-loop'

async function main(): Promise<void> {
  const config = loadWorkerConfig()
  const logger = pino({ base: { service: config.serviceName, workerId: config.workerId } })
  const pool = createDatabasePool({ connectionString: config.databaseUrl })
  const db = createDatabase(pool)
  const runtime = await startWorker({
    ping: () => pingDatabase(pool),
    heartbeatIntervalMs: config.heartbeatIntervalMs
  })

  // Running totals emitted as a periodic structured metrics line.
  const totals: OutboxBatchSummary = {
    claimed: 0,
    published: 0,
    alreadyPublished: 0,
    requeued: 0,
    parked: 0
  }
  const claimLoop = createOutboxClaimLoop({
    db,
    workerId: config.workerId,
    batchSize: config.batchSize,
    leaseMs: config.leaseMs,
    pollIntervalMs: config.pollIntervalMs,
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
    logger,
    onBatchProcessed: (summary) => {
      totals.claimed += summary.claimed
      totals.published += summary.published
      totals.alreadyPublished += summary.alreadyPublished
      totals.requeued += summary.requeued
      totals.parked += summary.parked
    }
  })
  claimLoop.start()
  const meetingStorage = config.meetingStorage ? createObjectStorage(config.meetingStorage) : null
  await meetingStorage?.ensureBucket()
  const meetingLoop =
    config.meetingProcessing && meetingStorage
      ? createMeetingProcessingLoop({
          db,
          objectStorage: meetingStorage,
          ai: createMeetingAiClient({
            apiKey: config.meetingProcessing.openAiApiKey,
            baseUrl: config.meetingProcessing.openAiBaseUrl,
            transcriptionModel: config.meetingProcessing.transcriptionModel,
            minutesModel: config.meetingProcessing.minutesModel
          }),
          workerId: config.workerId,
          batchSize: Math.min(config.batchSize, 4),
          leaseMs: Math.max(config.leaseMs, 600_000),
          pollIntervalMs: config.pollIntervalMs,
          maxAttempts: config.maxAttempts,
          baseBackoffMs: config.baseBackoffMs,
          maxBackoffMs: config.maxBackoffMs,
          logger
        })
      : null
  meetingLoop?.start()
  const meetingDeletionLoop = meetingStorage
    ? createMeetingRetentionDeletionLoop({
        db,
        objectStorage: meetingStorage,
        workerId: config.workerId,
        batchSize: Math.min(config.batchSize, 8),
        leaseMs: Math.max(config.leaseMs, 120_000),
        pollIntervalMs: config.pollIntervalMs,
        maxAttempts: config.maxAttempts,
        baseBackoffMs: config.baseBackoffMs,
        maxBackoffMs: config.maxBackoffMs,
        logger
      })
    : null
  meetingDeletionLoop?.start()
  if (!meetingLoop) {
    logger.warn(
      { event: 'meeting.processing.disabled' },
      'meeting transcription and AI minutes are disabled until storage and OpenAI are configured'
    )
  }

  const metricsTimer = setInterval(() => {
    logger.info({ metric: 'worker.outbox_totals', ...totals }, 'worker metrics')
  }, config.metricsIntervalMs)
  if (typeof metricsTimer === 'object' && 'unref' in metricsTimer) {
    metricsTimer.unref()
  }

  const close = async (): Promise<void> => {
    clearInterval(metricsTimer)
    claimLoop.stop()
    meetingLoop?.stop()
    meetingDeletionLoop?.stop()
    await runtime.stop()
    // Kysely.destroy() ends the underlying pool, so we do not end it separately.
    await db.destroy()
  }
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)))
  process.on('SIGINT', () => void close().finally(() => process.exit(0)))
}

main().catch((error) => {
  console.error('[control-plane-worker] failed to start', error)
  process.exit(1)
})
