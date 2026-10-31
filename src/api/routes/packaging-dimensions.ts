import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { createPackagingDimension, deletePackagingDimension, listPackagingDimensions, updatePackagingDimension } from '../../db/repo.js'
import { PACKAGING_DIMENSIONS_PREFIX as PREFIX, apiError, apiOk, isLoopbackRequest, pathSegments, readJsonBody } from './helpers.js'

function readInput(body: Record<string, unknown>): { name: string; sku?: string; data: unknown } | null {
  if (typeof body.name !== 'string' || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return null
  return { name: body.name, ...(typeof body.sku === 'string' ? { sku: body.sku } : {}), data: body.data }
}

export function makePackagingDimensionRoutes(db: DatabaseSync): WebRoute[] {
  return [{
    kind: 'prefix', path: PREFIX,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const segments = pathSegments(url, PREFIX)
      const id = segments[0] === undefined ? '' : decodeURIComponent(segments[0])
      const method = req.method ?? 'GET'
      if (method === 'GET' && segments.length === 0) return apiOk(res, { records: listPackagingDimensions(db) })
      if (method === 'POST' && segments.length === 0) {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
        const input = readInput(body)
        if (input === null) return apiError(res, 400, '名称和尺寸数据格式无效')
        try { return apiOk(res, { record: createPackagingDimension(db, input as Parameters<typeof createPackagingDimension>[1]) }) }
        catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
      }
      if (method === 'PUT' && segments.length === 1) {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
        const input = readInput(body)
        if (input === null) return apiError(res, 400, '名称和尺寸数据格式无效')
        try {
          const record = updatePackagingDimension(db, id, input as Parameters<typeof updatePackagingDimension>[2])
          return record === null ? apiError(res, 404, '尺寸记录不存在') : apiOk(res, { record })
        } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
      }
      if (method === 'DELETE' && segments.length === 1) return deletePackagingDimension(db, id) ? apiOk(res) : apiError(res, 404, '尺寸记录不存在')
      return apiError(res, 404, 'not found')
    },
  }]
}
