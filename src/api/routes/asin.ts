/**
 * 选品路由：`/api/workbench/asin`
 * - GET   /                  列表 + 筛选候选 + 迷你趋势
 * - GET   /:asin/trend       单条趋势
 * - PATCH /:asin/watch       关注/取消关注
 * - PATCH /:asin/judgment    写入判断结论（技能回写通道）
 * - POST  /import            导入旧油猴脚本导出的 JSON
 * - GET   /export            导出**整库**备份 JSON 到本机文件（回导脚本可用）
 * - POST  /batch             批量关注/取消、加标签/删标签、删除
 * - GET   /stores            店铺列表（带库内现算的关联商品数）
 * - PATCH /stores/:id/watch  关注/取消店铺
 * - DELETE /stores/:id       删除店铺记录（不删商品）
 *
 * 响应信封（2026-10-27，决策 2）：一律走 `apiOk` / `apiError`。
 * 原实现里 `{ ok: <操作结果>, watch }` 这类"把业务结果塞进 ok 字段"的写法一并收敛：
 * 成功 `{ok:true, ...}`、失败 `{ok:false, error}`，客户端按 `.ok` 读的语义不变。
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { asinFacets, asinTrend, batchUpdateAsins, deleteAsinStore, getAsinTaskSource, importAsinProducts, importAsinStores, listAllAsinProducts, listAsinStoreSummaries, listAsinStores, queryAsinPage, setAsinJudgment, setAsinStoreWatch, setAsinWatch, trendsFor } from '../../db/repo/asin.js'
import { ASIN_BATCH_ACTIONS, type AsinBatchAction } from '../../db/repo/asin.js'
import { isAsinVerdict } from '../../shared/asinJudgment.js'
import { normalizeAsinImport } from '../../shared/asinImport.js'
import { asinBackupFileName, buildAsinBackup } from '../../shared/asinExport.js'
import { addReminder, createTask, findOpenTaskByAsin, getDictionary, listDictionaries } from '../../db/repo.js'
import { ASIN_PREFIX as PREFIX, apiError, apiOk, isLoopbackRequest, pathSegments, readJsonBody, requireCode } from './helpers.js'



/** 导出目录里找一个不覆盖已有文件的名字（同一分钟连点两次导出很常见）。 */
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
export function makeAsinRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, PREFIX)

        if (req.method === 'GET' && segments.length === 0) {
          const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
          const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size') ?? '50') || 50))
          const sortValue = url.searchParams.get('sort') ?? 'collectedAt'
          const validSort = ['collectedAt', 'updatedAt', 'price', 'rating', 'reviews', 'bsr', 'manualOrder', 'score'] as const
          const sort = validSort.includes(sortValue as typeof validSort[number]) ? sortValue as typeof validSort[number] : 'collectedAt'
          const watchParam = url.searchParams.get('watch')
          const verdictParam = url.searchParams.get('verdict')
          const result = queryAsinPage(db, {
            category: url.searchParams.get('category') ?? undefined,
            shop: url.searchParams.get('shop') ?? undefined,
            keyword: url.searchParams.get('q') ?? undefined,
            tag: url.searchParams.get('tag') ?? undefined,
            watch: watchParam === 'watch' || watchParam === 'normal' ? watchParam : undefined,
            verdict: isAsinVerdict(verdictParam) ? verdictParam : undefined,
            sort,
            order: url.searchParams.get('order') === 'asc' ? 'asc' : 'desc',
            limit: size,
            offset: (page - 1) * size,
          })
          const trends = trendsFor(db, result.items.map((p) => p.asin))
          return apiOk(res, {
            products: result.items.map((p) => ({ ...p, trend: trends.get(p.asin) ?? [] })),
            total: result.total,
            page,
            size,
            stores: listAsinStoreSummaries(db),
            /** 立项弹框用的类型/优先级候选：直接取字典，界面不硬编码 code（避免与字典漂移）。 */
            taskTypes: listDictionaries(db, 'type').filter((d) => d.active !== 0).map((d) => ({ code: d.code, name: d.name })),
            taskPriorities: listDictionaries(db, 'priority').filter((d) => d.active !== 0).map((d) => ({ code: d.code, name: d.name })),
            facets: asinFacets(db),
          })
        }

        if (req.method === 'PATCH' && segments.length === 2 && segments[1] === 'judgment') {
          const body = await readJsonBody(req, 256 * 1024)
          if (body === undefined || body === null || typeof body !== 'object') return apiError(res, 400, '请求体不是合法 JSON')
          const raw = body as Record<string, unknown>
          try {
            const judgment = setAsinJudgment(db, segments[0].toUpperCase(), {
              verdict: raw.verdict as never,
              score: typeof raw.score === 'number' ? raw.score : undefined,
              nextAction: typeof raw.nextAction === 'string' ? raw.nextAction : undefined,
              criteria: Array.isArray(raw.criteria) ? raw.criteria as Array<{ name: string; value: string }> : undefined,
              painPoints: Array.isArray(raw.painPoints) ? raw.painPoints as Array<{ label: string; count: number }> : undefined,
              risk: typeof raw.risk === 'object' && raw.risk !== null ? raw.risk as { level: 'low'; note: string } : undefined,
              keywordCount: typeof raw.keywordCount === 'number' ? raw.keywordCount : undefined,
              source: typeof raw.source === 'string' ? raw.source : 'manual',
            })
            return apiOk(res, { judgment, facets: asinFacets(db) })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return message === 'asin not found'
              ? apiError(res, 404, message)
              : apiError(res, 400, message)
          }
        }

        if (req.method === 'PATCH' && segments.length === 2 && segments[1] === 'watch') {
          const body = await readJsonBody(req, 64 * 1024)
          if (body === undefined || body === null || typeof body !== 'object') return apiError(res, 400, '请求体不是合法 JSON')
          const watch = (body as { watch?: unknown }).watch
          if (typeof watch !== 'boolean') return apiError(res, 400, 'watch 必须是布尔值')
          const updated = setAsinWatch(db, segments[0].toUpperCase(), watch)
          return updated ? apiOk(res, { watch }) : apiError(res, 404, 'ASIN 不存在')
        }

        if (req.method === 'GET' && segments.length === 2 && segments[1] === 'trend') {
          return apiOk(res, { asin: segments[0], points: asinTrend(db, segments[0].toUpperCase()) })
        }

        if (req.method === 'POST' && segments[0] === 'import') {
          const body = await readJsonBody(req, 12 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '导入文件过大或不是合法 JSON（上限 12MB）')
          const parsed = normalizeAsinImport(body)
          if (parsed.products.length === 0) {
            return apiError(res, 400, parsed.firstReason ?? '没有可导入的 ASIN', { rejected: parsed.rejected })
          }
          const summary = importAsinProducts(db, parsed.products, parsed.snapshots, parsed.rejected, parsed.firstReason)
          const stores = importAsinStores(db, parsed.stores)
          /**
           * 判断结论单独回写（v1.24）：**导出再导入**要能恢复结论，否则备份就降级了。
           *
           * 为什么不在 `importAsinProducts` 的 upsert 里一起写：那条 SQL 是 22 列的
           * 大批量 upsert，加 5 个判断列会让"商品导入"和"判断写入"的校验规则纠缠在
           * 一句 SQL 里；走 `setAsinJudgment` 则沿用同一份枚举/范围校验。
           * 单条失败不中断整批（记进 `judgmentFailed`），并把原因带回去。
           */
          let judgmentRestored = 0
          let judgmentFailed = 0
          for (const product of parsed.products) {
            if (product.judgment === undefined) continue
            try {
              setAsinJudgment(db, product.asin, { ...product.judgment, verdict: product.judgment.verdict, source: 'import' })
              judgmentRestored += 1
            } catch {
              judgmentFailed += 1
            }
          }
          return apiOk(res, { ...summary, stores, judgmentRestored, judgmentFailed, facets: asinFacets(db) })
        }

        if (req.method === 'GET' && segments[0] === 'export') {
          const products = listAllAsinProducts(db)
          const selected = url.searchParams.get('asins')
          const filtered = selected === null
            ? products
            : products.filter((product) => selected.split(',').map((v) => v.trim().toUpperCase()).includes(product.asin.toUpperCase()))
          if (filtered.length === 0) return apiError(res, 400, '没有可导出的商品')
          try {
            const dir = join(homedir(), '.dsh', 'workbench', 'exports')
            await mkdir(dir, { recursive: true })
            const filePath = await freePath(dir, asinBackupFileName())
            const backup = buildAsinBackup(filtered, listAsinStores(db))
            await writeFile(filePath, JSON.stringify(backup, null, 2), 'utf8')
            return apiOk(res, {
              path: filePath,
              products: Object.keys(backup.products).length,
              stores: Object.keys(backup.stores).length,
              bytes: JSON.stringify(backup).length,
            })
          } catch (error) {
            return apiError(res, 400, `写文件失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        /**
         * 立项（v1.26）：把一个「可做/观望」的判断变成一条真实任务。
         *
         * 三条纪律：
         * 1. **幂等**：同一 ASIN 已有未完成的立项任务就返回 409 + 那个任务 id，
         *    不重复创建（用户点两下不该得到两个任务）；
         * 2. **不伪造进度**：任务只带 `todo` 状态与 ASIN 锚点，进度/完成只能由人推进；
         * 3. **判断内容进描述**：分数、评分卡、VOC 痛点、风险、下一步都写进去 ——
         *    否则任务打开后只剩一个标题，立项的意义就没了。
         */
        if (req.method === 'POST' && segments.length === 2 && segments[1] === 'task') {
          const asin = segments[0].trim().toUpperCase()
          const product = getAsinTaskSource(db, asin)
          if (product === undefined) return apiError(res, 404, 'ASIN 不存在')
          /**
           * 类型/优先级/标题可由界面指定（v1.27），但**必须过字典校验**：
           * 允许自由字符串会让任务落进一个字典里不存在的 code，
           * 之后列表按类型筛选就永远筛不出它。
           *
           * 顺序：**先校验参数、再判幂等** —— 否则参数非法但已有同名任务时，
           * 用户会收到"已有任务"而不是"类型非法"，查错方向被带偏。
           */
          const body = await readJsonBody(req, 64 * 1024)
          const wanted = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
          const typeCode = typeof wanted.typeCode === 'string' && wanted.typeCode !== '' ? wanted.typeCode : 'personal'
          const priorityCode = typeof wanted.priorityCode === 'string' && wanted.priorityCode !== '' ? wanted.priorityCode : 'p2'
          try {
            requireCode(db, 'type', typeCode, 'typeCode')
            requireCode(db, 'priority', priorityCode, 'priorityCode')
          } catch (error) {
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
          const existing = findOpenTaskByAsin(db, asin)
          if (existing !== undefined) {
            return apiError(res, 409, `这个 ASIN 已有未完成的立项任务：${existing.title}`, { existingTaskId: existing.id })
          }
          let judgment: Record<string, unknown> = {}
          try { judgment = JSON.parse(product.judgmentJson ?? '{}') as Record<string, unknown> } catch { judgment = {} }
          const criteria = Array.isArray(judgment.criteria) ? judgment.criteria as Array<{ name: string; value: string }> : []
          const painPoints = Array.isArray(judgment.painPoints) ? judgment.painPoints as Array<{ label: string; count: number }> : []
          const risk = judgment.risk !== null && typeof judgment.risk === 'object' ? judgment.risk as { level?: string; note?: string } : null
          const lines = [
            `- ASIN：${asin}${product.site === null ? '' : `（${product.site}）`}`,
            product.price === null ? null : `- 参考售价：$${product.price.toFixed(2)}`,
            `- 选品结论：${product.verdict ?? 'none'}${product.score === null ? '' : ` · 评分 ${product.score}`}`,
            typeof judgment.nextAction === 'string' && judgment.nextAction !== '' ? `- 下一步：${judgment.nextAction}` : null,
            criteria.length === 0 ? null : `- 评分卡：${criteria.map((item) => `${item.name} ${item.value}`).join('；')}`,
            painPoints.length === 0 ? null : `- VOC 痛点：${painPoints.map((item) => `${item.label}（${item.count}）`).join('；')}`,
            risk === null ? null : `- 商标/合规风险：${risk.level ?? 'unknown'}${risk.note === undefined || risk.note === '' ? '' : ` · ${risk.note}`}`,
            '',
            '（由选品库立项生成；价格、评分与风险来自导入/判断时的数据，执行前请复核。）',
          ].filter((line): line is string => line !== null)
          const rawTitle = typeof wanted.title === 'string' ? wanted.title.trim() : ''
          /**
           * 截止时间（v1.28）：可选。给了就必须是能解析的时间，
           * 不接受"看起来像日期"的字符串 —— 存进去一个无法解析的 due 会让日期面板把它当无截止。
           */
          let dueAt: string | null = null
          if (typeof wanted.dueAt === 'string' && wanted.dueAt.trim() !== '') {
            const parsed = Date.parse(wanted.dueAt)
            if (!Number.isFinite(parsed)) return apiError(res, 400, 'dueAt 不是合法时间')
            dueAt = new Date(parsed).toISOString()
          }
          const task = createTask(db, {
            title: rawTitle !== '' ? rawTitle : `选品立项：${product.title === '' ? asin : product.title}`,
            description: lines.join('\n'),
            typeCode,
            priorityCode,
            dueAt,
            allDay: wanted.allDay === true,
            statusCode: 'todo',
            source: 'asin-library',
            extra: { asin, verdict: product.verdict ?? 'none', score: product.score },
          })
          /**
           * 有截止时间就按「类型默认 → 优先级默认」补一条提醒，口径与 `POST /tasks` 完全一致：
           * 否则同一件事从选品库立项出来的任务永不提醒、从任务表单建出来的会提醒。
           */
          if (task.dueAt !== null) {
            const typeDefault = getDictionary(db, 'type', task.typeCode)?.config.defaultReminderMinutes
            const priorityDefault = getDictionary(db, 'priority', task.priorityCode)?.config.defaultReminderMinutes
            const offset = typeof typeDefault === 'number' ? typeDefault : typeof priorityDefault === 'number' ? priorityDefault : undefined
            if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) addReminder(db, task.id, offset, 'browser')
          }
          return apiOk(res, { taskId: task.id, title: task.title, dueAt: task.dueAt })
        }
        if (req.method === 'GET' && segments[0] === 'stores' && segments.length === 1) {
          return apiOk(res, { stores: listAsinStoreSummaries(db) })
        }

        if (req.method === 'PATCH' && segments[0] === 'stores' && segments.length === 3 && segments[2] === 'watch') {
          const body = await readJsonBody(req, 64 * 1024)
          if (body === undefined || body === null || typeof body !== 'object') return apiError(res, 400, '请求体不是合法 JSON')
          const watch = (body as { watch?: unknown }).watch
          if (typeof watch !== 'boolean') return apiError(res, 400, 'watch 必须是布尔值')
          const updated = setAsinStoreWatch(db, decodeURIComponent(segments[1]), watch)
          return updated ? apiOk(res, { watch }) : apiError(res, 404, '店铺不存在')
        }

        if (req.method === 'DELETE' && segments[0] === 'stores' && segments.length === 2) {
          const removed = deleteAsinStore(db, decodeURIComponent(segments[1]))
          return removed ? apiOk(res) : apiError(res, 404, '店铺不存在')
        }
        if (req.method === 'POST' && segments[0] === 'batch') {
          const body = await readJsonBody(req, 256 * 1024)
          if (body === undefined || body === null || typeof body !== 'object') return apiError(res, 400, '请求体不是合法 JSON')
          const raw = body as { asins?: unknown; action?: unknown; tag?: unknown }
          if (!Array.isArray(raw.asins)) return apiError(res, 400, 'asins 必须是数组')
          const action = typeof raw.action === 'string' ? raw.action : ''
          if (!ASIN_BATCH_ACTIONS.includes(action as AsinBatchAction)) {
            return apiError(res, 400, `不支持的批量动作：${action}`)
          }
          try {
            const result = batchUpdateAsins(
              db,
              raw.asins.filter((x): x is string => typeof x === 'string'),
              action as AsinBatchAction,
              typeof raw.tag === 'string' ? raw.tag : '',
            )
            return apiOk(res, { ...result, facets: asinFacets(db) })
          } catch (error) {
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
        }

        return apiError(res, 404, 'not found')
      },
    },
  ]
}
