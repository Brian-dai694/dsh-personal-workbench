/**
 * 关键词库路由（2026-10-24）：`/api/workbench/keyword-plans`
 *
 * - `GET    /`         列表（摘要，不带 rows）
 * - `GET    /:id`      单份全文（含 rows / negatives）
 * - `POST   /`         新建方案
 * - `PATCH  /:id`      局部更新（只改显式给出的字段）
 * - `DELETE /:id`      删除
 * - `POST   /:id/export` 把方案写成 CSV 文件到 `~/.dsh/workbench/exports/`，返回路径
 *
 * 只读写本地 SQLite 与本地导出目录；**不连接广告账户、不创建活动、不上传 Bulk**。
 * 与其它域同一条 loopback 信任围栏。
 *
 * 响应信封（2026-10-27，决策 2）：一律走 `apiOk` / `apiError`。
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  createKeywordPlan, deleteKeywordPlan, getKeywordPlan, listKeywordPlans, updateKeywordPlan,
} from '../../db/repo.js'
import type { KeywordPlanInput } from '../../db/repo.js'
import { keywordCsvFileName, keywordPlanCsv } from '../../shared/keywordPlanCsv.js'
import { apiError, apiOk, isLoopbackRequest, readJsonBody } from './helpers.js'

const PREFIX = '/api/workbench/keyword-plans'

/**
 * 找到一个**不会覆盖已有文件**的导出路径。
 *
 * 为什么必须做：文件名是「标题 + 日期」，同一天导两份同名方案会静默覆盖前一份 ——
 * 用户以为有两份，实际只剩一份。这里改成 `name(2).csv` / `name(3).csv`，
 * 顺序可预测、也不在文件名里塞随机串（用户要能一眼认出来）。
 */
async function freePath(dir: string, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf('.')
  const stem = dot === -1 ? fileName : fileName.slice(0, dot)
  const ext = dot === -1 ? '' : fileName.slice(dot)
  for (let n = 1; n <= 200; n += 1) {
    const candidate = join(dir, n === 1 ? fileName : `${stem}(${n})${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('同名导出文件过多，请先清理 exports 目录')
}

/** 把请求体归一成仓储入参；类型不对就当没给（`undefined` = 保持原值）。 */
function readInput(body: Record<string, unknown>): Partial<KeywordPlanInput> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  const input: Partial<KeywordPlanInput> = {}
  const title = str(body.title)
  if (title !== undefined) input.title = title
  const seed = str(body.seed)
  if (seed !== undefined) input.seed = seed
  const note = str(body.note)
  if (note !== undefined) input.note = note
  const modifiers = strList(body.modifiers)
  if (modifiers !== undefined) input.modifiers = modifiers
  const negatives = strList(body.negatives)
  if (negatives !== undefined) input.negatives = negatives
  const matchTypes = strList(body.matchTypes)
    ?.filter((x): x is 'exact' | 'phrase' | 'broad' => x === 'exact' || x === 'phrase' || x === 'broad')
  if (matchTypes !== undefined) input.matchTypes = matchTypes
  if (Array.isArray(body.rows)) input.rows = body.rows as KeywordPlanInput['rows']
  // asin 允许显式 null（解绑）；缺省才是"不改"
  if (body.asin === null) input.asin = null
  else if (typeof body.asin === 'string') input.asin = body.asin
  return input
}

export function makeKeywordPlanRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname.slice(PREFIX.length).split('/').filter((part) => part !== '')
        const method = req.method ?? 'GET'
        const id = segments[0] === undefined ? '' : decodeURIComponent(segments[0])

        if (method === 'GET' && segments.length === 0) {
          return apiOk(res, { plans: listKeywordPlans(db) })
        }

        if (method === 'GET' && segments.length === 1) {
          const plan = getKeywordPlan(db, id)
          return plan === null ? apiError(res, 404, '方案不存在') : apiOk(res, { plan })
        }

        if (method === 'POST' && segments.length === 0) {
          const body = await readJsonBody(req, 4 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
          const input = readInput(body)
          if ((input.title ?? '').trim() === '') return apiError(res, 400, '方案标题不能为空')
          try {
            const plan = createKeywordPlan(db, {
              title: input.title as string,
              seed: input.seed,
              modifiers: input.modifiers,
              matchTypes: input.matchTypes,
              negatives: input.negatives,
              rows: input.rows,
              asin: input.asin,
              note: input.note,
            })
            return apiOk(res, { plan })
          } catch (error) {
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
        }

        if (method === 'PATCH' && segments.length === 1) {
          const body = await readJsonBody(req, 4 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
          const plan = updateKeywordPlan(db, id, readInput(body))
          return plan === null ? apiError(res, 404, '方案不存在或标题为空') : apiOk(res, { plan })
        }

        if (method === 'DELETE' && segments.length === 1) {
          /** 同 aba-keywords：原实现回 `404 + ok:true`，信封自相矛盾，这里拆成两条。 */
          if (!deleteKeywordPlan(db, id)) return apiError(res, 404, '方案不存在')
          return apiOk(res)
        }

        /**
         * 导出 CSV：**由服务端按库里的行重新生成**，不接受客户端上传的文本。
         *
         * 这样导出的内容一定等于"用户看到并确认过的方案"，也让本接口没有"写任意内容到本机"
         * 的能力。文件名在主进程里清洗（Windows 非法字符会让写文件直接失败）。
         */
        if (method === 'POST' && segments.length === 2 && segments[1] === 'export') {
          const plan = getKeywordPlan(db, id)
          if (plan === null) return apiError(res, 404, '方案不存在')
          try {
            const dir = join(homedir(), '.dsh', 'workbench', 'exports')
            await mkdir(dir, { recursive: true })
            const filePath = await freePath(dir, keywordCsvFileName(plan.title))
            await writeFile(filePath, '\uFEFF' + keywordPlanCsv(plan.rows, plan.negatives), 'utf8')
            return apiOk(res, {
              path: filePath,
              fileLink: pathToFileURL(filePath).href,
              rows: plan.rows.length,
              negatives: plan.negatives.length,
            })
          } catch (error) {
            return apiError(res, 400, `写文件失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        return apiError(res, 404, 'not found')
      },
    },
  ]
}
