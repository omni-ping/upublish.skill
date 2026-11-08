/**
 * Money wording the publish / address tools print, kept pure so it is pinned by tests
 * instead of living inline in the MCP adapter.
 *
 * Two rules every line here follows:
 * - Prices come from the server, never a literal. A pack or block price is PER UNIT;
 *   the line a user pays by is the total (price x count), shown alongside the unit.
 * - A billing interval of `null` means the server could not tell the base subscription's
 *   interval (the price it sent is then the monthly figure). No unit is printed for it:
 *   guessing "/mo" would quote an annual customer the wrong period.
 */

export type BillingInterval = "month" | "year";

/** The 403 body error a finalize returns while the owner's last renewal payment failed. */
export const ACCOUNT_PAST_DUE_CODE = "account_past_due";

/** Same sentence as the website's past-due banner. */
export const ACCOUNT_PAST_DUE_TEXT = "Payment failed — update your card. New publishes are paused.";

/** Where the card is updated (Manage billing opens the Stripe portal from there). */
const BILLING_URL = "https://upubli.sh/profile/settings";

/** `account_past_due` as the sentence the user sees, plus where to fix it. */
export const accountPastDueMessage = (): string => `${ACCOUNT_PAST_DUE_TEXT} Update it at ${BILLING_URL} (Manage billing). Existing sites keep serving.`;

const unit = (interval: BillingInterval | null): string => (interval === "year" ? "/yr" : interval === "month" ? "/mo" : "");

/** "$3.00/mo"; "$3.00" when the interval is unknown. */
const money = (usd: number, interval: BillingInterval | null): string => `$${usd.toFixed(2)}${unit(interval)}`;

const intervalNote = (interval: BillingInterval | null): string => (interval === null ? " (billing interval not reported)" : "");

/** A per-unit price and the total it makes for `count` units: "$2.00/mo ($1.00/mo each)"; just the unit price when count is 1. */
function totalText(unitUsd: number, count: number, interval: BillingInterval | null): string {
  return count === 1 ? money(unitUsd, interval) : `${money(unitUsd * count, interval)} (${money(unitUsd, interval)} each)`;
}

export interface StorageOverageTag { block_gb: number; blocks: number; price: number; interval: BillingInterval | null }

/** The note after a publish that added storage blocks. `price` is per block, so the line leads with the total. */
export function storageChargeLine(ov: StorageOverageTag): string {
  return `+${totalText(ov.price, ov.blocks, ov.interval)} added to your bill${intervalNote(ov.interval)} — ${ov.blocks} x ${ov.block_gb}GB storage ${ov.blocks === 1 ? "block" : "blocks"}.`;
}

/** The price sentence of the 402 storage approval; fields are nullable when the body omitted them. */
export function storageApprovalPriceLine(a: { price: number | null; block_gb: number | null; blocks_needed: number | null; interval: BillingInterval | null }): string {
  if (a.price === null) return "Approving adds a storage block to your subscription.";
  const blocks = a.blocks_needed ?? 1;
  const size = `${a.block_gb ?? 10}GB`;
  const what = blocks === 1 ? `a ${size} storage block` : `${blocks} x ${size} storage blocks`;
  return `Approving adds ${what} at ${totalText(a.price, blocks, a.interval)}${intervalNote(a.interval)}.`;
}

export interface PackOverageTag { pack_size: number; price: number; interval: BillingInterval | null }

/** The note after an address create that added a pack. */
export function packChargeLine(ov: PackOverageTag): string {
  return `+${money(ov.price, ov.interval)} added to your bill${intervalNote(ov.interval)} — a pack of ${ov.pack_size} address slots.`;
}

/** The price sentence of the 402 address-pack approval. */
export function packApprovalPriceLine(a: { price: number | null; pack_size: number | null; interval: BillingInterval | null }): string {
  if (a.price === null) return "Adding this address requires an address pack.";
  return `Adding this address requires a pack of ${a.pack_size ?? 5} address slots at ${money(a.price, a.interval)}${intervalNote(a.interval)}.`;
}

/** Cents as dollars, e.g. 300 -> "$3.00". */
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface AddonCharge { interval: BillingInterval; price_cents: number; basis?: "invoice" | "list_price"; recurring_cents?: number }

/**
 * What an add-on enable charged. `basis` says what `price_cents` is:
 * - "invoice": the prorated amount Stripe invoiced now -> "Charged $X now (prorated)".
 * - "list_price": the invoice could not be read, so it is the list price -> stated as a price, never as an amount charged.
 * - absent (older server): unknown meaning -> only the amount and the plan interval, no "prorated" or "recurring" claim.
 * A zero amount reads "No charge now". `recurring_cents`, when sent, is what the item costs each period.
 */
export function addonChargeText(c: AddonCharge | null): string {
  if (c === null) return "No charge was made.";
  const recurring = c.recurring_cents === undefined ? "" : ` It then costs ${usd(c.recurring_cents)}/${c.interval}.`;
  if (c.price_cents === 0) return `No charge now.${recurring}`;
  const plan = c.interval === "year" ? "yearly" : "monthly";
  switch (c.basis) {
    case "invoice":
      return `Charged ${usd(c.price_cents)} now (prorated, ${plan} plan).${recurring}`;
    case "list_price":
      // A list price is NOT an amount charged: never word it as "charged ... now".
      return `Price: ${usd(c.price_cents)}/${c.interval} (list price). The exact prorated amount charged today is on your Stripe receipt.`;
    default:
      return `Charged ${usd(c.price_cents)} (${plan} plan).${recurring}`;
  }
}
