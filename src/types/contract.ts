/**
 * API Contract Types & Data Transfer Objects (DTOs)
 *
 * Sourced from the frontend contract definitions in mergepay-web/src/lib/types.ts.
 * All property names, pagination envelopes, and error structures must be kept
 * strictly aligned to prevent runtime mismatches between backend responses
 * and web consumer expectations.
 */

export interface User {
  id: string;
  stellarPublicKey: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  createdByUserId: string;
  treasuryEnabled: boolean;
  treasuryAccountPublicKey: string | null;
  treasuryRequiredSigners: number | null;
  archived: boolean;
  createdAt: string;
}

export type GroupMemberRole = "admin" | "member";

export interface GroupMember {
  id: string;
  groupId: string;
  userId: string;
  role: GroupMemberRole;
  joinedAt: string;
  user: User;
}

export type ExpenseSplitType = "equal" | "exact" | "percentage" | "shares";

export interface ExpenseShare {
  id: string;
  expenseId: string;
  userId: string;
  user?: User;
  shareAmount: string;
  status: "pending" | "settled";
}

export interface Expense {
  id: string;
  groupId: string;
  payerUserId: string;
  payer?: User;
  title: string;
  description: string | null;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  splitType: ExpenseSplitType | string;
  memo: string | null;
  receiptUrl: string | null;
  createdAt: string;
  shares: ExpenseShare[];
}

export interface StatusHistory {
  id: string;
  entityType: string;
  entityId: string;
  status: string;
  reason: string | null;
  source: string | null;
  createdAt: string;
}

export type SettlementStatus =
  | "pending"
  | "submitting"
  | "confirmed"
  | "failed"
  | "expired";

export interface Settlement {
  id: string;
  groupId: string;
  fromUserId: string;
  from?: User;
  toUserId: string;
  to?: User;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  stellarTxHash: string | null;
  status: SettlementStatus | string;
  failureReason: string | null;
  retryCount: number;
  submittedAt: string | null;
  confirmedAt: string | null;
  memo: string | null;
  expenseId: string | null;
  expenseShareId: string | null;
  createdAt: string;
  expiresAt: string | null;
  statusHistory?: StatusHistory[];
}

export type TreasuryDirection = "deposit" | "withdrawal";
export type TreasuryTxStatus = "pending" | "submitting" | "confirmed" | "failed";

export interface TreasuryTransaction {
  id: string;
  groupId: string;
  userId: string | null;
  user: User | null;
  direction: TreasuryDirection;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  destination: string | null;
  stellarTxHash: string | null;
  status: TreasuryTxStatus | string;
  memo: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

export interface TreasuryProposal {
  id: string;
  groupId: string;
  creatorId: string;
  xdr: string;
  threshold: number;
  signatures: unknown[];
  signatureCount: number;
  status: string;
  stellarTxHash: string | null;
  failureReason: string | null;
  expiresAt: string | null;
  actionable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnchorSession {
  id: string;
  userId: string;
  anchorName: string;
  kind: "deposit" | "withdrawal";
  assetCode: string;
  interactiveUrl: string | null;
  externalTransactionId: string | null;
  status: string;
  statusHistory?: StatusHistory[];
  failureReason: string | null;
  retryCount?: number;
  lastPolledAt?: string | null;
  createdAt: string;
}

/** Which side of the anchor flow a SEP-24 transaction represents. */
export type Sep24TransactionKind = "deposit" | "withdrawal";

/**
 * One transition in Mergepay's own SEP-24 timeline.
 *
 * Not a SEP-24 spec field: the spec carries a single `message`, which cannot
 * represent more than the latest status. Exposed alongside the spec fields
 * under a name that makes the addition explicit.
 */
export interface Sep24StatusHistoryEntry {
  status: string;
  /** When the session entered `status`, ISO-8601. */
  at: string;
  source: string | null;
  reason: string | null;
}

/**
 * The SEP-24 `GET /transaction` object as served by Mergepay.
 *
 * Sourced from the frontend contract definitions in
 * `mergepay-web/src/lib/types.ts`. Field names follow the SEP-24 spec (snake
 * case) because this object is consumed by SEP-24-aware wallets; `session_id`
 * and `status_history` are Mergepay's additions and are named so they cannot be
 * mistaken for spec fields.
 */
export interface Sep24Transaction {
  /** The anchor's transaction id when known, else Mergepay's own. */
  id: string;
  kind: Sep24TransactionKind;
  status: string;
  /** Mergepay's session id, correlating this view with `/anchors/sessions`. */
  session_id: string;
  more_info_url?: string;
  started_at: string;
  updated_at?: string;
  /** Only once the transaction has reached a terminal status. */
  completed_at?: string;
  message?: string;
  status_history: Sep24StatusHistoryEntry[];
}

/** SEP-24 transaction list envelope (`GET /sep24/transactions`). */
export interface Sep24TransactionListResponse {
  transactions: Sep24Transaction[];
  meta: PaginationMeta;
}

/** The SEP-10 challenge returned when a SEP-24 interactive flow starts. */
export interface Sep24Challenge {
  transaction: string;
  networkPassphrase: string;
}

/** Response of `POST /anchors/deposit|withdraw` and `/sep24/deposit|withdraw`. */
export interface Sep24InitiateResponse {
  session: AnchorSession;
  challenge: Sep24Challenge;
}

/** Response of `POST /anchors/sessions/:id/complete`. */
export interface Sep24CompleteResponse {
  type: "interactive";
  url: string;
  id: string;
  session: AnchorSession;
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PaginationMeta {
  hasMore: boolean;
  nextCursor: string | null;
  limit?: number;
  order?: "asc" | "desc";
}

export interface PaginatedResponse<T> {
  items: T[];
  meta: PaginationMeta;
}

export interface GroupWithSummary extends Group {
  memberCount: number;
  yourNet: string;
  netAssetCode: string;
}

export interface GroupListResponse {
  groups: GroupWithSummary[];
  meta: PaginationMeta;
}

export interface GroupDetailResponse {
  group: Group;
  members: GroupMember[];
  yourRole: GroupMemberRole | string;
  meta: PaginationMeta;
}

export interface ExpenseListResponse {
  expenses: Expense[];
  meta: PaginationMeta;
}

export interface SettlementListResponse {
  settlements: Settlement[];
  meta: PaginationMeta;
}

export interface AuthChallengeResponse {
  transaction: string;
  networkPassphrase?: string;
  network_passphrase?: string;
}

export interface AuthVerifyResponse {
  token: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: User;
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
  code?: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  timestamp?: string;
  requestId?: string;
  details?: ApiErrorDetail[] | unknown;
  issues?: unknown[];
}

export interface ApiErrorResponse {
  error: ApiErrorPayload;
  code: string;
  message: string;
  requestId?: string;
}

