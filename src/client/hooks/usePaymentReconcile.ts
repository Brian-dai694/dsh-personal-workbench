/**
 * 付款对账上传域（2026-10-29）：文件 → 文本的唯一入口。
 *
 * 为什么单独一个 hook：对账页是**纯客户端解析**（`shared/paymentReconciliation`），
 * 但它现在要读用户选的文件，而读二进制必须经 `/parse-file`（服务端按魔数解析）。
 * 视图不许发 HTTP（D17 结构硬门），所以这条链路哪怕只有一行，也要落在 hook 里。
 *
 * 同时把服务端返回的 `sheetCount` / `sheetName` 原样带回来：付款报表最容易多工作表，
 * 只读第一张而**不说**是哪一张，用户就会拿着错误的数去对账。
 */
import { useCallback } from 'react'
import { parseUploadFile, type ParseUploadResult } from '../parseUpload.js'

export interface UsePaymentReconcileResult {
  actions: {
    /** 文件 → { text, sheetCount, sheetName, format }；失败抛错（由视图渲染成可见文案）。 */
    parseFile: (file: File) => Promise<ParseUploadResult>
  }
}

export function usePaymentReconcile(): UsePaymentReconcileResult {
  const parseFile = useCallback((file: File): Promise<ParseUploadResult> => parseUploadFile(file), [])
  return { actions: { parseFile } }
}
