import { createTenantObjectKeyBuilder, type ObjectStorage } from '@pie/object-storage-adapter'
import {
  claimMeetingDeletions,
  completeMeetingDeletion,
  listMeetingDeletionObjects,
  requeueMeetingDeletion,
  type ClaimedMeetingDeletion,
  type PieDatabase
} from '@pie/persistence'
import { createQueuePollingLoop, NOOP_LOGGER, type StructuredLogger } from './queue-polling-loop'

export type MeetingDeletionSummary = {
  claimed: number
  completed: number
  requeued: number
  failed: number
}

export function createMeetingRetentionDeletionLoop(options: {
  db: PieDatabase
  objectStorage: ObjectStorage
  workerId: string
  batchSize: number
  leaseMs: number
  pollIntervalMs: number
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
  logger?: StructuredLogger
  onBatchProcessed?: (summary: MeetingDeletionSummary) => void
}) {
  const logger = options.logger ?? NOOP_LOGGER

  const process = async (job: ClaimedMeetingDeletion): Promise<void> => {
    const objects = await listMeetingDeletionObjects(options.db, job.organizationId, job.meetingId)
    const keys = createTenantObjectKeyBuilder(job.organizationId)
    await Promise.all([
      ...objects.recordingObjectIds.map((objectId) =>
        options.objectStorage.deleteObject(`${keys.keyForObject('recordings', objectId)}.mp4`)
      ),
      ...objects.transcriptionObjectIds.map((objectId) =>
        options.objectStorage.deleteObject(`${keys.keyForObject('transcripts', objectId)}.mp3`)
      )
    ])
    const completed = await completeMeetingDeletion(options.db, job)
    if (!completed) throw new Error('meeting deletion lease was lost or placed on legal hold')
  }

  const runOnce = async (): Promise<MeetingDeletionSummary> => {
    const jobs = await claimMeetingDeletions(options.db, {
      workerId: options.workerId,
      batchSize: options.batchSize,
      leaseMs: options.leaseMs
    })
    const summary: MeetingDeletionSummary = {
      claimed: jobs.length,
      completed: 0,
      requeued: 0,
      failed: 0
    }
    for (const job of jobs) {
      try {
        await process(job)
        summary.completed += 1
        logger.info(
          { event: 'meeting.deletion.completed', meetingId: job.meetingId },
          'meeting retention deletion completed'
        )
      } catch (error) {
        const terminal = job.attempts >= options.maxAttempts
        const delay = Math.min(
          options.maxBackoffMs,
          options.baseBackoffMs * 2 ** Math.max(0, job.attempts - 1)
        )
        await requeueMeetingDeletion(options.db, {
          ...job,
          error: error instanceof Error ? error.message : String(error),
          retryAt: new Date(Date.now() + delay),
          terminal
        })
        summary[terminal ? 'failed' : 'requeued'] += 1
        logger.warn(
          {
            event: terminal ? 'meeting.deletion.failed' : 'meeting.deletion.requeued',
            meetingId: job.meetingId,
            error: String(error)
          },
          'meeting retention deletion attempt failed'
        )
      }
    }
    options.onBatchProcessed?.(summary)
    return summary
  }

  const loop = createQueuePollingLoop({
    tick: runOnce,
    pollIntervalMs: options.pollIntervalMs,
    loopName: 'meeting-retention-deletion',
    logger
  })
  return { runOnce, start: loop.start, stop: loop.stop }
}
