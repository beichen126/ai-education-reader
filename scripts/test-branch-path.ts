import { buildEffectiveConversationPath, buildEffectiveMessageIds, buildEffectivePathThrough, validateBranchGraph, isBranchGraphValid, descendantBranchIds, resolveBranchLineage, locateMessageOwner, canonicalForkOwner, branchDepth } from '../src/branches/branch-path.ts'
import type { Conversation, Message } from '../src/engine/types.ts'
import type { ConversationBranch } from '../src/branches/branch-types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function ids(ms: Message[]): string[] { return ms.map((m) => m.id) }
function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): Message { return { id, role, content, images: [], createdAt: 1, updatedAt: 1 } }
function conv(messages: Message[], id = 'c1'): Conversation { return { id, title: 't', createdAt: 1, updatedAt: 1, messages } }
function branch(id: string, conversationId: string, parentBranchId: string | undefined, forkMessageId: string, localMsgs: Message[], title = '分支'): ConversationBranch { return { id, conversationId, parentBranchId, forkMessageId, title, createdAt: 1, updatedAt: 1, messages: localMsgs } }
function codes(ds: { code: string }[]): string[] { return ds.map((d) => d.code) }
function has(ds: { code: string }[], code: string): boolean { return ds.some((d) => d.code === code) }

// ---- 1. root effective path ----
const m0 = msg('m0'), m1 = msg('m1'), m2 = msg('m2')
const rootConv = conv([m0, m1, m2])
assert(ids(buildEffectiveConversationPath(rootConv, [])) .join() === ['m0','m1','m2'].join(), 'root effective path returns conversation.messages')
assert(ids(buildEffectiveConversationPath(rootConv, [], undefined)) .join() === ['m0','m1','m2'].join(), 'root with explicit undefined activeBranch returns root')

// ---- 2. branch from root; fork included once; root unchanged ----
const B1 = branch('B1', 'c1', undefined, 'm1', [msg('b0'), msg('b1')])
assert(ids(buildEffectiveConversationPath(rootConv, [B1], 'B1')).join() === ['m0','m1','b0','b1'].join(), 'branch-from-root effective path')
assert(ids(buildEffectiveConversationPath(rootConv, [B1], 'B1')).filter(x => x === 'm1').length === 1, 'fork point included exactly once')
assert(rootConv.messages.length === 3, 'root conversation unchanged by branch')
assert(ids(buildEffectiveConversationPath(rootConv, [B1])).join() === ['m0','m1','m2'].join(), 'no active branch still shows root messages')

// ---- 3. nested branch + post-fork parent messages excluded ----
const B2 = branch('B2', 'c1', 'B1', 'b1', [msg('c0')])
const effB1 = buildEffectiveConversationPath(rootConv, [B1, B2], 'B1')
assert(ids(effB1).join() === ['m0','m1','b0','b1'].join(), 'parent branch B1 effective path includes inherited + local')
assert(ids(buildEffectiveConversationPath(rootConv, [B1, B2], 'B2')).join() === ['m0','m1','b0','b1','c0'].join(), 'nested branch B2 effective path correct')
// B2 forks at b1; if B1 had local beyond b1 they are excluded
const B1extra = branch('B1x', 'c1', undefined, 'm1', [msg('b0'), msg('b1'), msg('b2'), msg('b3')])
const B2cut = branch('B2x', 'c1', 'B1x', 'b1', [msg('c0')])
assert(ids(buildEffectiveConversationPath(rootConv, [B1extra, B2cut], 'B2x')).join() === ['m0','m1','b0','b1','c0'].join(), 'post-fork parent messages excluded at fork cut')

// ---- 4. canonical owner for inherited root message ----
const A = branch('A', 'c1', undefined, 'm1', [msg('a0'), msg('a1')])
const convWithA = conv([m0, m1])
assert(canonicalForkOwner(convWithA, [A], 'm0') === undefined, 'root-owned message forks from root')
assert(canonicalForkOwner(convWithA, [A], 'm1') === undefined, 'root-owned fork message (m1) forks from root')
assert(canonicalForkOwner(convWithA, [A], 'a0') === 'A', 'branch-owned message canonical owner is that branch')
const owner = locateMessageOwner(convWithA, [A], 'a1')
assert(owner.kind === 'branch' && owner.branchId === 'A', 'locateMessageOwner finds branch owner')
assert(locateMessageOwner(convWithA, [A], 'm0').kind === 'root', 'locateMessageOwner root for inherited root msg')

// ---- 5. invalid fork rejected ----
const badFork = branch('BF', 'c1', undefined, 'm9', [msg('x0')])
assert(has(validateBranchGraph(rootConv, [badFork]), 'missing-fork'), 'missing fork rejected (diagnostic)')
assert(ids(buildEffectiveConversationPath(rootConv, [badFork], 'BF')).join() === ['m0','m1','m2'].join(), 'corrupt active branch falls back to root (no crash)')

// ---- 6. missing parent rejected ----
const noParent = branch('NP', 'c1', 'ghost', 'm1', [msg('x0')])
assert(has(validateBranchGraph(rootConv, [noParent]), 'missing-parent'), 'missing parent rejected')

// ---- 7. wrong conversation parent rejected ----
const otherConvA = branch('OA', 'c9', undefined, 'm1', [msg('a0')])
const wrongParent = branch('WP', 'c1', 'OA', 'a0', [msg('y0')])
assert(has(validateBranchGraph(rootConv, [otherConvA, wrongParent]), 'wrong-conversation-parent'), 'wrong conversation parent rejected')

// ---- 8. cycle rejected ----
const cycA = branch('CyA', 'c1', 'CyB', 'm1', [msg('a')])
const cycB = branch('CyB', 'c1', 'CyA', 'm1', [msg('b')])
assert(has(validateBranchGraph(rootConv, [cycA, cycB]), 'cycle'), 'parent cycle rejected')
assert(ids(buildEffectiveConversationPath(rootConv, [cycA, cycB], 'CyA')).join() === ['m0','m1','m2'].join(), 'cycle-active branch falls back to root')
assert(resolveBranchLineage([cycA, cycB], 'CyA') === null, 'cycle lineage resolves null')

// ---- 9. self parent rejected ----
const selfP = branch('SP', 'c1', 'SP', 'm1', [msg('s')])
assert(has(validateBranchGraph(rootConv, [selfP]), 'self-parent'), 'self-parent rejected')

// ---- 10. duplicate branch id rejected ----
const dup1 = branch('DUP', 'c1', undefined, 'm1', [msg('d0')])
const dup2 = branch('DUP', 'c1', undefined, 'm1', [msg('d1')])
assert(has(validateBranchGraph(rootConv, [dup1, dup2]), 'duplicate-id'), 'duplicate branch id rejected')

// ---- 11. delete subtree ----
const treeBase = branch('TB', 'c1', undefined, 'm1', [msg('t0')])
const treeChild = branch('TC', 'c1', 'TB', 't0', [msg('u0')])
const treeGrand = branch('TG', 'c1', 'TC', 'u0', [msg('v0')])
const treeOther = branch('TO', 'c1', undefined, 'm1', [msg('w0')])
assert(descendantBranchIds([treeBase, treeChild, treeGrand, treeOther], 'TB').sort().join() === ['TC','TG'].join(), 'delete-subtree collects descendants')
assert(descendantBranchIds([treeBase, treeChild, treeGrand, treeOther], 'TC').join() === 'TG', 'subtree of child only grandchild')

// ---- 12. rename is metadata only ----
const renA = branch('RA', 'c1', undefined, 'm1', [msg('a0')])
const renA2 = branch('RA', 'c1', undefined, 'm1', [msg('a0')], '新名字')
assert(ids(buildEffectiveConversationPath(rootConv, [renA], 'RA')).join() === ids(buildEffectiveConversationPath(rootConv, [renA2], 'RA')).join(), 'rename keeps messages + ancestry identical')
assert(resolveBranchLineage([renA2], 'RA').join() === 'RA', 'rename keeps lineage')

// ---- 13. buildEffectivePathThrough freezes at selected message ----
const thConv = conv([msg('m0'), msg('m1'), msg('m2'), msg('m3')])
assert(ids(buildEffectivePathThrough(thConv, [], { branchId: undefined }, 'm1')).join() === ['m0','m1'].join(), 'through root message freezes at selection')
assert(ids(buildEffectivePathThrough(thConv, [], { branchId: undefined }, 'm9')).join() === '', 'through non-existent message returns empty')

// ---- 14. branchDepth ----
assert(branchDepth([B1, B2], 'B2') === 2, 'nested branch depth is 2')
assert(branchDepth([B1, B2], 'B1') === 1, 'root-fork branch depth is 1')
assert(branchDepth([cycA, cycB], 'CyA') === null, 'cycle branch depth is null')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
