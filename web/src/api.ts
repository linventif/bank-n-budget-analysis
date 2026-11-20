// Client typé de l'API Rust (/api, interface privée).

export type Kind = "expense" | "income" | "transfer";
export type Source = "user" | "rule" | "memory" | "transfer" | "ai";

export interface Category {
  id: number;
  name: string;
  icon: string;
  kind: Kind;
  description: string;
  budget_cents: number | null;
  position: number;
  role: string | null;
  tx_count: number;
  nature: "vital" | "plaisir" | null;
}

export interface Account {
  id: string;
  bank: string;
  name: string | null;
  product: string | null;
  iban: string | null;
  currency: string;
  balance_cents: number | null;
  pending_cents: number;
  available_cents: number | null;
  balance_date: string | null;
  last_sync: string | null;
  last_error: string | null;
  valid_until: string | null;
  expired: boolean;
  tx_count: number;
  closed_at: string | null;
  cash_account_type: string | null;
}

export interface Totals {
  expenses_cents: number;
  income_cents: number;
}

export interface CatAmount {
  category_id: number | null;
  amount_cents: number;
  count: number;
  prev_cents: number;
  avg_cents: number;
  budget_cents: number | null;
}

export interface Summary {
  month: string | null;
  months: string[];
  is_current_month: boolean;
  balance_cents: number;
  pending_cents: number;
  totals: Totals;
  prev: Totals;
  avg: Totals;
  avg_months: number;
  by_category: CatAmount[];
  income_by_category: CatAmount[];
  monthly: (Totals & { month: string })[];
  cumulative_current: number[];
  cumulative_average: number[];
  cumulative_previous: { month: string; values: number[] }[];
  days_in_month: number;
  top_merchants: { merchant: string; name: string; amount_cents: number; count: number; category_id: number | null }[];
}

export interface Trends {
  months: string[];
  rows: { category_id: number | null; values: number[]; total: number; average: number }[];
  expenses: number[];
  income: number[];
}

export interface RecurringItem {
  merchant: string;
  name: string;
  label: string;
  category_id: number | null;
  kind: "expense" | "income";
  cadence: "weekly" | "monthly" | "quarterly" | "yearly";
  /** Montant stable : abonnement / prélèvement. */
  fixed: boolean;
  amount_cents: number;
  average_cents: number;
  monthly_cents: number;
  occurrences: number;
  first_day: string;
  last_day: string;
  next_day: string | null;
  interval_days: number;
  status: "active" | "late" | "stopped";
  total_12m_cents: number;
  manual_id: number | null;
}

export interface RecurringResponse {
  items: RecurringItem[];
  subscriptions_monthly_cents: number;
  recurring_expenses_monthly_cents: number;
  recurring_income_monthly_cents: number;
  monthly_total_cents: number;
}

export type LineKind = "expense" | "income" | "salary" | "info";

export interface BudgetPeriod {
  id: number;
  name: string;
  months: number;
  start_month: string | null;
  position: number;
}

export interface BudgetLine {
  id: number;
  section: string;
  name: string;
  kind: LineKind;
  category_id: number | null;
  match: string | null;
  once_cents: number | null;
  position: number;
  scope: "vie" | "alternance";
  /** Premier / dernier mois (AAAA-MM) où le poste s'applique ; null = sans borne. */
  from_month: string | null;
  until_month: string | null;
  /** id de période → centimes */
  amounts: Record<string, number>;
}

export interface Budget {
  id: number;
  name: string;
  notes: string;
  is_active: boolean;
  created_at: string;
  periods: BudgetPeriod[];
  lines: BudgetLine[];
  /** Mois (AAAA-MM) → id de période. */
  calendar: Record<string, number>;
}

export interface LineTrack {
  line_id: number;
  planned_cents: number | null;
  actual_cents: number | null;
  detected_cents: number | null;
  count: number;
  last_day: string | null;
}

export interface CatTrack {
  category_id: number | null;
  actual_cents: number;
  detected_cents: number;
  count: number;
}

export interface Tracking {
  month: string;
  months: string[];
  is_current_month: boolean;
  period: BudgetPeriod | null;
  period_auto: boolean;
  lines: LineTrack[];
  unbudgeted: CatTrack[];
  unbudgeted_income: CatTrack[];
  actual_expense_cents: number;
  actual_income_cents: number;
  suggestions: RecurringItem[];
}

export interface LineInput {
  section?: string;
  name?: string;
  kind?: LineKind;
  category_id?: number | null;
  match?: string | null;
  once_cents?: number | null;
  position?: number;
  amounts?: Record<string, number | null>;
  scope?: "vie" | "alternance";
  from_month?: string | null;
  until_month?: string | null;
}

export interface Tx {
  id: number;
  day: string;
  label: string;
  counterparty: string | null;
  merchant: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  account_id: string;
  bank: string;
  category_id: number | null;
  category_source: Source | null;
  category_confidence: number | null;
  kind: Kind;
  excluded: boolean;
}

export interface TxPage {
  total: number;
  income_cents: number;
  expenses_cents: number;
  items: Tx[];
}

export interface Rule {
  id: number;
  pattern: string;
  category_id: number;
  created_at: string;
  matches: number;
}

export interface RuleSuggestion {
  key: string;
  patterns: string[];
  category_id: number | null;
  share: number;
  matches: number;
  months: number;
  recategorized: number;
  reason: "similar" | "recurring" | "frequent";
  merchants: string[];
  categories: { category_id: number | null; count: number }[];
}

export interface CatStats {
  rule: number;
  memory: number;
  transfer: number;
  remaining: number;
}

export interface AiDecision {
  merchant: string;
  debit: boolean;
  category_id: number;
  confidence: number;
  count: number;
}

export interface AiProgress {
  running: boolean;
  done: number;
  total: number;
  classified: number;
  transactions: number;
  batches_total: number;
  batches_done: number;
  failures: number;
  model: string | null;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
  recent: AiDecision[];
}

export interface Status {
  syncing: boolean;
  last_sync_message: string | null;
  enable_banking: boolean;
  ai: {
    enabled: boolean;
    health: { provider: "vllm" | "ollama"; url: string; reachable: boolean; model_installed: boolean; model: string; models: string[] } | null;
    progress: AiProgress;
  };
  counts: { transactions: number; uncategorized: number; to_review: number };
}

export interface MarketPoint {
  day: string;
  close: number;
}

export interface MarketWatch {
  id: number;
  provider: "fred" | "alphavantage";
  symbol: string;
  name: string;
  currency: string;
  fetched_at: string | null;
  last_error: string | null;
  last: MarketPoint | null;
  previous: MarketPoint | null;
  change_1y: number | null;
}

export interface Portfolio {
  patterns: string;
  deposits_cents: number;
  withdrawals_cents: number;
  net_invested_cents: number;
  monthly: { month: string; deposits_cents: number; withdrawals_cents: number; cumulative_net_cents: number }[];
  valuations: { day: string; value_cents: number; gain_cents: number | null }[];
  latest: { day: string; value_cents: number; gain_cents: number | null } | null;
  gain_cents: number | null;
}

export interface Bank {
  name: string;
  country: string;
  beta: boolean;
}

export class ApiError extends Error {}

let onUnauthorized: (() => void) | undefined;
export const setUnauthorizedHandler = (f: () => void) => (onUnauthorized = f);

export interface Me {
  authenticated: boolean;
  local: boolean;
  has_passkeys: boolean;
  public_url: string;
  public_dashboard?: boolean;
}

export interface Devices {
  passkeys: { id: number; name: string; created_at: string; last_used_at: string | null }[];
  sessions: {
    id: number;
    passkey_name: string | null;
    user_agent: string | null;
    ip: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non JSON */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? (text || `HTTP ${res.status}`);
    // Session expirée ou révoquée (accès distant) : retour à l'écran de connexion.
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
    throw new ApiError(msg);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface TxFilters {
  month?: string;
  category?: string;
  account?: string;
  q?: string;
  kind?: string;
  source?: string;
  hide_transfers?: boolean;
  excluded?: string;
  budget?: string;
}

export const api = {
  me: () => call<Me>("GET", "/auth/me"),
  loginStart: () => call<{ id: string; options: { publicKey: Record<string, unknown> } }>("POST", "/auth/login/start", {}),
  loginFinish: (id: string, credential: unknown) => call<{ ok: true }>("POST", "/auth/login/finish", { id, credential }),
  registerStart: (token: string) =>
    call<{ id: string; options: { publicKey: Record<string, unknown> } }>("POST", "/auth/register/start", { token }),
  registerFinish: (id: string, token: string, name: string, credential: unknown) =>
    call<{ ok: true }>("POST", "/auth/register/finish", { id, token, name, credential }),
  logout: () => call<{ ok: true }>("POST", "/auth/logout", {}),
  devices: () => call<Devices>("GET", "/devices"),
  enrollLink: () => call<{ url: string; expires_at: string; qr_svg: string }>("POST", "/devices/enroll", {}),
  renamePasskey: (id: number, name: string) => call<{ ok: true }>("PATCH", `/devices/passkeys/${id}`, { name }),
  deletePasskey: (id: number) => call<{ ok: true }>("DELETE", `/devices/passkeys/${id}`),
  revokeSession: (id: number) => call<{ ok: true }>("DELETE", `/devices/sessions/${id}`),
  status: () => call<Status>("GET", "/status"),
  accounts: () => call<Account[]>("GET", "/accounts"),
  summary: (month?: string) => call<Summary>("GET", `/summary${qs({ month })}`),
  trends: (months = 12) => call<Trends>("GET", `/trends${qs({ months })}`),
  recurring: () => call<RecurringResponse>("GET", "/recurring"),
  addManualRecurring: (r: { name: string; pattern: string; cadence: string; kind: string; category_id?: number | null; expected_cents?: number | null }) =>
    call<{ id: number }>("POST", "/recurring/manual", r),
  deleteManualRecurring: (id: number) => call<{ ok: true }>("DELETE", `/recurring/manual/${id}`),
  transactions: (f: TxFilters, limit = 100, offset = 0) =>
    call<TxPage>("GET", `/transactions${qs({ ...f, limit, offset })}`),
  setExcluded: (id: number, excluded: boolean) => call<{ excluded: boolean }>("PATCH", `/transactions/${id}`, { excluded }),
  setCategory: (id: number, category_id: number | null) =>
    call<{ similar_updated: number; stats: CatStats }>("PATCH", `/transactions/${id}`, { category_id }),
  categories: () => call<Category[]>("GET", "/categories"),
  createCategory: (c: Partial<Category>) => call<{ id: number }>("POST", "/categories", c),
  updateCategory: (id: number, c: Partial<Category>) => call<{ ok: true }>("PATCH", `/categories/${id}`, c),
  deleteCategory: (id: number) => call<{ ok: true }>("DELETE", `/categories/${id}`),
  rules: () => call<Rule[]>("GET", "/rules"),
  createRule: (pattern: string, category_id: number) =>
    call<{ id: number; stats: CatStats }>("POST", "/rules", { pattern, category_id }),
  deleteRule: (id: number) => call<{ ok: true }>("DELETE", `/rules/${id}`),
  createRules: (patterns: string[], category_id: number) =>
    call<{ ok: true; stats: CatStats }>("POST", "/rules/batch", { patterns, category_id }),
  ruleSuggestions: () => call<{ items: RuleSuggestion[]; dismissed: number }>("GET", "/rules/suggestions"),
  dismissSuggestion: (key: string) => call<{ ok: true }>("POST", "/rules/suggestions/dismiss", { key }),
  resetSuggestions: () => call<{ ok: true }>("DELETE", "/rules/suggestions"),
  sync: () => call<{ started: boolean }>("POST", "/sync", {}),
  cancelClassify: () => call<{ cancelling: boolean }>("POST", "/classify/cancel", {}),
  classify: (reclassify = false) => call<{ stats: CatStats; ai_started: boolean }>("POST", "/classify", { reclassify }),
  budgets: () => call<Budget[]>("GET", "/budgets"),
  budget: (id: number) => call<Budget>("GET", `/budgets/${id}`),
  createBudget: (b: { name: string; mode: "empty" | "detected" | "copy"; source_id?: number; periods?: { name: string; months: number }[] }) =>
    call<{ id: number }>("POST", "/budgets", b),
  updateBudget: (id: number, b: { name?: string; notes?: string; is_active?: boolean }) => call<{ ok: true }>("PATCH", `/budgets/${id}`, b),
  deleteBudget: (id: number) => call<{ ok: true }>("DELETE", `/budgets/${id}`),
  tracking: (id: number, month?: string, period?: number) => call<Tracking>("GET", `/budgets/${id}/tracking${qs({ month, period })}`),
  updateCalendar: (budgetId: number, months: Record<string, number | null>) =>
    call<{ ok: true }>("PATCH", `/budgets/${budgetId}/calendar`, months),
  addPeriod: (budgetId: number, p: { name: string; months: number; start_month?: string | null }) =>
    call<{ id: number }>("POST", `/budgets/${budgetId}/periods`, p),
  updatePeriod: (id: number, p: { name?: string; months?: number; start_month?: string | null }) =>
    call<{ ok: true }>("PATCH", `/budget-periods/${id}`, p),
  deletePeriod: (id: number) => call<{ ok: true }>("DELETE", `/budget-periods/${id}`),
  addLine: (budgetId: number, l: LineInput & { name: string; kind: LineKind }) => call<{ id: number }>("POST", `/budgets/${budgetId}/lines`, l),
  updateLine: (id: number, l: LineInput) => call<{ ok: true }>("PATCH", `/budget-lines/${id}`, l),
  deleteLine: (id: number) => call<{ ok: true }>("DELETE", `/budget-lines/${id}`),
  market: () => call<{ items: MarketWatch[]; alphavantage_key: boolean; fred_key: boolean }>("GET", "/market"),
  marketHistory: (id: number, since?: string) => call<MarketPoint[]>("GET", `/market/${id}/history${qs({ since })}`),
  marketRefresh: (id: number) => call<{ points: number }>("POST", `/market/${id}/refresh`, {}),
  marketAdd: (w: { provider: string; symbol: string; name: string; currency: string }) => call<{ id: number }>("POST", "/market", w),
  marketRemove: (id: number) => call<{ ok: true }>("DELETE", `/market/${id}`),
  portfolio: () => call<Portfolio>("GET", "/portfolio"),
  portfolioPatterns: (patterns: string) => call<{ ok: true }>("PATCH", "/portfolio", { patterns }),
  addValuation: (value_cents: number, gain_cents?: number | null, day?: string) =>
    call<{ ok: true }>("POST", "/portfolio/valuations", { value_cents, gain_cents, day }),
  deleteValuation: (day: string) => call<{ ok: true }>("DELETE", `/portfolio/valuations/${day}`),
  banks: () => call<Bank[]>("GET", "/banks"),
  connect: (name: string, country: string) => call<{ url: string }>("POST", "/connect", { name, country }),
};
