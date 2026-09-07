import { z } from "zod";
import { money, validDate, fingerprint } from "./reporting.js";

const required = {
  contacts: ["contact_name"], invoices: ["customer_id", "line_items"], estimates: ["customer_id", "line_items"],
  sales_orders: ["customer_id", "line_items"], purchase_orders: ["vendor_id", "line_items"],
  bills: ["vendor_id", "line_items"], credit_notes: ["customer_id", "line_items"], vendor_credits: ["vendor_id", "line_items"],
  items: ["name"], expenses: ["account_id", "amount"], customer_payments: ["customer_id", "payment_mode", "amount", "date"],
  vendor_payments: ["vendor_id", "amount", "date", "paid_through_account_id"],
  journals: ["journal_date", "line_items"], bank_transactions: ["account_id", "transaction_type", "amount", "date"],
  recurring_invoices: ["customer_id", "recurrence_name", "recurrence_frequency", "start_date", "line_items"],
  taxes: ["tax_name", "tax_percentage"], custom_fields: ["label", "data_type", "entity"],
  custom_modules: ["module_name", "plural_name"], custom_module_records: ["record_name"],
};
const numberFields = new Set(["amount", "rate", "quantity", "exchange_rate", "tax_percentage", "bank_charges", "amount_applied", "tax_amount_withheld", "debit", "credit"]);
const dateFields = new Set(["date", "due_date", "start_date", "end_date", "journal_date", "expiry_date", "shipment_date", "delivery_date"]);
export function validateWrite(module, operation, data = {}) {
  z.record(z.string(), z.unknown()).parse(data);
  if (operation === "delete") return;
  if (!Object.keys(data).length) throw new Error("Record body must not be empty");
  if (operation === "create") for (const field of required[module] || []) {
    if (data[field] === undefined || data[field] === null || data[field] === "") throw new Error(`Missing required field: ${field}`);
  }
  function check(value, depth = 0) {
    if (depth > 12) throw new Error("Record is too deeply nested");
    if (Array.isArray(value)) { value.forEach(v => check(v, depth + 1)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor", "organization_id"].includes(key)) throw new Error(`Forbidden body field: ${key}`);
      if (numberFields.has(key)) {
        const decimal = money(item);
        if (["amount", "quantity", "exchange_rate", "amount_applied"].includes(key) && decimal.lt(0)) throw new Error(`${key} cannot be negative`);
        if (key === "exchange_rate" && decimal.isZero()) throw new Error("exchange_rate must be positive");
      }
      if (dateFields.has(key) && !validDate(item)) throw new Error(`Invalid ${key}`);
      if (key.endsWith("_id") && (typeof item !== "string" || !item.trim())) throw new Error(`${key} must be a nonempty string`);
      check(item, depth + 1);
    }
  }
  check(data);
  if (data.line_items !== undefined && (!Array.isArray(data.line_items) || !data.line_items.length || data.line_items.some(x => !x || typeof x !== "object" || Array.isArray(x)))) throw new Error("line_items must be a nonempty array of records");
  if (module === "journals" && data.line_items) {
    let debit = money("0"), credit = money("0");
    for (const line of data.line_items) {
      if (!line.account_id || !["debit", "credit"].includes(line.debit_or_credit)) throw new Error("Journal lines require account_id and debit_or_credit");
      if (line.debit_or_credit === "debit") debit = debit.plus(money(line.amount));
      else credit = credit.plus(money(line.amount));
    }
    if (!debit.eq(credit)) throw new Error("Journal debits and credits must balance exactly");
  }
}
export function recordFingerprint(record) {
  if (!record || typeof record !== "object") throw new Error("Could not verify current record");
  return fingerprint(record);
}
