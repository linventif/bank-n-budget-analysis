// Formatage français : montants, dates, mois.

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const eur0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });

export const money = (cents: number, currency = "EUR") =>
  currency === "EUR"
    ? eur.format(cents / 100)
    : new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(cents / 100);

/** Arrondi à l'euro : pour les gros chiffres et les étiquettes de graphique. */
export const money0 = (cents: number) => eur0.format(Math.round(cents / 100));

/** Montant signé explicite : « +12,00 € » / « −12,00 € ». */
export const signedMoney = (cents: number, currency = "EUR") =>
  (cents > 0 ? "+" : cents < 0 ? "−" : "") + money(Math.abs(cents), currency);

/** Axe : 0 € · 500 € · 1 k€ · 10 k€. */
export const axisMoney = (cents: number) => {
  const v = cents / 100;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)} k€`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k€`;
  return `${Math.round(v)} €`;
};

export const percent = (ratio: number) => pct.format(ratio);

const parseMonth = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);

export const monthLong = (m: string) => {
  const s = parseMonth(m).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const monthShort = (m: string) =>
  parseMonth(m).toLocaleDateString("fr-FR", { month: "short" }).replace(".", "");
export const monthShortYear = (m: string) =>
  parseMonth(m).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }).replace(".", "");

const parseDay = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

export const dayLabel = (d: string) => parseDay(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
export const dayLong = (d: string) =>
  parseDay(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** « il y a 3 h », « dans 12 j ». */
export const relative = (iso: string) => {
  const diff = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
};

export const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

/** Libellé lisible d'une clé marchand : « TOULOUSE LIDL » → « Toulouse Lidl ». */
export const prettyMerchant = (m: string) =>
  m
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
