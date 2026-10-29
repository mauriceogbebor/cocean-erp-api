CREATE TYPE "public"."bill_status" AS ENUM('matched', 'exception', 'payment_pending', 'approved', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('draft', 'pending', 'approved', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."vendor_bank_status" AS ENUM('none', 'pending', 'verified');--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"receipt_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "goods_receipt_lines_receipt_id_po_line_id_pk" PRIMARY KEY("receipt_id","po_line_id")
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"po_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"delivery_note" text NOT NULL,
	"notes" text,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_code" text,
	"description" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"vat_rate" numeric(5, 4) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	"received" numeric(14, 3) DEFAULT '0' NOT NULL,
	"billed" numeric(14, 3) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"status" "po_status" DEFAULT 'draft' NOT NULL,
	"justification" text NOT NULL,
	"quote_ref" text,
	"subtotal" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_bill_lines" (
	"bill_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	CONSTRAINT "supplier_bill_lines_bill_id_po_line_id_pk" PRIMARY KEY("bill_id","po_line_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"vendor_invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"stated_total" numeric(18, 2) NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"status" "bill_status" NOT NULL,
	"exceptions" jsonb NOT NULL,
	"recorded_by" uuid NOT NULL,
	"pay_to" jsonb,
	"payment_ref" text,
	"paid_on" date,
	"paid_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"tin" text,
	"email" text,
	"phone" text,
	"address" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"account_name" text,
	"bank_status" "vendor_bank_status" DEFAULT 'none' NOT NULL,
	"bank_verified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_code_products_code_fk" FOREIGN KEY ("product_code") REFERENCES "public"."products"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_number_key" ON "goods_receipts" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_no_key" ON "purchase_order_lines" USING btree ("po_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_number_key" ON "purchase_orders" USING btree ("number");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_bills_number_key" ON "supplier_bills" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_bills_vendor_invoice_key" ON "supplier_bills" USING btree ("vendor_id","vendor_invoice_no");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_code_key" ON "vendors" USING btree ("code");