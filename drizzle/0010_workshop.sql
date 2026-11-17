CREATE TYPE "public"."work_order_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'overrun', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "work_order_status" DEFAULT 'draft' NOT NULL,
	"off_road" boolean NOT NULL,
	"held_from" timestamp with time zone,
	"released_at" timestamp with time zone,
	"odometer_km" integer,
	"supplier_name" text,
	"estimate_lines" jsonb,
	"estimate" numeric(18, 2),
	"actual_lines" jsonb,
	"parts_cost" numeric(18, 2),
	"labour_cost" numeric(18, 2),
	"outside_cost" numeric(18, 2),
	"actual_cost" numeric(18, 2),
	"completed_on" date,
	"completion_note" text,
	"cancel_reason" text,
	"approval_id" uuid,
	"opened_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "hold_work_order_id" uuid;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_number_key" ON "work_orders" USING btree ("number");--> statement-breakpoint
CREATE INDEX "work_orders_vehicle_idx" ON "work_orders" USING btree ("vehicle_id","created_at");--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "work_orders_completed_idx" ON "work_orders" USING btree ("completed_on");