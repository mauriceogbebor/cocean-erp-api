CREATE TYPE "public"."driver_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."ownership" AS ENUM('owned', 'transporter');--> statement-breakpoint
CREATE TYPE "public"."vehicle_doc_kind" AS ENUM('registration', 'roadworthiness', 'insurance', 'nmdpra_permit', 'calibration');--> statement-breakpoint
CREATE TYPE "public"."vehicle_kind" AS ENUM('tanker', 'lpg_bridger', 'flatbed', 'other');--> statement-breakpoint
CREATE TYPE "public"."vehicle_status" AS ENUM('onboarding', 'pending_approval', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"licence_number" text NOT NULL,
	"licence_expires_on" date NOT NULL,
	"inducted_on" date,
	"employer" text,
	"status" "driver_status" DEFAULT 'active' NOT NULL,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"kind" "vehicle_doc_kind" NOT NULL,
	"number" text NOT NULL,
	"issuer" text NOT NULL,
	"expires_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"speed_kph" numeric(5, 1),
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plate" text NOT NULL,
	"kind" "vehicle_kind" NOT NULL,
	"capacity" numeric(12, 3) NOT NULL,
	"compartments" jsonb,
	"ownership" "ownership" NOT NULL,
	"transporter_name" text,
	"tracker_id" text,
	"status" "vehicle_status" DEFAULT 'onboarding' NOT NULL,
	"hold_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "liftings" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "liftings" ADD COLUMN "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_positions" ADD CONSTRAINT "vehicle_positions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_licence_key" ON "drivers" USING btree ("licence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_phone_key" ON "drivers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "vehicle_documents_vehicle_idx" ON "vehicle_documents" USING btree ("vehicle_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "vehicle_positions_vehicle_idx" ON "vehicle_positions" USING btree ("vehicle_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_plate_key" ON "vehicles" USING btree ("plate");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_tracker_key" ON "vehicles" USING btree ("tracker_id");--> statement-breakpoint
ALTER TABLE "liftings" ADD CONSTRAINT "liftings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liftings" ADD CONSTRAINT "liftings_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;