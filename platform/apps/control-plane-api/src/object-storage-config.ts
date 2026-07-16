import { createObjectStorage, type ObjectStorage } from '@pie/object-storage-adapter'

/**
 * Builds the object-storage client from env (SeaweedFS by default, ADR-0011).
 * Returns null when unconfigured so artifact routes stay unregistered rather than
 * failing at request time. Dev/test credentials are placeholders only.
 */
export function loadObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ObjectStorage | null {
  const endpoint = env.PIE_OBJECT_STORAGE_ENDPOINT
  const bucket = env.PIE_OBJECT_STORAGE_BUCKET
  const accessKeyId = env.PIE_OBJECT_STORAGE_ACCESS_KEY
  const secretAccessKey = env.PIE_OBJECT_STORAGE_SECRET_KEY
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null
  }
  return createObjectStorage({ endpoint, bucket, accessKeyId, secretAccessKey })
}
