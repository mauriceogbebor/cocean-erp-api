CREATE TYPE "public"."dip_status" AS ENUM('within_tolerance', 'variance_pending', 'variance_approved', 'variance_rejected');--> statement-breakpoint
CREATE TYPE "public"."drop_status" AS ENUM('planned', 'in_transit', 'delivered', 'exception', 'resolved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lifting_status" AS ENUM('planned', 'in_transit', 'delivered', 'exception', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('opening', 'receipt', 'lifting', 'dip_adjustment', 'variance_adjustment');--> statement-breakpoint
CREATE TABLE "dips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tank_id" uuid NOT NULL,
	"dipped_on" date NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"temperature" numeric(5, 2),
	"book" numeric(14, 3) NOT NULL,
	"variance" numeric(14, 3) NOT NULL,
	"status" "dip_status" NOT NULL,
	"notes" text,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lifting_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lifting_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"planned_quantity" numeric(14, 3) NOT NULL,
	"tank_id" uuid,
	"loaded_quantity" numeric(14, 3),
	"seals" jsonb,
	"status" "drop_status" DEFAULT 'planned' NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"receiver_name" text,
	"received_quantity" numeric(14, 3),
	"received_seals" jsonb,
	"receiver_notes" text,
	"confirmed_at" timestamp with time zone,
	"exceptions" jsonb,
	"finding" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "liftings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"truck_plate" text NOT NULL,
	"driver_name" text NOT NULL,
	"driver_phone" text NOT NULL,
	"status" "lifting_status" DEFAULT 'planned' NOT NULL,
	"planned_by" uuid NOT NULL,
	"loaded_by" uuid,
	"loaded_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tank_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"ref" text NOT NULL,
	"doc_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tanks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"code" text NOT NULL,
	"product_code" text NOT NULL,
	"capacity" numeric(14, 3) NOT NULL,
	"safe_capacity" numeric(14, 3) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "invoices_order_key";--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "tank_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "drop_id" uuid;--> statement-breakpoint
ALTER TABLE "dips" ADD CONSTRAINT "dips_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dips" ADD CONSTRAINT "dips_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifting_drops" ADD CONSTRAINT "lifting_drops_lifting_id_liftings_id_fk" FOREIGN KEY ("lifting_id") REFERENCES "public"."liftings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifting_drops" ADD CONSTRAINT "lifting_drops_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifting_drops" ADD CONSTRAINT "lifting_drops_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifting_drops" ADD CONSTRAINT "lifting_drops_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liftings" ADD CONSTRAINT "liftings_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liftings" ADD CONSTRAINT "liftings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liftings" ADD CONSTRAINT "liftings_planned_by_users_id_fk" FOREIGN KEY ("planned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liftings" ADD CONSTRAINT "liftings_loaded_by_users_id_fk" FOREIGN KEY ("loaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tanks" ADD CONSTRAINT "tanks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tanks" ADD CONSTRAINT "tanks_product_code_products_code_fk" FOREIGN KEY ("product_code") REFERENCES "public"."products"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dips_tank_idx" ON "dips" USING btree ("tank_id","created_at");--> statement-breakpoint
CREATE INDEX "lifting_drops_lifting_idx" ON "lifting_drops" USING btree ("lifting_id");--> statement-breakpoint
CREATE INDEX "lifting_drops_line_idx" ON "lifting_drops" USING btree ("order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lifting_drops_token_key" ON "lifting_drops" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "liftings_number_key" ON "liftings" USING btree ("number");--> statement-breakpoint
CREATE INDEX "liftings_order_idx" ON "liftings" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "stock_movements_tank_idx" ON "stock_movements" USING btree ("tank_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tanks_code_key" ON "tanks" USING btree ("code");--> statement-breakpoint
CREATE INDEX "tanks_site_idx" ON "tanks" USING btree ("site_id");--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_drop_id_lifting_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."lifting_drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_order_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_whole_order_key" ON "invoices" USING btree ("order_id") WHERE drop_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_drop_key" ON "invoices" USING btree ("drop_id");--> statement-breakpoint
-- Stock movements are append-only: corrections are new movements.
CREATE OR REPLACE FUNCTION stock_movements_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_update
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_block_change();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_block_change();
