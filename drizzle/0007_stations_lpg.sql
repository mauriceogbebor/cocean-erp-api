CREATE TYPE "public"."cylinder_status" AS ENUM('active', 'condemned');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('balanced', 'variance_pending', 'variance_accepted', 'variance_rejected', 'banked');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_kind" ADD VALUE 'sale';--> statement-breakpoint
CREATE TABLE "cylinders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serial" text NOT NULL,
	"size_kg" numeric(5, 1) NOT NULL,
	"owner" text NOT NULL,
	"test_due_on" date NOT NULL,
	"status" "cylinder_status" DEFAULT 'active' NOT NULL,
	"condemned_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"tank_id" uuid NOT NULL,
	"cylinder_id" uuid NOT NULL,
	"kg" numeric(6, 2) NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"shift_id" uuid,
	"filled_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pumps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"tank_id" uuid NOT NULL,
	"code" text NOT NULL,
	"opening_meter" numeric(14, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_pumps" (
	"shift_id" uuid NOT NULL,
	"pump_id" uuid NOT NULL,
	"opening" numeric(14, 2) NOT NULL,
	"closing" numeric(14, 2) NOT NULL,
	"quantity" numeric(14, 2) NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "shift_pumps_shift_id_pump_id_pk" PRIMARY KEY("shift_id","pump_id")
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"site_id" uuid NOT NULL,
	"shift_date" date NOT NULL,
	"period" text NOT NULL,
	"status" "shift_status" NOT NULL,
	"expected" numeric(18, 2) NOT NULL,
	"cash" numeric(18, 2) NOT NULL,
	"pos" numeric(18, 2) NOT NULL,
	"transfer" numeric(18, 2) NOT NULL,
	"cash_variance" numeric(18, 2) NOT NULL,
	"tank_check" jsonb NOT NULL,
	"notes" text,
	"closed_by" uuid NOT NULL,
	"bank" text,
	"bank_ref" text,
	"banked_amount" numeric(18, 2),
	"banked_on" date,
	"banked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sites" (
	"user_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "user_sites_user_id_site_id_pk" PRIMARY KEY("user_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_cylinder_id_cylinders_id_fk" FOREIGN KEY ("cylinder_id") REFERENCES "public"."cylinders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_filled_by_users_id_fk" FOREIGN KEY ("filled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pumps" ADD CONSTRAINT "pumps_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pumps" ADD CONSTRAINT "pumps_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_pumps" ADD CONSTRAINT "shift_pumps_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_pumps" ADD CONSTRAINT "shift_pumps_pump_id_pumps_id_fk" FOREIGN KEY ("pump_id") REFERENCES "public"."pumps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_banked_by_users_id_fk" FOREIGN KEY ("banked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sites" ADD CONSTRAINT "user_sites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sites" ADD CONSTRAINT "user_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cylinders_serial_key" ON "cylinders" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "fills_site_shift_idx" ON "fills" USING btree ("site_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pumps_site_code_key" ON "pumps" USING btree ("site_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_number_key" ON "shifts" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_site_date_period_key" ON "shifts" USING btree ("site_id","shift_date","period");