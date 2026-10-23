import { getAmazonSop, type AmazonToolId } from '../amazonSops.js'

export function AmazonSopCard({ tool }: { tool: AmazonToolId }): JSX.Element {
  const sop = getAmazonSop(tool)
  return <details className="wb-amazon-sop" open>
    <summary><span>{sop.id}</span> {sop.title}</summary>
    <p>{sop.purpose}</p>
    <div className="wb-amazon-sop-grid">
      <SopList title="输入" items={sop.inputs} />
      <SopList title="步骤" items={sop.steps} ordered />
      <SopList title="输出" items={sop.outputs} />
      <SopList title="硬约束" items={sop.guardrails} />
    </div>
    <p className="wb-amazon-sop-skills">关联 Skill：{sop.relatedSkills.join(' · ')}</p>
  </details>
}

function SopList({ title, items, ordered = false }: { title: string; items: string[]; ordered?: boolean }): JSX.Element {
  const List = ordered ? 'ol' : 'ul'
  return <div><strong>{title}</strong><List>{items.map((item) => <li key={item}>{item}</li>)}</List></div>
}
