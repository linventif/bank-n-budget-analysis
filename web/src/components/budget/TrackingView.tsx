import { createMemo, createSignal, For, Show } from "solid-js";
import { api, type Budget, type BudgetLine, type LineTrack, type RecurringItem, type Tracking } from "../../api";
import { activeIn, periodTotals, sections } from "../../budget";
import { dayLabel, money, money0, monthLong, percent } from "../../format";
import { errorText, store } from "../../store";
import { Card, CategoryIcon, Empty, Ico } from "../ui";
import type { LineDraft } from "./LineDialog";

const CADENCE: Record<RecurringItem["cadence"], string> = { weekly: "hebdo", monthly: "mensuel", quarterly: "trimestriel", yearly: "annuel" };
export const cadenceLabel = (c: RecurringItem["cadence"]) => CADENCE[c];

/**
 * Budget dynamique : pour le mois choisi, ce que tu vises (prévu), ce qui s'est passé (réel)
 * et ce que les mois précédents montrent (détecté = moyenne des 3 mois précédents).
 */
export function TrackingView(props: {
  budget: Budget;
  tracking: Tracking;
  loading: boolean;
  onMonth: (m: string) => void;
  onPeriod: (id: number | null) => void;
  onChange: () => void;
  onEditLine: (d: LineDraft) => void;
}) {
  const t = () => props.tracking;
  const [scopeFilter, setScopeFilter] = createSignal<"all" | "vie" | "alternance">("all");
  const period = () => t().period;
  const byLine = createMemo(() => new Map(t().lines.map((x) => [x.line_id, x])));
  const planned = createMemo(() => (period() ? periodTotals(props.budget, period()!.id, undefined, t().month) : null));
  const idx = () => t().months.indexOf(t().month);

  // Ce qui reste à payer d'ici la fin du mois, d'après les postes de dépense pas encore (entièrement) passés.
  const remaining = createMemo(() =>
    props.budget.lines
      .filter((l) => l.kind === "expense")
      .reduce((a, l) => {
        const tr = byLine().get(l.id);
        if (!tr || tr.planned_cents == null || tr.actual_cents == null) return a;
        return a + Math.max(tr.planned_cents - tr.actual_cents, 0);
      }, 0),
  );
  const unbudgetedTotal = () => t().unbudgeted.reduce((a, c) => a + Math.max(c.actual_cents, 0), 0);

  const setPlanned = async (l: BudgetLine, cents: number) => {
    if (!period()) return;
    try {
      await api.updateLine(l.id, { amounts: { [String(period()!.id)]: cents } });
      store.toast(`« ${l.name} » : ${money(cents)} prévus pour ${period()!.name}`, "success");
      props.onChange();
    } catch (e) {
      store.toast(errorText(e), "error");
    }
  };
  const draftFor = (p: Partial<LineDraft> & { name: string }): LineDraft => ({
    section: "",
    kind: "expense",
    category_id: null,
    match: null,
    once_cents: null,
    amounts: {},
    ...p,
  });
  const roundCents = (c: number) => Math.round(c / 100) * 100;

  return (
    <div class={`flex flex-col gap-5 ${props.loading ? "refetching" : ""}`}>
      {/* Filtres : mois et période, au-dessus de tout ce qu'ils pilotent */}
      <div class="flex flex-wrap items-center gap-2">
        <div class="join">
          <button class="btn btn-sm join-item" disabled={idx() <= 0} onClick={() => props.onMonth(t().months[idx() - 1])} aria-label="Mois précédent">
            <Ico icon="lucide:chevron-left" />
          </button>
          <select class="select select-sm join-item w-44" value={t().month} onChange={(e) => props.onMonth(e.currentTarget.value)} aria-label="Mois">
            <For each={[...t().months].reverse()}>{(m) => <option value={m}>{monthLong(m)}</option>}</For>
          </select>
          <button class="btn btn-sm join-item" disabled={idx() >= t().months.length - 1} onClick={() => props.onMonth(t().months[idx() + 1])} aria-label="Mois suivant">
            <Ico icon="lucide:chevron-right" />
          </button>
        </div>
        <Show when={props.budget.periods.length > 1}>
          <select
            class="select select-sm w-auto"
            aria-label="Période du budget"
            value={t().period_auto ? "" : String(period()?.id ?? "")}
            onChange={(e) => props.onPeriod(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
          >
            <option value="">
              Période : automatique ({period()?.name}
              {props.budget.calendar?.[t().month] != null ? " · calendrier" : ""})
            </option>
            <For each={props.budget.periods}>{(p) => <option value={String(p.id)}>Période : {p.name}</option>}</For>
          </select>
        </Show>
        <span class="text-muted ml-auto text-xs">
          <span class="text-ink-2 font-medium">Prévu</span> = ce que tu vises · <span class="text-ink-2 font-medium">Détecté</span> = moyenne des 3 mois précédents
        </span>
      </div>

      {/* Synthèse */}
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Dépenses"
          value={t().actual_expense_cents}
          target={planned()?.expense ?? null}
          color="var(--series-1)"
          note={t().is_current_month && remaining() > 0 ? `encore ${money0(remaining())} prévus d'ici la fin du mois` : undefined}
          lowerIsBetter
        />
        <Kpi label="Revenus" value={t().actual_income_cents} target={planned() ? planned()!.income + planned()!.salary : null} color="var(--series-2)" />
        <div class="card-surface flex flex-col gap-1.5 p-5">
          <div class="text-ink-2 text-sm">Solde du mois</div>
          <div class={`text-3xl leading-none font-semibold ${t().actual_income_cents - t().actual_expense_cents >= 0 ? "text-gain" : "text-error"}`}>
            {money0(t().actual_income_cents - t().actual_expense_cents)}
          </div>
          <Show when={planned()}>
            <div class="text-muted text-sm">prévu : {money0(planned()!.available)} disponibles</div>
          </Show>
        </div>
        <div class="card-surface flex flex-col gap-1.5 p-5">
          <div class="text-ink-2 text-sm">Hors budget</div>
          <div class="text-3xl leading-none font-semibold">{money0(unbudgetedTotal())}</div>
          <div class="text-muted text-sm">dépenses sans poste ce mois-ci</div>
        </div>
      </div>

      {/* Postes par section */}
      <Card
        title={`Postes · ${period()?.name ?? ""}`}
        subtitle={`${monthLong(t().month)} · clique sur un poste pour régler son suivi`}
        class="!p-0 [&>header]:px-5 [&>header]:pt-5"
        actions={
          <Show when={props.budget.lines.some((l) => l.scope === "alternance")}>
            <div class="tabs tabs-box tabs-xs" role="radiogroup" aria-label="Périmètre">
              <For each={[{ v: "all", l: "Tout" }, { v: "vie", l: "Vie courante" }, { v: "alternance", l: "Alternance" }] as const}>
                {(s) => (
                  <button role="radio" aria-checked={scopeFilter() === s.v} class={`tab ${scopeFilter() === s.v ? "tab-active" : ""}`} onClick={() => setScopeFilter(s.v)}>
                    {s.l}
                  </button>
                )}
              </For>
            </div>
          </Show>
        }
      >
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-muted border-base-200 border-b text-xs">
                <th class="px-5 py-2 text-left font-medium">Poste</th>
                <th class="px-3 py-2 text-right font-medium">Prévu</th>
                <th class="px-3 py-2 text-right font-medium">Réel</th>
                <th class="hidden px-3 py-2 text-right font-medium sm:table-cell">Détecté</th>
                <th class="hidden w-40 px-3 py-2 text-left font-medium md:table-cell">Avancement</th>
                <th class="hidden px-5 py-2 text-right font-medium sm:table-cell">État</th>
              </tr>
            </thead>
            <tbody>
              <For each={sections(props.budget.lines.filter((l) => (scopeFilter() === "all" || (l.scope ?? "vie") === scopeFilter()) && activeIn(l, t().month)))}>
                {(s) => (
                  <>
                    <tr class="bg-base-200/60">
                      <td colspan={6} class="text-muted px-5 py-1.5 text-[11px] font-semibold tracking-wide uppercase">
                        {s.name || "Sans section"}
                      </td>
                    </tr>
                    <For each={s.lines}>
                      {(l) => (
                        <LineRow
                          line={l}
                          track={byLine().get(l.id)}
                          current={t().is_current_month}
                          onEdit={() =>
                            props.onEditLine({
                              id: l.id,
                              section: l.section,
                              name: l.name,
                              kind: l.kind,
                              category_id: l.category_id,
                              match: l.match,
                              once_cents: l.once_cents,
                              amounts: { ...l.amounts },
                              scope: l.scope,
                              from_month: l.from_month,
                              until_month: l.until_month,
                            })
                          }
                          onSetPlanned={(c) => setPlanned(l, c)}
                        />
                      )}
                    </For>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>

      <div class="grid gap-5 lg:grid-cols-2">
        <Card title="Hors budget" subtitle="Dépenses du mois rattachées à aucun poste">
          <Show when={t().unbudgeted.some((c) => c.actual_cents > 0 || c.detected_cents > 0)} fallback={<Empty icon="lucide:circle-check" title="Tout est budgété" />}>
            <ul class="flex flex-col">
              <For each={t().unbudgeted.filter((c) => c.actual_cents > 0 || c.detected_cents > 0)}>
                {(c) => {
                  const cat = () => (c.category_id != null ? store.categoryById().get(c.category_id) : null);
                  return (
                    <li class="flex items-center gap-3 py-1.5">
                      <CategoryIcon category={cat()} size="sm" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm">{cat()?.name ?? "Non classé"}</div>
                        <div class="text-muted text-xs">
                          {c.count} opération{c.count > 1 ? "s" : ""} · détecté {money0(c.detected_cents)}/mois
                        </div>
                      </div>
                      <span class="num text-sm font-semibold">{money0(c.actual_cents)}</span>
                      <Show when={c.category_id != null}>
                        <button
                          class="btn btn-ghost btn-xs"
                          title="Créer un poste pour cette catégorie"
                          onClick={() =>
                            props.onEditLine(
                              draftFor({
                                name: cat()?.name ?? "Poste",
                                section: "Courant",
                                category_id: c.category_id,
                                amounts: period() ? { [String(period()!.id)]: roundCents(c.detected_cents || c.actual_cents) } : {},
                              }),
                            )
                          }
                        >
                          <Ico icon="lucide:plus" /> Budget
                        </button>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </Card>

        <Card title="Récurrents hors budget" subtitle="Abonnements et paiements réguliers détectés, sans poste">
          <Show when={t().suggestions.length} fallback={<Empty icon="lucide:repeat" title="Tous tes paiements réguliers sont budgétés" />}>
            <ul class="flex flex-col">
              <For each={t().suggestions}>
                {(r) => (
                  <li class="flex items-center gap-3 py-1.5">
                    <CategoryIcon category={r.category_id != null ? store.categoryById().get(r.category_id) : null} size="sm" />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm">{r.name}</div>
                      <div class="text-muted text-xs">
                        {r.kind === "income" ? "revenu" : r.fixed ? "abonnement" : "dépense régulière"} · {cadenceLabel(r.cadence)} · {money(r.amount_cents)}
                      </div>
                    </div>
                    <span class="num text-sm font-semibold">{money0(r.monthly_cents)}/mois</span>
                    <button
                      class="btn btn-ghost btn-xs"
                      title="Ajouter au budget"
                      onClick={() =>
                        props.onEditLine(
                          draftFor({
                            name: r.name,
                            section: r.kind === "income" ? "Aides" : r.fixed ? "Abonnements" : "Dépenses régulières",
                            kind: r.kind === "income" ? "income" : "expense",
                            match: r.merchant,
                            category_id: r.category_id,
                            amounts: period() ? { [String(period()!.id)]: r.monthly_cents } : {},
                          }),
                        )
                      }
                    >
                      <Ico icon="lucide:plus" /> Budget
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Card>
      </div>
    </div>
  );
}

function Kpi(props: { label: string; value: number; target: number | null; color: string; note?: string; lowerIsBetter?: boolean }) {
  const ratio = () => (props.target ? props.value / props.target : null);
  const over = () => props.lowerIsBetter && (ratio() ?? 0) > 1;
  return (
    <div class="card-surface flex flex-col gap-1.5 p-5">
      <div class="text-ink-2 text-sm">{props.label}</div>
      <div class="flex items-baseline gap-2">
        <span class="text-3xl leading-none font-semibold">{money0(props.value)}</span>
        <Show when={props.target != null}>
          <span class="text-muted text-sm">/ {money0(props.target!)} prévus</span>
        </Show>
      </div>
      <Show when={ratio() != null}>
        <div
          class="h-1.5 overflow-hidden rounded-full"
          style={{ background: `color-mix(in oklab, ${props.color} 16%, var(--color-base-100))` }}
          role="meter"
          aria-valuenow={props.value}
          aria-valuemin={0}
          aria-valuemax={props.target!}
          aria-label={`${props.label} : ${percent(ratio()!)} du prévu`}
        >
          <div class="h-full rounded-full" style={{ width: `${Math.min(ratio()!, 1) * 100}%`, background: over() ? "var(--color-error)" : props.color }} />
        </div>
      </Show>
      <Show when={props.note || over()}>
        <div class={`flex items-center gap-1 text-xs ${over() ? "text-error" : "text-muted"}`}>
          <Show when={over()}>
            <Ico icon="lucide:circle-alert" />
          </Show>
          {over() ? `${money0(props.value - props.target!)} au-dessus du prévu` : props.note}
        </div>
      </Show>
    </div>
  );
}

function LineRow(props: { line: BudgetLine; track: LineTrack | undefined; current: boolean; onEdit: () => void; onSetPlanned: (c: number) => void }) {
  const l = () => props.line;
  const tr = () => props.track;
  const planned = () => tr()?.planned_cents ?? null;
  const actual = () => tr()?.actual_cents ?? null;
  const detected = () => tr()?.detected_cents ?? null;
  const income = () => l().kind === "income" || l().kind === "salary";
  const ratio = () => (planned() && actual() != null ? actual()! / planned()! : null);
  const color = () => (income() ? "var(--series-2)" : (ratio() ?? 0) > 1.1 ? "var(--color-error)" : (ratio() ?? 0) > 1 ? "var(--color-warning)" : "var(--series-1)");

  // Écart notable entre ce que tu vises et ce qui est détecté : proposer d'ajuster.
  const suggestion = () => {
    const d = detected();
    const p = planned();
    if (!d || d < 100 || l().once_cents != null) return null;
    if (p == null) return d;
    const gap = Math.abs(d - p);
    return gap > 300 && gap / Math.max(p, 1) > 0.15 ? d : null;
  };

  const state = () => {
    const a = actual();
    const p = planned();
    if (a == null) return { icon: "lucide:unlink", text: "non relié", cls: "text-muted" };
    if (l().kind === "info") return { icon: "", text: a ? `${tr()!.count} op.` : "", cls: "text-muted" };
    if (!p) return { icon: "", text: a ? "hors prévision" : "", cls: "text-muted" };
    if (income()) {
      if (a >= p * 0.95) return { icon: "lucide:circle-check", text: "reçu", cls: "text-gain" };
      if (a === 0) return { icon: "lucide:clock", text: props.current ? "attendu" : "pas reçu", cls: "text-ink-2" };
      return { icon: "lucide:circle-dashed", text: "partiel", cls: "text-ink-2" };
    }
    if (a > p * 1.1) return { icon: "lucide:circle-alert", text: `+${money0(a - p)}`, cls: "text-error" };
    if (a >= p * 0.9) return { icon: "lucide:circle-check", text: a > p ? "payé, un peu plus" : "payé", cls: "text-gain" };
    if (a === 0) return { icon: "lucide:clock", text: props.current ? "à venir" : "rien vu", cls: "text-ink-2" };
    return { icon: "lucide:circle-dashed", text: `reste ${money0(p - a)}`, cls: "text-ink-2" };
  };

  return (
    <tr class={`border-base-200 hover:bg-base-200/30 border-b ${l().kind === "info" ? "text-muted" : ""}`}>
      <td class="px-3 py-2 sm:px-5">
        <button class="group flex min-w-0 items-center gap-2.5 text-left" onClick={props.onEdit}>
          <Show when={l().category_id != null} fallback={<span class="size-7 shrink-0" />}>
            <CategoryIcon category={store.categoryById().get(l().category_id!)} size="sm" />
          </Show>
          <span class="min-w-0">
            <span class="block truncate group-hover:underline">{l().name}</span>
            <Show when={tr()?.last_day}>
              <span class="text-muted block text-[11px]">dernier le {dayLabel(tr()!.last_day!)}</span>
            </Show>
          </span>
        </button>
      </td>
      <td class="num px-3 py-2 text-right whitespace-nowrap">{planned() != null ? money(planned()!) : "—"}</td>
      <td class={`num px-3 py-2 text-right font-semibold whitespace-nowrap ${income() && actual() ? "text-gain" : ""}`}>{actual() != null ? money(actual()!) : "—"}</td>
      <td class="num text-ink-2 hidden px-3 py-2 text-right whitespace-nowrap sm:table-cell">
        {detected() != null ? money(detected()!) : "—"}
        <Show when={suggestion() != null && l().kind !== "info"}>
          <button class="btn btn-ghost btn-xs ml-1 h-auto min-h-0 px-1.5 py-0.5 text-[11px]" title="Prendre la valeur détectée comme objectif" onClick={() => props.onSetPlanned(suggestion()!)}>
            viser
          </button>
        </Show>
      </td>
      <td class="hidden px-3 py-2 md:table-cell">
        <Show when={ratio() != null}>
          <div
            class="h-2 overflow-hidden rounded-full"
            style={{ background: `color-mix(in oklab, ${income() ? "var(--series-2)" : "var(--series-1)"} 16%, var(--color-base-100))` }}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={planned()!}
            aria-valuenow={actual()!}
            aria-label={`${l().name} : ${percent(ratio()!)} du prévu`}
          >
            <div class="h-full rounded-full" style={{ width: `${Math.min(ratio()!, 1) * 100}%`, background: color() }} />
          </div>
        </Show>
      </td>
      <td class={`hidden px-5 py-2 text-right text-xs whitespace-nowrap sm:table-cell ${state().cls}`}>
        <span class="inline-flex items-center gap-1">
          <Show when={state().icon}>
            <Ico icon={state().icon} />
          </Show>
          {state().text}
        </span>
      </td>
    </tr>
  );
}
