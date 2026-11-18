CREATE TYPE "public"."ledger_kind" AS ENUM('opening', 'invoice', 'receipt', 'receipt_reversal');--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'invoiced';--> statement-breakpoint
CREATE TABLE "customer_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"ref" text NOT NULL,
	"doc_id" uuid,
	"entry_date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"due_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_code" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"vat_rate" numeric(5, 4) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	CONSTRAINT "invoice_lines_invoice_id_line_no_pk" PRIMARY KEY("invoice_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"bank" text NOT NULL,
	"bank_ref" text NOT NULL,
	"received_on" date NOT NULL,
	"notes" text,
	"recorded_by" uuid NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "vat_rate" numeric(5, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_code_products_code_fk" FOREIGN KEY ("product_code") REFERENCES "public"."products"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_ledger_customer_idx" ON "customer_ledger" USING btree ("customer_id","entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_key" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_number_key" ON "receipts" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_bank_ref_key" ON "receipts" USING btree ("bank","bank_ref");--> statement-breakpoint
CREATE INDEX "receipts_customer_idx" ON "receipts" USING btree ("customer_id");--> statement-breakpoint
-- The customer ledger is append-only: corrections are new entries.
CREATE OR REPLACE FUNCTION customer_ledger_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_ledger is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER customer_ledger_no_update
  BEFORE UPDATE OR DELETE ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION customer_ledger_block_change();
--> statement-breakpoint
CREATE TRIGGER customer_ledger_no_truncate
  BEFORE TRUNCATE ON customer_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION customer_ledger_block_change();
--> statement-breakpoint
-- Opening balances already captured on customers become their first entry.
INSERT INTO customer_ledger (customer_id, kind, ref, entry_date, amount, due_on)
SELECT id, 'opening', 'OPENING', (created_at AT TIME ZONE 'Africa/Lagos')::date,
       opening_balance, (created_at AT TIME ZONE 'Africa/Lagos')::date
FROM customers WHERE opening_balance <> 0;
