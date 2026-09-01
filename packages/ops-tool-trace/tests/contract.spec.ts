/**
 * Node-shape contract test.
 *
 * The node shape is declared three times for three different consumers:
 *   - the TreeNode interface (src/types.ts) — TS consumers, compile-time
 *   - treeNodeSchema (zod) — validates projection snapshots at runtime
 *   - treeNodeJsonSchema — the tool's output contract for the model
 * The status enum additionally appears in status_filter and summary.counts.
 *
 * The TreeNode↔zod agreement is guarded at compile time in src/index.ts;
 * this spec pins the runtime-visible agreements so adding a field to one
 * declaration but not the others fails loudly.
 */

import { describe, it, expect } from 'vitest'
import { treeNodeSchema, treeNodeJsonSchema } from '../src/index.ts'
import { NODE_STATUSES } from '../src/node-status.ts'
import type { TreeNode } from '../src/types.ts'

/** The canonical field list — keyof TreeNode, spelled out so the failure
 *  message names the drift instead of just diffing two wrong copies. */
const TREE_NODE_FIELDS: Array<keyof TreeNode> = [
  'id', 'title', 'status', 'parent', 'turns', 'summary', 'detail', 'caused_by',
]

describe('node shape contract', () => {
  it('zod schema and JSON schema declare the same fields as TreeNode', () => {
    expect(Object.keys(treeNodeSchema.shape).sort()).toEqual([...TREE_NODE_FIELDS].sort())
    expect(Object.keys(treeNodeJsonSchema.properties).sort()).toEqual([...TREE_NODE_FIELDS].sort())
  })

  it('all three status enums derive from NODE_STATUSES', () => {
    expect(treeNodeSchema.shape.status.options).toEqual([...NODE_STATUSES])
    expect(treeNodeJsonSchema.properties.status.enum).toEqual([...NODE_STATUSES])
  })

  it('zod schema accepts a full node and rejects an unknown status', () => {
    const node: TreeNode = {
      id: 'ceph-full',
      title: 'Ceph 存储满了',
      status: 'in_progress',
      parent: 'goal',
      turns: [1],
      summary: null,
      detail: '因为 osd.1 使用率 99%',
      caused_by: [],
    }
    expect(treeNodeSchema.parse(node)).toEqual(node)
    expect(() => treeNodeSchema.parse({ ...node, status: 'bogus' })).toThrow()
    expect(() => treeNodeSchema.parse({ ...node, extra: 1 })).not.toThrow() // strips, doesn't fail
  })
})
