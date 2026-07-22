import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// A thin S3-compatible client. The default backend is SeaweedFS (ADR-0011); the
// same interface works against MinIO or AWS S3 unchanged. path-style addressing is
// the default because SeaweedFS/MinIO do not do virtual-host buckets.
export type ObjectStorageConfig = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  forcePathStyle?: boolean
}

export type PresignPutOptions = {
  contentType: string
  expiresInSeconds?: number
}

export type ObjectHeadResult =
  | { exists: false }
  | { exists: true; sizeBytes: number; contentType: string | null }

export type PresignGetOptions = {
  expiresInSeconds?: number
}

export type ObjectStorage = {
  presignPut: (storageKey: string, options: PresignPutOptions) => Promise<string>
  // Short-lived download URL. Re-issued through the caller's access gate each time,
  // so a revoked member simply stops being able to obtain one (same property as R2).
  presignGet: (storageKey: string, options?: PresignGetOptions) => Promise<string>
  head: (storageKey: string) => Promise<ObjectHeadResult>
  getObjectBytes: (storageKey: string) => Promise<Uint8Array>
  deleteObject: (storageKey: string) => Promise<void>
  ensureBucket: () => Promise<void>
  // Dev/test convenience: production clients upload via the presigned URL.
  putObject: (storageKey: string, body: Uint8Array | string, contentType: string) => Promise<void>
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404
}

function isBucketAlreadyOwned(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists'
}

export function createObjectStorage(config: ObjectStorageConfig): ObjectStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle ?? true
  })

  return {
    presignPut: (storageKey, options) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: storageKey,
          ContentType: options.contentType
        }),
        { expiresIn: options.expiresInSeconds ?? 900 }
      ),
    presignGet: (storageKey, options) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }), {
        expiresIn: options?.expiresInSeconds ?? 300
      }),
    head: async (storageKey) => {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: storageKey })
        )
        return {
          exists: true,
          sizeBytes: result.ContentLength ?? 0,
          contentType: result.ContentType ?? null
        }
      } catch (error) {
        if (isNotFound(error)) {
          return { exists: false }
        }
        throw error
      }
    },
    getObjectBytes: async (storageKey) => {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: storageKey })
      )
      if (!result.Body) throw new Error(`object body is empty: ${storageKey}`)
      return result.Body.transformToByteArray()
    },
    deleteObject: async (storageKey) => {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: storageKey }))
    },
    ensureBucket: async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
      } catch {
        try {
          await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
        } catch (error) {
          if (!isBucketAlreadyOwned(error)) {
            throw error
          }
        }
      }
    },
    putObject: async (storageKey, body, contentType) => {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: storageKey,
          Body: body,
          ContentType: contentType
        })
      )
    }
  }
}
