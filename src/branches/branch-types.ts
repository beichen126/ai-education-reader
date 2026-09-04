import type { Message, StableId } from '../engine/types'

/**
 * A conversational branch: a divergent future of a conversation.
 *
 * The root/main conversation stays the existing Conversation record; its `messages`
 * array is the root path. A ConversationBranch stores ONLY the branch-local
 * continuation AFTER its fork point — inherited messages are never duplicated.
 *
 * A branch with `parentBranchId` absent forks directly from the root conversation.
 */
export type ConversationBranch = {
  id: StableId
  conversationId: StableId

  /** Undefined => the branch forks from the root Conversation.messages. */
  parentBranchId?: StableId

  /**
   * The last inherited message id. The branch's local `messages` begin AFTER this
   * message. The fork message itself remains part of the effective history.
   */
  forkMessageId: StableId

  /** Metadata only. Renaming never changes messages or ancestry. */
  title: string

  createdAt: number
  updatedAt: number

  /** ONLY branch-local continuation. Never duplicates inherited messages. */
  messages: Message[]
}

/**
 * A stable handle identifying which chat thread an operation targets: the root
 * conversation, or a specific branch. Drafts, user-message acceptance, and the
 * composer all address a thread through this type.
 */
export type ChatThreadRef =
  | { type: 'root'; conversationId: StableId }
  | { type: 'branch'; conversationId: StableId; branchId: StableId }

/** Branch-id namespace used for per-branch composer drafts. */
export const BRANCH_DRAFT_PREFIX = 'draft-branch:'

/** Settings key holding the active branch for a conversation (absent => root). */
export function activeBranchKey(conversationId: StableId): string { return 'activeBranch:' + conversationId }

/** Where a given message lives in the branch graph. */
export type MessageOwner =
  | { kind: 'root' }
  | { kind: 'branch'; branchId: StableId }

/**
 * A concrete, actionable integrity problem found in a branch graph. Corrupt
 * branches are reported as diagnostics and treated as UNAVAILABLE — never guessed.
 */
export type BranchDiagnostic =
  | { code: 'missing-conversation'; branchId: StableId }
  | { code: 'missing-parent'; branchId: StableId; parentBranchId: StableId }
  | { code: 'missing-fork'; branchId: StableId; forkMessageId: StableId }
  | { code: 'self-parent'; branchId: StableId }
  | { code: 'cycle'; branchId: StableId; cycle: StableId[] }
  | { code: 'wrong-conversation-parent'; branchId: StableId; parentBranchId: StableId }
  | { code: 'duplicate-id'; branchId: StableId }
  | { code: 'duplicate-message-id'; branchId: StableId; messageId: StableId }
