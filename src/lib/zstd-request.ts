import type { MiddlewareHandler } from "hono"

import { Decompress, decompress as decompressFallback } from "fzstd"

type BinaryData = ArrayBuffer | ArrayBufferView

type BunRuntime = {
  zstdDecompress?: (input: Uint8Array) => BinaryData | Promise<BinaryData>
}

type ZstdDecompressionOptions = {
  maxCompressedBytes?: number
  maxDecompressedBytes?: number
}

type NodeZlibModule = {
  constants?: {
    ZSTD_d_windowLogMax?: number
  }
  zstdDecompress?: {
    (
      input: Uint8Array,
      options: {
        maxOutputLength: number
        params?: Record<number, number>
      },
      callback: (error: Error | null, result: Uint8Array) => void,
    ): void
    (
      input: Uint8Array,
      callback: (error: Error | null, result: Uint8Array) => void,
    ): void
  }
}

const ZSTD_CONTENT_ENCODING = "zstd"
const INVALID_BODY_STATUS = 400
const BODY_TOO_LARGE_STATUS = 413
const MEBIBYTE = 1024 * 1024
const DEFAULT_MAX_COMPRESSED_BYTES = 32 * MEBIBYTE
const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * MEBIBYTE
const ZSTD_FRAME_MAGIC = 0xfd2fb528
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f

let nodeZlibPromise: Promise<NodeZlibModule | null> | null = null

class BodyTooLargeError extends Error {}

export const createZstdDecompressionMiddleware = (
  options: ZstdDecompressionOptions = {},
): MiddlewareHandler => {
  const maxCompressedBytes =
    options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES
  const maxDecompressedBytes =
    options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES

  assertBodyLimit(maxCompressedBytes, "maxCompressedBytes")
  assertBodyLimit(maxDecompressedBytes, "maxDecompressedBytes")

  return async (c, next) => {
    const contentEncoding = c.req
      .header("content-encoding")
      ?.trim()
      .toLowerCase()
    if (contentEncoding !== ZSTD_CONTENT_ENCODING) {
      return next()
    }

    try {
      assertDeclaredBodySize(c.req.raw, maxCompressedBytes)
      const compressedBody = await readBodyWithLimit(
        c.req.raw,
        maxCompressedBytes,
      )
      const decompressedBody = await decompressZstd(
        compressedBody,
        maxDecompressedBytes,
      )
      const headers = new Headers(c.req.raw.headers)
      headers.delete("content-encoding")
      headers.delete("content-length")

      c.req.raw = new Request(c.req.raw.url, {
        body: decompressedBody,
        headers,
        method: c.req.raw.method,
        signal: c.req.raw.signal,
      })
      c.req.bodyCache = {}
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return c.json(
          {
            error: {
              message: "Zstd request body exceeds the configured size limit.",
              type: "invalid_request_error",
            },
          },
          BODY_TOO_LARGE_STATUS,
        )
      }

      return c.json(
        {
          error: {
            message: "Failed to decompress zstd request body.",
            type: "invalid_request_error",
          },
        },
        INVALID_BODY_STATUS,
      )
    }

    return next()
  }
}

export const legacyZstdDecompressionMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  const contentEncoding = c.req.header("content-encoding")?.trim().toLowerCase()
  if (contentEncoding !== ZSTD_CONTENT_ENCODING) {
    return next()
  }

  try {
    const compressedBody = new Uint8Array(await c.req.raw.arrayBuffer())
    const decompressedBody = await decompressZstdLegacy(compressedBody)
    const headers = new Headers(c.req.raw.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")

    c.req.raw = new Request(c.req.raw.url, {
      body: decompressedBody,
      headers,
      method: c.req.raw.method,
      signal: c.req.raw.signal,
    })
    c.req.bodyCache = {}
  } catch {
    return c.json(
      {
        error: {
          message: "Failed to decompress zstd request body.",
          type: "invalid_request_error",
        },
      },
      INVALID_BODY_STATUS,
    )
  }

  return next()
}

const decompressZstdLegacy = async (input: Uint8Array): Promise<Uint8Array> => {
  const bun = getBunRuntime()
  if (bun?.zstdDecompress) {
    return toUint8Array(await bun.zstdDecompress(input))
  }

  const nodeZlib = await getNodeZlib()
  if (nodeZlib?.zstdDecompress) {
    return new Promise((resolve, reject) => {
      nodeZlib.zstdDecompress?.(input, (error, result) => {
        if (error) {
          reject(error)
          return
        }

        resolve(toUint8Array(result))
      })
    })
  }

  return decompressFallback(input)
}

const decompressZstd = async (
  input: Uint8Array,
  maxOutputLength: number,
): Promise<Uint8Array> => {
  if (!("Bun" in globalThis)) {
    const nodeZlib = await getNodeZlib()
    if (nodeZlib?.zstdDecompress) {
      return decompressWithNode(nodeZlib, input, maxOutputLength)
    }
  }

  return decompressWithFzstd(input, maxOutputLength)
}

const decompressWithNode = (
  nodeZlib: NodeZlibModule,
  input: Uint8Array,
  maxOutputLength: number,
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const windowLogParam = nodeZlib.constants?.ZSTD_d_windowLogMax
    const params =
      windowLogParam === undefined ? undefined : (
        {
          [windowLogParam]: Math.max(10, Math.ceil(Math.log2(maxOutputLength))),
        }
      )

    nodeZlib.zstdDecompress?.(
      input,
      { maxOutputLength, params },
      (error, result) => {
        if (error) {
          reject(
            isNodeOutputLimitError(error) ? new BodyTooLargeError() : error,
          )
          return
        }

        const output = toUint8Array(result)
        if (output.byteLength > maxOutputLength) {
          reject(new BodyTooLargeError())
          return
        }

        resolve(output)
      },
    )
  })

const decompressWithFzstd = (
  input: Uint8Array,
  maxOutputLength: number,
): Uint8Array => {
  assertZstdFramesWithinLimits(input, maxOutputLength)

  const chunks: Uint8Array[] = []
  let outputLength = 0
  const decompressor = new Decompress((chunk) => {
    outputLength += chunk.byteLength
    if (outputLength > maxOutputLength) {
      throw new BodyTooLargeError()
    }

    chunks.push(chunk)
  })

  decompressor.push(input, true)
  return concatenateChunks(chunks, outputLength)
}

const assertZstdFramesWithinLimits = (
  input: Uint8Array,
  maxWindowLength: number,
): void => {
  let offset = 0

  while (offset < input.byteLength) {
    assertAvailable(input, offset, 4)
    const magic = readUint32(input, offset)

    if (
      magic >= ZSTD_SKIPPABLE_MAGIC_MIN
      && magic <= ZSTD_SKIPPABLE_MAGIC_MAX
    ) {
      assertAvailable(input, offset, 8)
      const frameLength = readUint32(input, offset + 4)
      assertAvailable(input, offset + 8, frameLength)
      offset += 8 + frameLength
      continue
    }

    if (magic !== ZSTD_FRAME_MAGIC) {
      throw new Error("Invalid Zstandard frame magic")
    }

    offset = validateZstdFrame(input, offset, maxWindowLength)
  }
}

const validateZstdFrame = (
  input: Uint8Array,
  frameOffset: number,
  maxWindowLength: number,
): number => {
  assertAvailable(input, frameOffset, 5)
  const descriptor = input[frameOffset + 4]
  if (descriptor & 0b0000_1000) {
    throw new Error("Invalid Zstandard frame descriptor")
  }

  const singleSegment = Boolean(descriptor & 0b0010_0000)
  const hasChecksum = Boolean(descriptor & 0b0000_0100)
  const dictionaryIdSize = [0, 1, 2, 4][descriptor & 0b11]
  const contentSizeFlag = descriptor >>> 6
  const contentSizeLength =
    contentSizeFlag === 0 ?
      singleSegment ? 1
      : 0
    : 1 << contentSizeFlag
  let offset = frameOffset + 5
  let windowLength: bigint

  if (singleSegment) {
    windowLength = 0n
  } else {
    assertAvailable(input, offset, 1)
    const windowDescriptor = input[offset++]
    const windowBase = 2 ** (10 + (windowDescriptor >>> 3))
    windowLength = BigInt(
      windowBase + (windowBase / 8) * (windowDescriptor & 0b111),
    )
  }

  assertAvailable(input, offset, dictionaryIdSize + contentSizeLength)
  offset += dictionaryIdSize
  const contentSize =
    readLittleEndianBigInt(input, offset, contentSizeLength)
    + (contentSizeLength === 2 ? 256n : 0n)
  offset += contentSizeLength

  if (singleSegment) {
    windowLength = contentSize
  }
  const maximum = BigInt(maxWindowLength)
  if (windowLength > maximum || contentSize > maximum) {
    throw new BodyTooLargeError()
  }

  let lastBlock = false
  while (!lastBlock) {
    assertAvailable(input, offset, 3)
    const blockHeader =
      input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16)
    offset += 3

    lastBlock = Boolean(blockHeader & 1)
    const blockType = (blockHeader >>> 1) & 0b11
    if (blockType === 0b11) {
      throw new Error("Invalid Zstandard block type")
    }

    const blockSize = blockHeader >>> 3
    const encodedSize = blockType === 0b01 ? 1 : blockSize
    assertAvailable(input, offset, encodedSize)
    offset += encodedSize
  }

  if (hasChecksum) {
    assertAvailable(input, offset, 4)
    offset += 4
  }

  return offset
}

const assertAvailable = (
  input: Uint8Array,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || offset < 0
    || offset + length > input.byteLength
  ) {
    throw new Error("Truncated Zstandard frame")
  }
}

const readUint32 = (input: Uint8Array, offset: number): number =>
  new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(
    offset,
    true,
  )

const readLittleEndianBigInt = (
  input: Uint8Array,
  offset: number,
  length: number,
): bigint => {
  let value = 0n
  for (let index = 0; index < length; index += 1) {
    value |= BigInt(input[offset + index]) << BigInt(index * 8)
  }
  return value
}

const readBodyWithLimit = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> => {
  if (!request.body) {
    return new Uint8Array()
  }

  const reader =
    request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let bodyLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      bodyLength += value.byteLength
      if (bodyLength > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLargeError()
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return concatenateChunks(chunks, bodyLength)
}

const assertDeclaredBodySize = (request: Request, maxBytes: number): void => {
  const contentLength = request.headers.get("content-length")
  if (contentLength === null) {
    return
  }

  const declaredBytes = Number(contentLength)
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
    throw new BodyTooLargeError()
  }
}

const assertBodyLimit = (value: number, optionName: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${optionName} must be a positive safe integer`)
  }
}

const isNodeOutputLimitError = (error: Error): boolean => {
  const code = (error as Error & { code?: string }).code
  return (
    code === "ERR_BUFFER_TOO_LARGE" || error.message.includes("maxOutputLength")
  )
}

const getNodeZlib = async (): Promise<NodeZlibModule | null> => {
  nodeZlibPromise ??= import("node:zlib")
    .then((module) => module as NodeZlibModule)
    .catch(() => null)

  return nodeZlibPromise
}

const getBunRuntime = (): BunRuntime | undefined =>
  (globalThis as { Bun?: BunRuntime }).Bun

const toUint8Array = (data: BinaryData): Uint8Array => {
  if (data instanceof Uint8Array) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

const concatenateChunks = (
  chunks: Uint8Array[],
  totalLength: number,
): Uint8Array => {
  if (chunks.length === 1) {
    return chunks[0]
  }

  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return output
}

export const zstdDecompressionMiddleware = createZstdDecompressionMiddleware()
