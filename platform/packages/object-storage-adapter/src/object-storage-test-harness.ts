import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { createObjectStorage } from './object-storage-client'

export type ObjectStorageHarness = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  backend: 'seaweedfs' | 'minio'
  stop: () => Promise<void>
}

async function verifyS3Works(
  harness: Omit<ObjectStorageHarness, 'stop' | 'backend'>
): Promise<void> {
  const storage = createObjectStorage(harness)
  await storage.ensureBucket()
  await storage.putObject('healthcheck/probe', 'ok', 'text/plain')
  const head = await storage.head('healthcheck/probe')
  if (!head.exists) {
    throw new Error('S3 backend HEAD failed after PUT')
  }
}

async function startSeaweed(): Promise<ObjectStorageHarness> {
  const container: StartedTestContainer = await new GenericContainer('chrislusf/seaweedfs:3.80')
    .withCommand(['server', '-s3', '-ip.bind=0.0.0.0'])
    // The harness stores only tiny fixtures; tmpfs avoids orphaning the image's
    // anonymous /data volume and keeps low-disk developer machines reliable.
    .withTmpFs({ '/data': 'rw,size=128m' })
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(60_000)
    .start()
  const base = {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8333)}`,
    bucket: 'pie-artifacts',
    // SeaweedFS S3 without a config file accepts any credentials.
    accessKeyId: 'pie',
    secretAccessKey: 'pie-secret'
  }
  try {
    await verifyS3Works(base)
  } catch (error) {
    await container.stop()
    throw error
  }
  return { ...base, backend: 'seaweedfs', stop: async () => void (await container.stop()) }
}

async function startMinio(): Promise<ObjectStorageHarness> {
  const container: StartedTestContainer = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withTmpFs({ '/data': 'rw,size=128m' })
    .withEnvironment({ MINIO_ROOT_USER: 'pie', MINIO_ROOT_PASSWORD: 'pie-secret' })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .withStartupTimeout(60_000)
    .start()
  const base = {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    bucket: 'pie-artifacts',
    accessKeyId: 'pie',
    secretAccessKey: 'pie-secret'
  }
  await verifyS3Works(base)
  return { ...base, backend: 'minio', stop: async () => void (await container.stop()) }
}

/**
 * Starts an ephemeral S3-compatible backend for tests. Prefers SeaweedFS (the
 * production default, ADR-0011) and falls back to MinIO if the SeaweedFS gateway
 * does not come up cleanly in a container — the adapter code is identical either
 * way. Throws if Docker is unavailable (callers skip with an explicit reason).
 */
export async function startObjectStorageHarness(): Promise<ObjectStorageHarness> {
  try {
    return await startSeaweed()
  } catch {
    return await startMinio()
  }
}
