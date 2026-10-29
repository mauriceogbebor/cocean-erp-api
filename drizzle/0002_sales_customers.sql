CREATE TYPE "public"."credit_terms" AS ENUM('prepaid', 'credit');--> statement-breakpoint
CREATE TYPE "public"."customer_kind" AS ENUM('industrial', 'reseller', 'station_operator', 'government');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_payment', 'credit_hold', 'override_pending', 'released', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."price_list_status" AS ENUM('draft', 'pending', 'approved');--> statement-breakpoint
CREATE TABLE "customer_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"state" text NOT NULL,
	"receiver_name" text NOT NULL,
	"receiver_phone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "customer_kind" NOT NULL,
	"terms" "credit_terms" DEFAULT 'prepaid' NOT NULL,
	"credit_limit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"tin" text,
	"email" text,
	"phone" text,
	"address" text NOT NULL,
	"opening_balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_sequences" (
	"key" text NOT NULL,
	"year" integer NOT NULL,
	"last" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "doc_sequences_key_year_pk" PRIMARY KEY("key","year")
);
--> statement-breakpoint
CREATE TABLE "price_list_lines" (
	"price_list_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	CONSTRAINT "price_list_lines_price_list_id_product_code_pk" PRIMARY KEY("price_list_id","product_code")
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"valid_from" date NOT NULL,
	"status" "price_list_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_code" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"delivery_site_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"po_ref" text NOT NULL,
	"request_ref" text,
	"notes" text,
	"terms" "credit_terms" NOT NULL,
	"status" "order_status" NOT NULL,
	"price_list_id" uuid NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"credit_check" jsonb,
	"created_by" uuid NOT NULL,
	"released_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "customer_sites" ADD CONSTRAINT "customer_sites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_product_code_products_code_fk" FOREIGN KEY ("product_code") REFERENCES "public"."products"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_product_code_products_code_fk" FOREIGN KEY ("product_code") REFERENCES "public"."products"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_delivery_site_id_customer_sites_id_fk" FOREIGN KEY ("delivery_site_id") REFERENCES "public"."customer_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_sites_customer_idx" ON "customer_sites" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_code_key" ON "customers" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_code_key" ON "price_lists" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_no_key" ON "sales_order_lines" USING btree ("order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_number_key" ON "sales_orders" USING btree ("number");--> statement-breakpoint
CREATE INDEX "sales_orders_customer_idx" ON "sales_orders" USING btree ("customer_id","status");