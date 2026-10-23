import assert from 'node:assert/strict'
import test from 'node:test'
import { AMAZON_SOPS, getAmazonSop } from '../lib/client/amazonSops.js'

test('every Amazon tool has exactly one dedicated SOP with guardrails', () => {
  for (const tool of ['profit', 'keywords', 'traffic']) {
    const sop = getAmazonSop(tool)
    assert.equal(sop.tool, tool)
    assert.match(sop.id, /^SOP-AMZ-00[1-3]$/)
    assert.ok(sop.steps.length >= 3)
    assert.ok(sop.guardrails.length >= 2)
    assert.ok(sop.relatedSkills.length >= 1)
  }
  assert.equal(Object.keys(AMAZON_SOPS).length, 3)
})
