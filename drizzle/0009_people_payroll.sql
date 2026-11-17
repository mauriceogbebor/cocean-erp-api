CREATE TYPE "public"."employee_status" AS ENUM('onboarding', 'active', 'exited');--> statement-breakpoint
CREATE TYPE "public"."payroll_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'paid');--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"department" text NOT NULL,
	"job_title" text NOT NULL,
	"site_id" uuid,
	"grade_id" uuid NOT NULL,
	"employment_type" text NOT NULL,
	"status" "employee_status" DEFAULT 'onboarding' NOT NULL,
	"start_date" date NOT NULL,
	"exit_date" date,
	"exit_reason" text,
	"basic" numeric(18, 2) NOT NULL,
	"housing" numeric(18, 2) NOT NULL,
	"transport" numeric(18, 2) NOT NULL,
	"other" numeric(18, 2) NOT NULL,
	"bank_name" text,
	"account_number" text,
	"account_name" text,
	"pfa" text,
	"rsa_pin" text,
	"tax_id" text,
	"tax_state" text NOT NULL,
	"nhf_opt_in" boolean DEFAULT false NOT NULL,
	"annual_rent" numeric(18, 2) DEFAULT '0' NOT NULL,
	"activated_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"min_monthly" numeric(18, 2) NOT NULL,
	"max_monthly" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grades_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"department" text NOT NULL,
	"job_title" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"account_name" text,
	"pfa" text,
	"rsa_pin" text,
	"tax_state" text NOT NULL,
	"factor" numeric(6, 4) NOT NULL,
	"basic" numeric(18, 2) NOT NULL,
	"housing" numeric(18, 2) NOT NULL,
	"transport" numeric(18, 2) NOT NULL,
	"other" numeric(18, 2) NOT NULL,
	"gross" numeric(18, 2) NOT NULL,
	"pension_employee" numeric(18, 2) NOT NULL,
	"nhf" numeric(18, 2) NOT NULL,
	"rent_relief" numeric(18, 2) NOT NULL,
	"paye" numeric(18, 2) NOT NULL,
	"net" numeric(18, 2) NOT NULL,
	"pension_employer" numeric(18, 2) NOT NULL,
	"nsitf" numeric(18, 2) NOT NULL,
	"itf" numeric(18, 2) NOT NULL,
	"flags" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"period" text NOT NULL,
	"status" "payroll_status" DEFAULT 'draft' NOT NULL,
	"headcount" integer NOT NULL,
	"gross" numeric(18, 2) NOT NULL,
	"net" numeric(18, 2) NOT NULL,
	"paye" numeric(18, 2) NOT NULL,
	"pension_employee" numeric(18, 2) NOT NULL,
	"pension_employer" numeric(18, 2) NOT NULL,
	"nhf" numeric(18, 2) NOT NULL,
	"nsitf" numeric(18, 2) NOT NULL,
	"itf" numeric(18, 2) NOT NULL,
	"employer_cost" numeric(18, 2) NOT NULL,
	"rules" jsonb NOT NULL,
	"note" text,
	"approval_id" uuid,
	"prepared_by" uuid NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"paid_on" date,
	"bank_ref" text,
	"paid_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_period_unique" UNIQUE("period")
);
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_lines_run_employee" ON "payroll_lines" USING btree ("run_id","employee_id");