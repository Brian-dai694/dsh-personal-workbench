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
import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { asinFacets, asinTrend, batchUpdateAsins, createAsinProduct, createAsinStore, deleteAsinStore, getAsinTaskSource, importAsinProducts, importAsinStores, listAllAsinProducts, listAsinStoreSummaries, listAsinStores, queryAsinPage, resolveAsinIdentity, setAsinJudgment, setAsinStoreWatch, setAsinWatch, trendsFor, updateAsinProduct, updateAsinStore } from '../../db/repo/asin.js'
import { ASIN_BATCH_ACTIONS, AsinConflictError, AsinIdentityError, AsinSiteRequiredError, type AsinBatchAction } from '../../db/repo/asin.js'
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

/**
 * P2 身份参数：读写统一走 `?site=`；请求体里的 `site` 作为兼容入口（仅 PATCH/POST）。
 * 空串归一为 null，绝不默认 US。
 */
function readSite(url: URL, body?: Record<string, unknown> | null): string | null {
  const fromBody = body !== null && body !== undefined && typeof body.site === 'string' ? body.site : ''
  const raw = url.searchParams.get('site') ?? fromBody
  if (raw.trim() === '') return null
  const site = raw.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(site)) throw new Error('站点必须是两位字母代码，例如 US / UK / DE')
  return site
}

/**
 * 写入缺站点：400 + `site_required`。
 *
 * 回显 `asin` 与 409 的身份错误保持同一套字段：前端要在列表里指出是哪一行缺站点，
 * 表单里还没填 ASIN 时给空串 —— 不编一个值，也不要求前端从路径里反推。
 */
function replySiteRequired(res: ServerResponse, rawAsin: unknown, message = '写入必须显式传 site（query 参数），空站点不回退到唯一匹配'): void {
  const asin = typeof rawAsin === 'string' ? rawAsin.trim().toUpperCase() : ''
  apiError(res, 400, message, { code: 'site_required', asin })
}

function replyIdentityError(res: ServerResponse, error: unknown): boolean {

  if (error instanceof AsinIdentityError) {
    apiError(res, 409, error.message, {
      code: error.code === 'SITE_REQUIRED' ? 'identity_required' : 'site_mismatch',
      asin: error.asin,
      candidates: error.candidates.map((site) => ({ site })),
    })
    return true
  }
  if (error instanceof AsinSiteRequiredError) {
    apiError(res, 400, error.message, { code: 'site_required', asin: error.asin })
    return true
  }
  return false
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
          const result = (() => {
            try {
              return queryAsinPage(db, {
                category: url.searchParams.get('category') ?? undefined,
                shop: url.searchParams.get('shop') ?? undefined,
                site: url.searchParams.get('site') ?? undefined,
                keyword: url.searchParams.get('q') ?? undefined,
                tag: url.searchParams.get('tag') ?? undefined,
                watch: watchParam === 'watch' || watchParam === 'normal' ? watchParam : undefined,
                verdict: isAsinVerdict(verdictParam) ? verdictParam : undefined,
                sort,
                order: url.searchParams.get('order') === 'asc' ? 'asc' : 'desc',
                limit: size,
                offset: (page - 1) * size,
              })
            } catch (error) {
              return error instanceof Error ? error : new Error(String(error))
            }
          })()
          if (result instanceof Error) return apiError(res, 400, result.message)
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

        /**
         * 手工新增一条商品（v1.18）：选品库不再只能靠「导入旧脚本备份」建库。
         *
         * 响应形状与 GET 列表里的单条一致（`product` + 最新 `facets`），界面存完即可刷新候选值。
         * 重复 ASIN → 409：**不做静默覆盖** —— 手工"添加"一个已存在的 ASIN 更可能是点错了，
         * 直接改字段请走 PATCH。
         */
        /**
         * 产品库表格导入（v1.29）：只接收已经由前端预览过的产品事实行。
         * 与旧 `/import` 明确分开：逐行新增、重复不覆盖、坏行不影响其它有效行。
         * 当前存储仍以 asin 为主键，因此同 ASIN 的跨站点行也会逐行回报 duplicate，
         * 不在这里静默改变既有 schema 语义。
         */
        if (req.method === 'POST' && segments.length === 2 && segments[0] === 'products' && segments[1] === 'import') {
          const body = await readJsonBody(req, 4 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '导入内容过大或不是合法 JSON（上限 4MB）')
          const rows = body.products
          if (!Array.isArray(rows) || rows.length === 0) return apiError(res, 400, 'products 必须是非空数组')
          if (rows.length > 2000) return apiError(res, 400, '一次最多导入 2000 行')
          const results: Array<Record<string, unknown>> = []
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]
            const raw = row !== null && typeof row === 'object' ? row as Record<string, unknown> : null
            const asin = typeof raw?.asin === 'string' ? raw.asin.trim().toUpperCase() : ''
            if (raw === null) {
              results.push({ index, status: 'invalid', error: '产品行必须是对象' })
              continue
            }
            let site: string | null
            try { site = readSite(new URL(req.url ?? '/', 'http://localhost'), raw) } catch (error) {
              results.push({ index, asin, status: 'invalid', error: error instanceof Error ? error.message : String(error) })
              continue
            }
            if (site === null) {
              results.push({ index, asin, status: 'invalid', code: 'site_required', error: '站点必填' })
              continue
            }
            try {
              const product = createAsinProduct(db, { ...raw, site })
              results.push({ index, asin: product.asin, site: product.site, status: 'created', product })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              results.push({ index, asin, site, status: error instanceof AsinConflictError ? 'duplicate' : 'invalid', error: message })
            }
          }
          const created = results.filter((item) => item.status === 'created').length
          return apiOk(res, { created, invalid: results.length - created - results.filter((item) => item.status === 'duplicate').length, duplicates: results.filter((item) => item.status === 'duplicate').length, results, facets: asinFacets(db) }, 200)
        }

        if (req.method === 'POST' && segments.length === 0) {
          const body = await readJsonBody(req, 256 * 1024)
          if (body === undefined) return apiError(res, 400, '请求体不是合法 JSON')
          let site: string | null
          try { site = readSite(url, body) } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
          if (site === null) return replySiteRequired(res, body.asin, '新建商品必须显式传 site（query 参数），空站点不回退到 US')
          try {
            const product = createAsinProduct(db, { ...body, site })
            return apiOk(res, { product, facets: asinFacets(db) }, 201)
          } catch (error) {
            if (replyIdentityError(res, error)) return
            const message = error instanceof Error ? error.message : String(error)
            if (error instanceof AsinConflictError) return apiError(res, 409, message)
            return apiError(res, 400, message, message.includes('站点必填') ? { code: 'site_required' } : undefined)
          }
        }

        /**
         * 编辑一条商品（v1.18）：只改请求体里出现的字段（`null` 清空可空字段）。
         * ASIN 是身份，路径里给；请求体里的 asin 会被忽略。
         */
        if (req.method === 'PATCH' && segments.length === 1) {
          const body = await readJsonBody(req, 256 * 1024)
          if (body === undefined) return apiError(res, 400, '请求体不是合法 JSON')
          let site: string | null
          try { site = readSite(url, body) } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
          if (site === null) return replySiteRequired(res, segments[0])
          try {
            const product = updateAsinProduct(db, decodeURIComponent(segments[0]), body, new Date().toISOString(), site)
            return apiOk(res, { product, facets: asinFacets(db) })
          } catch (error) {
            if (replyIdentityError(res, error)) return
            const message = error instanceof Error ? error.message : String(error)
            return message === 'asin not found'
              ? apiError(res, 404, 'ASIN 不存在')
              : apiError(res, 400, message)
          }
        }

        if (req.method === 'PATCH' && segments.length === 2 && segments[1] === 'judgment') {
          const body = await readJsonBody(req, 256 * 1024)
          if (body === undefined || body === null || typeof body !== 'object') return apiError(res, 400, '请求体不是合法 JSON')
          const raw = body as Record<string, unknown>
          let site: string | null
          try { site = readSite(url, raw) } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
          if (site === null) return replySiteRequired(res, segments[0])
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
            }, site)
            return apiOk(res, { judgment, facets: asinFacets(db) })
          } catch (error) {
            if (replyIdentityError(res, error)) return
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
          let site: string | null
          try { site = readSite(url, body) } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
          if (site === null) return replySiteRequired(res, segments[0])
          try {
            const updated = setAsinWatch(db, segments[0].toUpperCase(), watch, site)
            return updated ? apiOk(res, { watch }) : apiError(res, 404, 'ASIN 不存在')
          } catch (error) {
            if (replyIdentityError(res, error)) return
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
        }

        if (req.method === 'GET' && segments.length === 2 && segments[1] === 'trend') {
          try {
            /**
             * P2 客户端合同（2026-10-29）：回显规范化后的 `asin` 与解析出的 `site`。
             * - `asin` 原样回显会让小写路径与库内 key 对不上，前端拿它当 key 就串行；
             * - 无 `site` 读取时唯一匹配仍可通过，但前端要据此标注「这是哪个站点的曲线」，
             *   返回 `site:null` 即表示该行本身还没有身份（needs_site），不是 US。
             */
            const site = readSite(url)
            const identity = resolveAsinIdentity(db, segments[0], site)
            return apiOk(res, { asin: identity.asin, site: identity.site, points: asinTrend(db, identity.asin, 60, site) })
          } catch (error) {
            if (replyIdentityError(res, error)) return
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
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
            if (product.site === null) { judgmentFailed += 1; continue }
            try {
              setAsinJudgment(db, product.asin, { ...product.judgment, verdict: product.judgment.verdict, source: 'import' }, product.site)
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
          let filtered = products
          if (selected !== null) {
            try {
              const parsed: unknown = selected.trim().startsWith('[') ? JSON.parse(selected) : selected.split(',')
              if (!Array.isArray(parsed)) return apiError(res, 400, 'asins 必须是数组')
              const items = parsed.map((item) => {
                if (typeof item === 'string') return { asin: item, site: null as string | null }
                if (item !== null && typeof item === 'object') {
                  const row = item as Record<string, unknown>
                  return {
                    asin: typeof row.asin === 'string' ? row.asin : '',
                    site: typeof row.site === 'string' ? row.site : null,
                  }
                }
                return { asin: '', site: null as string | null }
              })
              /** 逐项解析：任一条歧义整体 409，不静默漏项。 */
              const identities = items.map((item) => resolveAsinIdentity(db, item.asin, item.site))
              const keys = new Set(identities.map((identity) => `${identity.site ?? ''}|${identity.asin}`))
              filtered = products.filter((product) => keys.has(`${(product.site ?? '').toUpperCase()}|${product.asin.toUpperCase()}`))
            } catch (error) {
              if (replyIdentityError(res, error)) return
              return apiError(res, 400, `asins 参数不合法：${error instanceof Error ? error.message : String(error)}`)
            }
          }
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
          let site: string | null
          try { site = readSite(url) } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
          if (site === null) return replySiteRequired(res, asin)
          let product
          try {
            product = getAsinTaskSource(db, asin, site)
          } catch (error) {
            if (replyIdentityError(res, error)) return
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
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
          const existing = findOpenTaskByAsin(db, asin, site)
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
            extra: { asin, site, verdict: product.verdict ?? 'none', score: product.score },
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
        /**
         * 手工新增店铺（v1.18）。id 由仓储按 `${site}_${sellerId}` 生成，
         * 没有 Seller ID 时用 `manual_<uuid8>` —— 主键不拿店铺名顶（改名会撞车）。
         */
        if (req.method === 'POST' && segments[0] === 'stores' && segments.length === 1) {
          const body = await readJsonBody(req, 64 * 1024)
          if (body === undefined) return apiError(res, 400, '请求体不是合法 JSON')
          try {
            const store = createAsinStore(db, body)
            return apiOk(res, { store, stores: listAsinStoreSummaries(db) }, 201)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return apiError(res, error instanceof AsinConflictError ? 409 : 400, message)
          }
        }

        /** 编辑一家店铺（v1.18）：只改请求体里出现的字段。 */
        if (req.method === 'PATCH' && segments[0] === 'stores' && segments.length === 2) {
          const body = await readJsonBody(req, 64 * 1024)
          if (body === undefined) return apiError(res, 400, '请求体不是合法 JSON')
          try {
            const store = updateAsinStore(db, decodeURIComponent(segments[1]), body)
            return apiOk(res, { store, stores: listAsinStoreSummaries(db) })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return message === '店铺不存在'
              ? apiError(res, 404, message)
              : apiError(res, 400, message)
          }
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
          const raw = body as { asins?: unknown; items?: unknown; action?: unknown; tag?: unknown; site?: unknown }
          const entries = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.asins) ? raw.asins : null
          if (entries === null) return apiError(res, 400, 'asins / items 必须是数组')
          const action = typeof raw.action === 'string' ? raw.action : ''
          if (!ASIN_BATCH_ACTIONS.includes(action as AsinBatchAction)) {
            return apiError(res, 400, `不支持的批量动作：${action}`)
          }
          let topSite: string | null
          try { topSite = readSite(url, body as Record<string, unknown>) } catch (error) { return apiError(res, 400, error instanceof Error ? error.message : String(error)) }
          const items = entries.map((entry) => {
            if (typeof entry === 'string') return { asin: entry, site: null as string | null }
            if (entry !== null && typeof entry === 'object') {
              const row = entry as Record<string, unknown>
              return {
                asin: typeof row.asin === 'string' ? row.asin : '',
                site: typeof row.site === 'string' ? row.site : null,
              }
            }
            return { asin: '', site: null as string | null }
          })
          try {
            /** 逐项解析；任一条歧义整体 409，不静默跳过。 */
            const identities = items.map((item) => resolveAsinIdentity(db, item.asin, item.site ?? topSite))
            const distinctSites = new Set(identities.map((identity) => identity.site).filter((site): site is string => site !== null))
            if (distinctSites.size > 1) {
              return apiError(res, 409, '一次批量只能针对同一站点；跨站点请在切换后分批处理', {
                code: 'identity_required',
                candidates: [...distinctSites].sort().map((site) => ({ site })),
              })
            }
            const result = batchUpdateAsins(
              db,
              identities.map((identity) => identity.asin),
              action as AsinBatchAction,
              typeof raw.tag === 'string' ? raw.tag : '',
              new Date().toISOString(),
              topSite ?? identities[0]?.site ?? null,
            )
            return apiOk(res, { ...result, facets: asinFacets(db) })
          } catch (error) {
            if (replyIdentityError(res, error)) return
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
        }

        return apiError(res, 404, 'not found')
      },
    },
  ]
}
