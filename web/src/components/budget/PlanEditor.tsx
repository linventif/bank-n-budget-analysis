import { createMemo, createSignal, For, Show } from "solid-js";
import { api, type Budget, type BudgetLine, type BudgetPeriod } from "../../api";
import { amountOf, annualMonthly, budgetTotals, KIND_LABEL, lineTotal, periodTotals, rangeLabel, totalMonths } from "../../budget";
import { money, monthShortYear } from "../../format";
import { errorText, store } from "../../store";
import { EuroInput } from "../EuroInput";
import { CategoryIcon, Ico, IconButton } from "../ui";
import type { LineDraft } from "./LineDialog";

/**
 * Le budget comme un tableur : postes en lignes (groupés par section), périodes en colonnes,
 * montants modifiables directement, totaux calculés comme dans le tableau d'origine.
 */
export function PlanEditor(props: { budget: Budget; onChange: () => void; onEditLine: (d: LineDraft) => void }) {
  const b = () => props.budget;
  const run = async (p: Promise<unknown>) => {
    try {
      await p;
      props.onChange();
    } catch (e) {
      store.toast(errorText(e), "error");
      props.onChange();
    }
  };

  // Clés de section (chaînes stables) : les lignes déjà affichées ne sont pas recréées après un enregistrement.
  const sectionNames = createMemo(() => {
    const names: string[] = [];
    for (const l of [...b().lines].sort((x, y) => x.position - y.position || x.id - y.id)) if (!names.includes(l.section)) names.push(l.section);
    return names;
  });
  const linesOf = (section: string) =>
    b()
      .lines.filter((l) => l.section === section)
      .sort((x, y) => x.position - y.position || x.id - y.id);

  const draftOf = (l: BudgetLine): LineDraft => ({
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
  });
  const newLine = (section: string) =>
    props.onEditLine({ section, name: "", kind: "expense", category_id: null, match: null, once_cents: null, amounts: {} });

  const renameSection = (from: string, to: string) => {
    const name = to.trim();
    if (name === from) return;
    run(Promise.all(linesOf(from).map((l) => api.updateLine(l.id, { section: name }))));
  };

  const cols = () => b().periods.length + 4;
  const totals = createMemo(() => b().periods.map((p) => periodTotals(b(), p.id)));
  const grand = createMemo(() => budgetTotals(b()));
  const annual = createMemo(() => annualMonthly(b()));
  // Budget « après l'alternance » : uniquement les postes de vie courante, annuels lissés compris.
  const after = createMemo(() =>
    b().periods.map((p) => {
      const t = periodTotals(b(), p.id, "vie");
      const a = annualMonthly(b(), "vie");
      return { period: p, expense: t.expense + a.expense, income: t.income + t.salary, available: t.available - a.expense + a.income };
    }),
  );
  const hasAlternance = () => b().lines.some((l) => l.scope === "alternance");
  const onceExpense = () => b().lines.filter((l) => l.kind === "expense").reduce((a, l) => a + (l.once_cents ?? 0), 0);

  return (
    <div class="card-surface min-w-0 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="border-base-200 border-b align-bottom">
              <th class="bg-base-100 sticky left-0 z-[2] min-w-60 px-4 py-3 text-left font-semibold">Poste</th>
              <th class="text-muted w-32 px-2 py-3 text-right text-xs font-medium">Annuel / ponctuel</th>
              <For each={b().periods}>
                {(p) => (
                  <th class="min-w-36 px-2 py-2 text-right font-normal">
                    <PeriodHeader period={p} canDelete={b().periods.length > 1} run={run} />
                  </th>
                )}
              </For>
              <th class="w-32 px-3 py-3 text-right font-semibold">
                Total
                <div class="text-muted text-[11px] font-normal">sur {totalMonths(b())} mois</div>
              </th>
              <th class="w-10 px-2 py-3">
                <IconButton icon="lucide:columns-3" label="Ajouter une période" onClick={() => run(api.addPeriod(b().id, { name: `Période ${b().periods.length + 1}`, months: 1 }))} />
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={sectionNames()}>
              {(section) => (
                <>
                  <tr class="bg-base-200/60">
                    <td class="sticky left-0 z-[1] bg-inherit px-2 py-1.5" colspan={2}>
                      <input
                        class="input input-ghost input-sm h-7 w-full max-w-64 px-2 text-xs font-semibold tracking-wide uppercase"
                        value={section}
                        placeholder="Sans section"
                        aria-label="Nom de la section"
                        onChange={(e) => renameSection(section, e.currentTarget.value)}
                      />
                    </td>
                    <td colspan={cols() - 2} class="px-2 py-1.5 text-right">
                      <button class="btn btn-ghost btn-xs" onClick={() => newLine(section)}>
                        <Ico icon="lucide:plus" /> Poste
                      </button>
                    </td>
                  </tr>
                  <For each={linesOf(section)}>
                    {(l) => (
                      <tr class={`border-base-200 hover:bg-base-200/30 border-b ${l.kind === "info" ? "text-muted italic" : ""}`}>
                        <td class="bg-base-100 sticky left-0 z-[1] px-4 py-1.5">
                          <button class="group flex w-full min-w-0 items-center gap-2.5 text-left" onClick={() => props.onEditLine(draftOf(l))} title="Modifier le poste">
                            <Show when={l.category_id != null} fallback={<span class="size-7 shrink-0" />}>
                              <CategoryIcon category={store.categoryById().get(l.category_id!)} size="sm" />
                            </Show>
                            <span class="min-w-0 flex-1">
                              <span class="block truncate font-medium group-hover:underline">{l.name}</span>
                              <span class="text-muted flex min-w-0 items-center gap-1.5 text-[11px] not-italic">
                                <Show when={l.scope === "alternance"}>
                                  <span class="badge badge-xs badge-soft badge-warning not-italic" title="Temporaire : disparaît après l'alternance">
                                    alternance
                                  </span>
                                </Show>
                                <Show when={l.from_month || l.until_month}>
                                  <span class="badge badge-xs badge-soft badge-info not-italic" title="Le poste ne s'applique qu'à ces mois">
                                    {rangeLabel(l, monthShortYear)}
                                  </span>
                                </Show>
                                <Show when={l.kind !== "expense"}>
                                  <span class={l.kind === "income" || l.kind === "salary" ? "text-gain" : ""}>{KIND_LABEL[l.kind]}</span>
                                </Show>
                                <Show when={l.match}>
                                  <span class="truncate">« {l.match} »</span>
                                </Show>
                                <Show when={!l.match && l.category_id == null && l.kind !== "info"}>
                                  <span class="inline-flex items-center gap-1" title="Ni motif ni catégorie : pas de suivi automatique">
                                    <Ico icon="lucide:unlink" /> non relié
                                  </span>
                                </Show>
                              </span>
                            </span>
                            <Ico icon="lucide:pencil" class="text-muted opacity-0 group-hover:opacity-100" />
                          </button>
                        </td>
                        <td class="px-1 py-1">
                          <EuroInput label={`${l.name} : annuel / ponctuel`} value={l.once_cents} onCommit={(c) => run(api.updateLine(l.id, { once_cents: c }))} />
                        </td>
                        <For each={b().periods}>
                          {(p) => (
                            <td class={`px-1 py-1 ${l.kind === "income" || l.kind === "salary" ? "text-gain" : ""}`}>
                              <EuroInput
                                label={`${l.name} : ${p.name}`}
                                value={amountOf(l, p.id)}
                                onCommit={(c) => run(api.updateLine(l.id, { amounts: { [String(p.id)]: c } }))}
                              />
                            </td>
                          )}
                        </For>
                        <td class="num text-ink-2 px-3 py-1 text-right whitespace-nowrap">{lineTotal(b(), l) ? money(lineTotal(b(), l)) : ""}</td>
                        <td />
                      </tr>
                    )}
                  </For>
                </>
              )}
            </For>
            <Show when={b().lines.length === 0}>
              <tr>
                <td colspan={cols()} class="text-muted px-4 py-10 text-center">
                  Aucun poste pour l'instant.
                </td>
              </tr>
            </Show>
          </tbody>
          <tfoot class="border-base-300 border-t-2">
            <FootRow label="Dépenses" once={onceExpense()} values={totals().map((t) => t.expense)} total={grand().expense} />
            <FootRow label="Aides & revenus" sign="−" values={totals().map((t) => t.income)} total={grand().income} />
            <FootRow label="Reste à charge" strong values={totals().map((t) => t.charge)} total={grand().charge} />
            <FootRow label="Salaire net" values={totals().map((t) => t.salary)} total={grand().salary} />
            <FootRow label="Disponible (salaire − reste à charge)" strong tone values={totals().map((t) => t.available)} total={grand().available} />
            <Show when={annual().expense}>
              <FootRow label="annuels et ponctuels lissés (÷ 12)" sign="−" values={b().periods.map(() => annual().expense)} total={annual().expense * totalMonths(b())} />
            </Show>
          </tfoot>
        </table>
      </div>
      <Show when={hasAlternance()}>
        <div class="border-base-200 border-t px-4 py-3">
          <div class="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Ico icon="lucide:graduation-cap" /> Après l'alternance
            <span class="text-muted text-xs font-normal">postes « vie courante » seulement, annuels lissés compris</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <For each={after()}>
              {(a) => (
                <div class="bg-base-200/60 rounded-box px-3 py-2 text-sm">
                  <div class="text-muted text-xs">base {a.period.name}</div>
                  <div class="num">
                    dépenses <span class="font-semibold">{money(a.expense)}</span>/mois
                  </div>
                  <div class="num">
                    revenus <span class="font-semibold">{money(a.income)}</span>/mois
                  </div>
                  <div class={`num font-semibold ${a.available >= 0 ? "text-gain" : "text-error"}`}>disponible {money(a.available)}</div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="border-base-200 flex flex-wrap gap-2 border-t px-4 py-3">
        <button class="btn btn-sm" onClick={() => newLine("")}>
          <Ico icon="lucide:plus" /> Poste
        </button>
        <button
          class="btn btn-sm btn-ghost"
          onClick={() => props.onEditLine({ section: "Nouvelle section", name: "", kind: "expense", category_id: null, match: null, once_cents: null, amounts: {} })}
        >
          <Ico icon="lucide:list-plus" /> Section
        </button>
        <span class="text-muted ml-auto self-center text-xs">Les montants s'enregistrent en quittant la case (Tab pour passer à la suivante).</span>
      </div>
    </div>
  );
}

/** Mois proposés comme début de période : de 12 mois avant à 24 mois après aujourd'hui. */
function monthChoices(current: string | null) {
  const d = new Date();
  const out: string[] = [];
  for (let i = -12; i <= 24; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() + i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  if (current && !out.includes(current)) out.unshift(current);
  return out;
}

function FootRow(props: { label: string; values: number[]; total: number; once?: number; strong?: boolean; tone?: boolean; sign?: string }) {
  const fmt = (v: number) => (v ? `${props.sign && v > 0 ? props.sign : ""}${money(v)}` : "—");
  const color = (v: number) => (props.tone ? (v >= 0 ? "text-gain" : "text-error") : "");
  return (
    <tr class={props.strong ? "font-semibold" : "text-ink-2"}>
      <td class="bg-base-100 sticky left-0 z-[1] px-4 py-1.5">{props.label}</td>
      <td class="num px-3 py-1.5 text-right">{props.once ? money(props.once) : ""}</td>
      <For each={props.values}>{(v) => <td class={`num px-3 py-1.5 text-right whitespace-nowrap ${color(v)}`}>{fmt(v)}</td>}</For>
      <td class={`num px-3 py-1.5 text-right whitespace-nowrap ${color(props.total)}`}>{fmt(props.total)}</td>
      <td />
    </tr>
  );
}

function PeriodHeader(props: { period: BudgetPeriod; canDelete: boolean; run: (p: Promise<unknown>) => void }) {
  const p = () => props.period;
  const [confirm, setConfirm] = createSignal(false);
  return (
    <div class="flex flex-col items-end gap-0.5">
      <div class="flex items-center gap-1">
        <input
          class="input input-ghost input-sm h-7 w-28 px-1 text-right font-semibold"
          value={p().name}
          aria-label="Nom de la période"
          onChange={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== p().name) props.run(api.updatePeriod(p().id, { name: v }));
          }}
        />
        <Show when={props.canDelete}>
          <Show
            when={confirm()}
            fallback={<IconButton icon="lucide:x" label={`Supprimer la période ${p().name}`} class="btn-xs text-muted" onClick={() => setConfirm(true)} />}
          >
            <button class="btn btn-error btn-xs" onClick={() => props.run(api.deletePeriod(p().id))} onBlur={() => setConfirm(false)}>
              Supprimer
            </button>
          </Show>
        </Show>
      </div>
      <label class="text-muted flex items-center gap-1 text-[11px]">
        ×
        <input
          type="number"
          min="1"
          max="24"
          class="input input-ghost input-xs num h-5 w-10 px-1 text-right"
          value={p().months}
          aria-label={`Durée de ${p().name} en mois`}
          onChange={(e) => {
            const v = Math.min(24, Math.max(1, Number(e.currentTarget.value) || 1));
            if (v !== p().months) props.run(api.updatePeriod(p().id, { months: v }));
          }}
        />
        mois
      </label>
      <label class="text-muted flex items-center gap-1 text-[11px]" title="Mois de début : la période est alors choisie automatiquement dans le suivi">
        dès
        <select
          class="cursor-pointer bg-transparent text-right text-[11px] outline-none hover:underline"
          value={p().start_month ?? ""}
          aria-label={`Début de ${p().name}`}
          onChange={(e) => props.run(api.updatePeriod(p().id, { start_month: e.currentTarget.value || null }))}
        >
          <option value="">non défini</option>
          <For each={monthChoices(p().start_month)}>{(m) => <option value={m}>{monthShortYear(m)}</option>}</For>
        </select>
      </label>
    </div>
  );
}
