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
}

export interface Account {
  id: string;
  bank: string;
  name: string | null;
  product: string | null;
  iban: string | null;
  currency: string;
  balance_cents: number | null;
  balance_date: string | null;
  last_sync: string | null;
  last_error: string | null;
  valid_until: string | null;
  expired: boolean;
  tx_count: number;
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
  totals: Totals;
  prev: Totals;
  avg: Totals;
  avg_months: number;
  by_category: CatAmount[];
  income_by_category: CatAmount[];
  monthly: (Totals & { month: string })[];
  cumulative_current: number[];
  cumulative_average: number[];
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
  amount_cents: number;
  average_cents: number;
  occurrences: number;
  last_day: string;
  next_day: string | null;
  interval_days: number;
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

export interface CatStats {
  rule: number;
  memory: number;
  transfer: number;
  remaining: number;
}

export interface AiProgress {
  running: boolean;
  done: number;
  total: number;
  classified: number;
  message: string | null;
  finished_at: string | null;
}

export interface Status {
  syncing: boolean;
  last_sync_message: string | null;
  enable_banking: boolean;
  ai: {
    enabled: boolean;
    health: { reachable: boolean; model_installed: boolean; model: string; models: string[] } | null;
    progress: AiProgress;
  };
  counts: { transactions: number; uncategorized: number; to_review: number };
}

export interface Bank {
  name: string;
  country: string;
  beta: boolean;
}

export class ApiError extends Error {}

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
    throw new ApiError(msg);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined | null | false>) => {
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
}

export const api = {
  status: () => call<Status>("GET", "/status"),
  accounts: () => call<Account[]>("GET", "/accounts"),
  summary: (month?: string) => call<Summary>("GET", `/summary${qs({ month })}`),
  trends: (months = 12) => call<Trends>("GET", `/trends${qs({ months })}`),
  recurring: () => call<{ items: RecurringItem[]; monthly_total_cents: number }>("GET", "/recurring"),
  transactions: (f: TxFilters, limit = 100, offset = 0) =>
    call<TxPage>("GET", `/transactions${qs({ ...f, limit, offset })}`),
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
  sync: () => call<{ started: boolean }>("POST", "/sync", {}),
  classify: (reclassify = false) => call<{ stats: CatStats; ai_started: boolean }>("POST", "/classify", { reclassify }),
  banks: () => call<Bank[]>("GET", "/banks"),
  connect: (name: string, country: string) => call<{ url: string }>("POST", "/connect", { name, country }),
};
