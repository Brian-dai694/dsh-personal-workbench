export type AmazonToolId = 'profit' | 'keywords' | 'traffic'

export interface AmazonSop {
  id: string
  tool: AmazonToolId
  title: string
  purpose: string
  inputs: string[]
  steps: string[]
  outputs: string[]
  guardrails: string[]
  relatedSkills: string[]
}

export const AMAZON_SOPS: Record<AmazonToolId, AmazonSop> = {
  profit: {
    id: 'SOP-AMZ-001',
    tool: 'profit',
    title: '利润与 CPC 决策 SOP',
    purpose: '先确认有效毛利，再把可承受广告成本转换成目标 CPC；只输出建议，不直接改广告账户。',
    inputs: ['售价、采购、物流、FBA、佣金', '退货率与退货损失', '目标 ACOS、转化率、广告订单占比'],
    steps: ['核对币种和单件成本口径', '计算有效毛利与盈亏平衡 ACOS', '按转化率换算盈亏平衡 CPC', '用安全折扣得到建议 CPC', '人工结合库存、排名和广告报告确认'],
    outputs: ['有效单件毛利/毛利率', '盈亏平衡 ACOS/CPC', '安全 CPC 与广告后利润'],
    guardrails: ['毛利小于等于 0 时不得扩量', '没有真实广告报告时不得声称实际 ACOS', '不自动执行调价或预算修改'],
    relatedSkills: ['apollo-ai-bid-algorithm', 'amazon-acos-daily-audit'],
  },
  keywords: {
    id: 'SOP-AMZ-002',
    tool: 'keywords',
    title: '关键词分层与投放准备 SOP',
    purpose: '从核心词和修饰词形成可审阅的关键词候选，不代替 ABA 或卖家精灵的市场证据。',
    inputs: ['产品核心词', '规格/场景/人群修饰词', '可选 ABA 或竞品词库'],
    steps: ['清理重复词根和空白输入', '生成精准、词组、广泛三层候选', '人工检查相关性和商标风险', '结合 ABA 搜索量与竞品证据分级', '确认后再制作投放结构'],
    outputs: ['关键词分层表', '活动路由建议', '需人工确认的词清单'],
    guardrails: ['本工具生成候选，不编造搜索量', '没有 ABA/市场数据时标记 needs_data', '不创建广告、不上传 Bulk Sheet'],
    relatedSkills: ['amazon-keyword-relevance', 'amazon-aba-keyword-mining', 'amz-keyword-library-sorftime'],
  },
  traffic: {
    id: 'SOP-AMZ-003',
    tool: 'traffic',
    title: '搜索词与流量诊断 SOP',
    purpose: '对用户提供的广告/搜索词 CSV 做本地指标计算，定位高花费无单、曝光无点击等异常。',
    inputs: ['用户导出的 CSV', 'keyword、impressions、clicks、orders、spend、sales 列'],
    steps: ['先确认文件是对应周期和店铺', '校验表头与数字列', '计算 CTR、CVR、CPC、ACOS、ROAS', '按异常规则生成诊断', '结合多周期与 Listing 证据制定人工清单'],
    outputs: ['关键词级 KPI 表', '异常诊断', '否词/Listing/竞价人工复核清单'],
    guardrails: ['输入缺列或周期不明时先补数据', '账户数据不足时标记 needs_data', '只出建议，不执行否词、调价或预算修改'],
    relatedSkills: ['amazon-search-term-analyzer', 'amazon-acos-daily-audit', 'amazon-ad-period-diagnosis'],
  },
}

export function getAmazonSop(tool: AmazonToolId): AmazonSop {
  return AMAZON_SOPS[tool]
}
