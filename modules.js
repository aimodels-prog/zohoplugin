const ENTITIES = [
  {
    single: "contact",
    plural: "contacts",
    path: "/contacts",
    id: "contact_id",
    noun: "contact (a customer or a vendor)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: contact_name. Common: company_name, contact_type ('customer' or 'vendor'), " +
      "currency_id, payment_terms, payment_terms_label, credit_limit, notes, " +
      "billing_address{address,street2,city,state,zip,country,phone}, shipping_address{...}, " +
      "contact_persons[{salutation,first_name,last_name,email,phone,mobile,is_primary_contact}], " +
      "custom_fields[{label,value}].",
  },
  {
    single: "invoice",
    plural: "invoices",
    path: "/invoices",
    id: "invoice_id",
    noun: "invoice",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Each line item: " +
      "{item_id, name, description, rate, quantity, unit, tax_id, discount, item_order}. " +
      "Common: invoice_number, reference_number, date (YYYY-MM-DD), due_date, payment_terms, " +
      "discount, is_discount_before_tax, discount_type, is_inclusive_tax, salesperson_name, " +
      "notes, terms, custom_fields[{label,value}].",
  },
  {
    single: "estimate",
    plural: "estimates",
    path: "/estimates",
    id: "estimate_id",
    noun: "estimate (quote)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Each line item: " +
      "{item_id, name, description, rate, quantity, tax_id, item_order}. " +
      "Common: estimate_number, reference_number, date, expiry_date, discount, " +
      "is_inclusive_tax, salesperson_name, notes, terms, custom_fields[{label,value}].",
  },
  {
    single: "sales_order",
    plural: "sales_orders",
    path: "/salesorders",
    id: "salesorder_id",
    noun: "sales order",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Common: salesorder_number, reference_number, " +
      "date, shipment_date, discount, is_inclusive_tax, salesperson_name, notes, terms, " +
      "custom_fields[{label,value}].",
  },
  {
    single: "purchase_order",
    plural: "purchase_orders",
    path: "/purchaseorders",
    id: "purchaseorder_id",
    noun: "purchase order",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id and line_items[]. Common: purchaseorder_number, reference_number, " +
      "date, delivery_date, discount, is_inclusive_tax, notes, terms, " +
      "custom_fields[{label,value}].",
  },
  {
    single: "item",
    plural: "items",
    path: "/items",
    id: "item_id",
    noun: "item (product or service)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: name. Common: rate, description, sku, unit, product_type ('goods' or 'service'), " +
      "item_type ('sales', 'purchases', 'sales_and_purchases', 'inventory'), tax_id, " +
      "account_id, purchase_rate, purchase_account_id, purchase_description, " +
      "initial_stock, initial_stock_rate, custom_fields[{label,value}].",
  },
  {
    single: "expense",
    plural: "expenses",
    path: "/expenses",
    id: "expense_id",
    noun: "expense",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: account_id (the expense account) and amount. Common: date, paid_through_account_id, " +
      "vendor_id, customer_id, currency_id, exchange_rate, tax_id, is_inclusive_tax, " +
      "is_billable, reference_number, description, project_id, custom_fields[{label,value}].",
  },
  {
    single: "customer_payment",
    plural: "customer_payments",
    path: "/customerpayments",
    id: "payment_id",
    noun: "customer payment (payment received)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id, payment_mode, amount, date. Common: reference_number, description, " +
      "exchange_rate, account_id (deposit-to account), bank_charges, " +
      "invoices[{invoice_id, amount_applied, tax_amount_withheld}], custom_fields[{label,value}].",
  },
  // --- Payables. Without these the ledger only shows money owed TO the company. ---
  {
    single: "bill",
    plural: "bills",
    path: "/bills",
    id: "bill_id",
    noun: "bill (an invoice received from a supplier — what the company owes)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id and line_items[]. Each line item: {account_id, name, description, " +
      "rate, quantity, tax_id}. Common: bill_number, reference_number, date, due_date, " +
      "payment_terms, is_inclusive_tax, notes, custom_fields[{label,value}].",
  },
  {
    single: "vendor_payment",
    plural: "vendor_payments",
    path: "/vendorpayments",
    id: "payment_id",
    noun: "vendor payment (money paid out to a supplier)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id, amount, date, paid_through_account_id. Common: payment_mode, " +
      "reference_number, description, exchange_rate, bills[{bill_id, amount_applied}].",
  },
  {
    single: "vendor_credit",
    plural: "vendor_credits",
    path: "/vendorcredits",
    id: "vendor_credit_id",
    noun: "vendor credit (a credit note received from a supplier)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: vendor_id and line_items[]. Common: vendor_credit_number, date, " +
      "reference_number, notes, custom_fields[{label,value}].",
  },
  // --- Credit notes reduce revenue; without them invoice totals read high. ---
  {
    single: "credit_note",
    plural: "credit_notes",
    path: "/creditnotes",
    id: "creditnote_id",
    noun: "credit note (a refund or cancellation issued to a customer, reducing revenue)",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id and line_items[]. Common: creditnote_number, date, " +
      "reference_number, reason, is_inclusive_tax, notes, custom_fields[{label,value}].",
  },
  {
    single: "journal",
    plural: "journals",
    path: "/journals",
    id: "journal_id",
    noun: "manual journal entry",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: journal_date and line_items[] where debits equal credits. Each line: " +
      "{account_id, debit_or_credit ('debit'|'credit'), amount, description, customer_id}. " +
      "Common: reference_number, notes, journal_type, currency_id, exchange_rate.",
  },
  {
    single: "bank_transaction",
    plural: "bank_transactions",
    path: "/banktransactions",
    id: "transaction_id",
    noun: "bank or credit-card transaction",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: account_id, transaction_type, amount, date. transaction_type is one of " +
      "'deposit', 'refund', 'expense', 'card_payment', 'sales_without_invoices', " +
      "'owner_contribution', 'transfer_fund', 'owner_drawings'. Common: payment_mode, " +
      "reference_number, description, from_account_id, to_account_id.",
  },
  {
    single: "recurring_invoice",
    plural: "recurring_invoices",
    path: "/recurringinvoices",
    id: "recurring_invoice_id",
    noun: "recurring invoice profile",
    ops: ["get", "list", "create", "update", "delete"],
    hint:
      "Required: customer_id, recurrence_name, recurrence_frequency ('days'|'weeks'|'months'|" +
      "'years'), start_date and line_items[]. Common: repeat_every, end_date, payment_terms.",
  },
  {
    single: "tax",
    plural: "taxes",
    path: "/settings/taxes",
    id: "tax_id",
    noun: "tax rate",
    ops: ["get", "list", "create"],
    hint:
      "Required: tax_name and tax_percentage. Common: tax_type ('tax' or 'compound_tax'), " +
      "tax_authority_id, tax_specific_type, country, is_value_added, is_default_tax.",
  },
  {
    single: "user",
    plural: "users",
    path: "/users",
    id: "user_id",
    noun: "Zoho Books user",
    ops: ["get", "list"],
  },
  {
    single: "organization",
    plural: "organizations",
    path: "/organizations",
    id: "organization_id",
    noun: "Zoho Books organization",
    // list_organizations is defined by hand below so it can report which org is active.
    ops: ["get"],
    noOrg: true,
  },
  {
    single: "bank_account",
    plural: "bank_accounts",
    path: "/bankaccounts",
    noun: "bank or credit-card account",
    ops: ["list"],
  },
  {
    single: "chart_of_account",
    plural: "chart_of_accounts",
    path: "/chartofaccounts",
    noun: "chart-of-accounts entry",
    ops: ["list"],
  },
  {
    single: "currency",
    plural: "currencies",
    path: "/settings/currencies",
    noun: "currency configured in the organization",
    ops: ["list"],
  },
];

// ---------------------------------------------------------------------------
// Module registry
//
// One tool per entity per operation meant the tool count grew five at a time and
// eventually exceeded what an MCP client will reliably hold — capability started
// disappearing silently. Instead the entity table above becomes a registry, and a
// small fixed set of generic tools takes `module` as a parameter. Adding a Zoho
// module later is one more enum value, never another tool.
// ---------------------------------------------------------------------------

export const MODULES = {};
for (const e of ENTITIES) {
  MODULES[e.plural] = {
    path: e.path,
    idField: e.id,
    ops: e.ops,
    noun: e.noun,
    hint: e.hint,
    noOrg: Boolean(e.noOrg),
  };
}

MODULES.custom_fields = {
  path: "/settings/fields",
  idField: "field_id",
  ops: ["list", "create", "update"],
  noun: "custom field definition",
  hint:
    "Required: label, data_type, entity. data_type is one of 'string', 'text', 'number', " +
    "'decimal', 'percent', 'amount', 'date', 'email', 'url', 'phone', 'check_box', " +
    "'dropdown', 'multiselect', 'autonumber', 'lookup'. Common: show_on_pdf, is_mandatory, " +
    "help_text, default_value, values[].",
  listNote:
    'Listing requires the typed entity parameter, e.g. entity: "invoice".',
};

MODULES.custom_modules = {
  path: "/settings/modules",
  idField: "module_api_name",
  ops: ["list", "get", "create", "update"],
  noun: "custom module definition",
  hint:
    "Required: module_name, plural_name. Common: module_api_name, singular_name, " +
    "description, fields[{label,data_type,is_mandatory}], is_active.",
};

MODULES.custom_module_records = {
  dynamic: true,
  idField: "module_record_id",
  ops: ["list", "get", "create"],
  noun: "record stored inside a custom module",
  hint:
    "Required: record_name. Other keys are the module's own field API names; custom fields are prefixed 'cf_', " +
    'e.g. {"cf_project_name":"Jabal Akhdar","cf_budget":250000}.',
  listNote: "Requires module_api_name. Call list with module 'custom_modules' to discover it.",
};

export const MODULE_NAMES = Object.keys(MODULES).sort();


for (const [name,m] of Object.entries(MODULES)) {
 m.rowKey = name === "custom_fields" ? "fields" : name === "custom_modules" ? "modules" : m.path?.split("/").at(-1);
 m.idField ??= ({bank_accounts:"account_id",chart_of_accounts:"account_id",currencies:"currency_id"})[name];
}
MODULES.customer_payments.rowKey = "customer_payments";
MODULES.recurring_invoices.rowKey = "recurring_invoices";
MODULES.custom_module_records.rowKey = "module_record";
