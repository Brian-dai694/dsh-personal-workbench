/**
 * 上传文件 → 表格文本 + **文件元信息**（唯一实现）。
 *
 * ## 为什么抽出来（2026-10-29）
 *
 * 流量分析（`useAmazonDatasets`）与广告报表分析（`useAdReportDatasets`）各有一份
 * 一模一样的 `parseUpload`：同一条服务端路由、同一套 base64 编码、同一句错误文案。
 * 两份实现意味着"改解析规则漏一处"就会变成**同一份报表两页一个能导一个不能**，
 * 而这种不一致用户只会看到结果，很难描述成 bug。
 *
 * ## 为什么返回对象而不是纯字符串（同日晚间）
 *
 * 服务端 `parse-file` 早就在回 `format` / `sheetName` / `sheetCount`，但这里只把 `tsv` 拿走，
 * 另外三个字段被静默丢掉。后果是"多工作表只导第一张"这件事**在界面上根本说不出来**：
 * 付款对账恰恰最容易出现多 sheet 的报表，少一张表就是账做错。
 *
 * 所以现在的契约是：**拿文本的人同时拿到"这是哪个格式、第几张表、共有几张"**，
 * 由调用方决定怎么提示。字段缺失（老宿主）时给安全默认值，不抛错 —— 缺元信息
 * 不该阻断导入，但也绝不伪造 `sheetCount`。
 *
 * ## 边界
 *
 * 文本类（`.csv/.tsv/.txt`）本机直接读，省一次上传；其余（`.xlsx/.xls` 等二进制）
 * 交服务端按**魔数**解析 —— 不靠扩展名猜类型，也不在客户端引入 xlsx 依赖。
 * 旧版 `.xls` 的拒绝与提示由服务端给（`readXlsx` 只认 `.xlsx`），这里不重复拦一遍。
 *
 * 调用方（hook）负责把 `text` 交给各自的解析/落库逻辑；本模块只回数据，不写库。
 */
import { api } from './api.js'

const PARSE_PATH = '/api/workbench/amazon/datasets/parse-file'

/** 文本类文件的后缀。与服务端 `parse-file` 的判定保持一致。 */
const TEXT_FILE = /\.(csv|tsv|txt)$/i

/** base64 编码用 0x8000 分块，避免 `String.fromCharCode(...bytes)` 撑爆调用栈。 */
const CHUNK = 0x8000

export interface ParseUploadResult {
  /** 表格正文（TSV 或原文本），交给各域的解析器。 */
  text: string
  /** 服务端识别出的格式（`csv` / `tsv` / `xlsx`…）；文本类本地读时是 `text`，缺失时空串。 */
  format: string
  /**
   * 文件里有几个工作表。文本类恒为 1；老宿主不回这个字段时也给 1
   * （"只有一个表"是最小谎，且不会让人以为丢了数据）。
   */
  sheetCount: number
  /** 实际导入的工作表名。只有单 sheet 或文本类时为空串。 */
  sheetName: string
}

/** 服务端响应：`ok`/`tsv` 是必需，其余是元信息（允许缺失）。 */
interface ParseFileResponse {
  ok?: boolean
  tsv?: string
  format?: unknown
  sheetName?: unknown
  sheetCount?: unknown
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 只接受 ≥1 的整数；其余（缺字段、0、字符串、负值）一律按 1 处理。 */
function asSheetCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1
}

export async function parseUploadFile(file: File): Promise<ParseUploadResult> {
  if (TEXT_FILE.test(file.name)) {
    return { text: await file.text(), format: 'text', sheetCount: 1, sheetName: '' }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }

  const res = await api<ParseFileResponse>(PARSE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, base64: btoa(binary) }),
  })
  if (typeof res.tsv !== 'string' || res.tsv === '') throw new Error('这个文件里没有可用的表格数据')
  return {
    text: res.tsv,
    format: asString(res.format),
    sheetCount: asSheetCount(res.sheetCount),
    sheetName: asString(res.sheetName),
  }
}
