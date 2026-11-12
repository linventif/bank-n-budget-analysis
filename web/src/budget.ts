// Calculs du budget, identiques à ceux du tableau d'origine :
//   reste à charge = dépenses − aides ; disponible = salaire − reste à charge.

import type { Budget, BudgetLine, LineKind } from "./api";

export const KIND_LABEL: Record<LineKind, string> = {
  expense: "Dépense",
  income: "Aide / revenu",
  salary: "Salaire",
  info: "Info (non comptée)",
};

export const amountOf = (l: BudgetLine, periodId: number | null | undefined) =>
  periodId == null ? null : l.amounts[String(periodId)] ?? null;

export interface Totals {
  expense: number;
  income: number;
  salary: number;
  charge: number;
  available: number;
}

const sum = (lines: BudgetLine[], kind: LineKind, value: (l: BudgetLine) => number) =>
  lines.filter((l) => l.kind === kind).reduce((a, l) => a + value(l), 0);

const totalsOf = (lines: BudgetLine[], value: (l: BudgetLine) => number): Totals => {
  const expense = sum(lines, "expense", value);
  const income = sum(lines, "income", value);
  const salary = sum(lines, "salary", value);
  return { expense, income, salary, charge: expense - income, available: salary - (expense - income) };
};

export type Scope = "vie" | "alternance";
const scoped = (b: Budget, scope?: Scope) => (scope ? b.lines.filter((l) => (l.scope ?? "vie") === scope) : b.lines);

/** Totaux mensuels d'une période (éventuellement limités à un périmètre, ou aux postes actifs un mois donné). */
export const periodTotals = (b: Budget, periodId: number, scope?: Scope, month?: string) =>
  totalsOf(scoped(b, scope), (l) => (month && !activeIn(l, month) ? 0 : (amountOf(l, periodId) ?? 0)));

/** Montants annuels / ponctuels ramenés au mois (÷ 12), par type. */
export const annualMonthly = (b: Budget, scope?: Scope) => totalsOf(scoped(b, scope), (l) => Math.round((l.once_cents ?? 0) / 12));

/** Le poste s'applique-t-il à ce mois (AAAA-MM) ? */
export const activeIn = (l: BudgetLine, month: string) =>
  (!l.from_month || month >= l.from_month) && (!l.until_month || month <= l.until_month);

/**
 * Total d'un poste sur l'ensemble du budget : montant × mois de chaque période + ponctuel.
 * Un poste borné (ex. « dès janvier ») ne compte que les mois du calendrier dans sa plage ;
 * sans calendrier, impossible de savoir quels mois sont concernés : on compte toute la période.
 */
export const lineTotal = (b: Budget, l: BudgetLine) => {
  const cal = Object.entries(b.calendar ?? {});
  const bounded = (l.from_month || l.until_month) && cal.length > 0;
  const monthly = bounded
    ? cal.reduce((a, [m, pid]) => a + (activeIn(l, m) ? (amountOf(l, pid) ?? 0) : 0), 0)
    : b.periods.reduce((a, p) => a + (amountOf(l, p.id) ?? 0) * p.months, 0);
  return monthly + (l.once_cents ?? 0);
};

/** « dès janv. 27 », « jusqu'à juin 27 », « janv. 27 → juin 27 » ; vide sans borne. */
export const rangeLabel = (l: { from_month?: string | null; until_month?: string | null }, fmt: (m: string) => string) =>
  l.from_month && l.until_month
    ? `${fmt(l.from_month)} → ${fmt(l.until_month)}`
    : l.from_month
      ? `dès ${fmt(l.from_month)}`
      : l.until_month
        ? `jusqu'à ${fmt(l.until_month)}`
        : "";

export const budgetTotals = (b: Budget) => totalsOf(b.lines, (l) => lineTotal(b, l));

export const totalMonths = (b: Budget) => b.periods.reduce((a, p) => a + p.months, 0);

/** Postes regroupés par section, dans l'ordre d'apparition. */
export const sections = (lines: BudgetLine[]) => {
  const out: { name: string; lines: BudgetLine[] }[] = [];
  for (const l of [...lines].sort((a, b) => a.position - b.position || a.id - b.id)) {
    const g = out.find((s) => s.name === l.section);
    if (g) g.lines.push(l);
    else out.push({ name: l.section, lines: [l] });
  }
  return out;
};

/** « 550 » / « 2,5 » / « 1 584,60 » → centimes ; vide → null ; invalide → undefined. */
export const parseEuros = (raw: string): number | null | undefined => {
  const s = raw.replace(/\s| |€/g, "").replace(",", ".");
  if (s === "") return null;
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
};

export const formatEuros = (cents: number | null | undefined) =>
  cents == null ? "" : (cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
