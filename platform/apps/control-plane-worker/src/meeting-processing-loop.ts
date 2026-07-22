import { createTenantObjectKeyBuilder, type ObjectStorage } from '@pie/object-storage-adapter'
import {
  claimMeetingProcessingJobs,
  completeMeetingSummarizationJob,
  completeMeetingTranscriptionJob,
  getMeetingProcessingTranscript,
  requeueMeetingProcessingJob,
  type ClaimedMeetingProcessingJob,
  type PieDatabase
} from '@pie/persistence'
import { renderMeetingMinutes, type MeetingAiClient } from './meeting-ai-client'
import { createQueuePollingLoop, NOOP_LOGGER, type StructuredLogger } from './queue-polling-loop'

export type MeetingProcessingSummary = {
  claimed: number
  completed: number
  requeued: number
  failed: number
}

export function createMeetingProcessingLoop(options: {
  db: PieDatabase
  objectStorage: ObjectStorage
  ai: MeetingAiClient
  workerId: string
  batchSize: number
  leaseMs: number
  pollIntervalMs: number
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
  logger?: StructuredLogger
  onBatchProcessed?: (summary: MeetingProcessingSummary) => void
}) {
  const logger = options.logger ?? NOOP_LOGGER

  const process = async (job: ClaimedMeetingProcessingJob): Promise<void> => {
    if (job.jobType === 'transcribe') {
      const key = `${createTenantObjectKeyBuilder(job.organizationId).keyForObject(
        'transcripts',
        job.recordingId
      )}.mp3`
      const audio = await options.objectStorage.getObjectBytes(key)
      const transcript = await options.ai.transcribe(audio, `${job.recordingId}.mp3`)
      const completed = await completeMeetingTranscriptionJob(options.db, {
        organizationId: job.organizationId,
        jobId: job.id,
        workerId: job.workerId,
        content: transcript.text,
        segments: transcript.segments,
        language: transcript.language
      })
      if (!completed) throw new Error('transcription job lease was lost')
      return
    }
    if (!job.transcriptId) throw new Error('summarization job has no transcript')
    const transcript = await getMeetingProcessingTranscript(
      options.db,
      job.organizationId,
      job.transcriptId
    )
    if (!transcript?.content) throw new Error('summarization transcript is unavailable')
    const draft = await options.ai.draftMinutes(transcript.content)
    const completed = await completeMeetingSummarizationJob(options.db, {
      organizationId: job.organizationId,
      jobId: job.id,
      workerId: job.workerId,
      summary: renderMeetingMinutes(draft),
      decisions: draft.decisions,
      actionItems: draft.actionItems
    })
    if (!completed) throw new Error('summarization job lease was lost')
  }

  const runOnce = async (): Promise<MeetingProcessingSummary> => {
    const jobs = await claimMeetingProcessingJobs(options.db, {
      workerId: options.workerId,
      batchSize: options.batchSize,
      leaseMs: options.leaseMs
    })
    const summary: MeetingProcessingSummary = {
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
          { event: 'meeting.processing.completed', jobId: job.id, jobType: job.jobType },
          'meeting processing completed'
        )
      } catch (error) {
        const terminal = job.attempts >= options.maxAttempts
        const delay = Math.min(
          options.maxBackoffMs,
          options.baseBackoffMs * 2 ** Math.max(0, job.attempts - 1)
        )
        await requeueMeetingProcessingJob(options.db, {
          organizationId: job.organizationId,
          jobId: job.id,
          workerId: job.workerId,
          error: error instanceof Error ? error.message : String(error),
          retryAt: new Date(Date.now() + delay),
          terminal
        })
        summary[terminal ? 'failed' : 'requeued'] += 1
        logger.warn(
          {
            event: terminal ? 'meeting.processing.failed' : 'meeting.processing.requeued',
            jobId: job.id,
            jobType: job.jobType,
            error: String(error)
          },
          'meeting processing attempt failed'
        )
      }
    }
    options.onBatchProcessed?.(summary)
    return summary
  }

  const loop = createQueuePollingLoop({
    tick: runOnce,
    pollIntervalMs: options.pollIntervalMs,
    loopName: 'meeting-processing',
    logger
  })
  return { runOnce, start: loop.start, stop: loop.stop }
}
