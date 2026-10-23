## [12:35] - 代码审查修复：Amazon 工具输入与边界处理

- **文件**: src/client/amazonTrafficTools.ts; src/client/views/AmazonTrafficView.tsx; src/client/amazonCalculator.ts; test/amazonTools.test.mjs; test/amazonCalculator.test.mjs
- **决策**: 流量 CSV 改为支持引号字段、中文 Amazon 列名和 Reporting Range 元数据；缺列/非法数字不再静默转 0，页面显示 needs_data；负毛利不返回负数盈亏平衡 CPC。
- **验证**: pnpm check 通过；新增针对性测试 9/9 通过。
