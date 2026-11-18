import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import {
  createEmployeeSchema,
  employeeStatuses,
  exitEmployeeSchema,
  gradeSchema,
  payChangeSchema,
  payPayrollSchema,
  startPayrollSchema,
  submitPayrollSchema,
  updateEmployeeSchema,
  type CreateEmployeeInput,
  type ExitEmployeeInput,
  type GradeInput,
  type PayChangeInput,
  type PayPayrollInput,
  type StartPayrollInput,
  type SubmitPayrollInput,
  type UpdateEmployeeInput,
} from "@qorrix-erp/contracts";
import type { Response } from "express";
import { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { PayrollService } from "./payroll.service.js";
import { PeopleService } from "./people.service.js";

const Id = new ParseUUIDPipe();
const statusQuery = z.object({ status: z.enum(employeeStatuses).optional() });
const formats = {
  phone: "phone",
  taxId: "taxId",
  accountNumber: "bankAccount",
} as const;

@Controller()
export class PeopleController {
  constructor(
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(PayrollService) private readonly payroll: PayrollService,
  ) {}

  // ── Grades ────────────────────────────────────────────────────────────────

  @Get("grades")
  @RequirePermissions("people.read")
  grades() {
    return this.people.listGrades();
  }

  @Post("grades")
  @RequirePermissions("people.manage")
  createGrade(
    @Body(new ZodPipe(gradeSchema)) body: GradeInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.people.createGrade(body, actor);
  }

  @Put("grades/:id")
  @RequirePermissions("people.manage")
  updateGrade(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(gradeSchema)) body: GradeInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.people.updateGrade(id, body, actor);
  }

  // ── People ────────────────────────────────────────────────────────────────

  @Get("employees")
  @RequirePermissions("people.read")
  list(@Query(new ZodPipe(statusQuery)) q: z.infer<typeof statusQuery>) {
    return this.people.list(q.status);
  }

  @Get("employees/:id")
  @RequirePermissions("people.read")
  get(@Param("id", Id) id: string) {
    return this.people.get(id);
  }

  @Post("employees")
  @RequirePermissions("people.manage")
  create(
    @Body(new ZodPipe(createEmployeeSchema, formats))
    body: CreateEmployeeInput & { taxState: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.people.create(body, actor);
  }

  @Put("employees/:id")
  @RequirePermissions("people.manage")
  update(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(updateEmployeeSchema, formats)) body: UpdateEmployeeInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.people.update(id, body, actor);
  }

  @Post("employees/:id/pay")
  @HttpCode(200)
  @RequirePermissions("people.manage")
  changePay(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(payChangeSchema)) body: PayChangeInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.people.changePay(id, body, actor);
  }

  @Post("employees/:id/activate")
  @HttpCode(200)
  @RequirePermissions("people.manage")
  activate(@Param("id", Id) id: string, @CurrentActor() actor: Actor) {
    return this.people.activate(id, actor);
  }

  @Post("employees/:id/exit")
  @HttpCode(200)
  @RequirePermissions("people.manage")
  exit(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(exitEmployeeSchema)) body: ExitEmployeeInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.people.exit(id, body, actor);
  }

  // ── Payroll ───────────────────────────────────────────────────────────────

  @Get("payroll-runs")
  @RequirePermissions("payroll.read")
  runs() {
    return this.payroll.list();
  }

  @Get("payroll-runs/:id")
  @RequirePermissions("payroll.read")
  run(@Param("id", Id) id: string) {
    return this.payroll.get(id);
  }

  @Get("payroll-runs/:id/payslips/:employeeId")
  @RequirePermissions("payroll.read")
  payslip(
    @Param("id", Id) id: string,
    @Param("employeeId", Id) employeeId: string,
  ) {
    return this.payroll.payslip(id, employeeId);
  }

  /** Works out a month: starts it, or works a draft or refused run out again. */
  @Post("payroll-runs")
  @RequirePermissions("payroll.prepare")
  calculate(
    @Body(new ZodPipe(startPayrollSchema)) body: StartPayrollInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.payroll.calculate(body.period, actor);
  }

  @Post("payroll-runs/:id/submit")
  @HttpCode(200)
  @RequirePermissions("payroll.prepare")
  submit(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(submitPayrollSchema)) body: SubmitPayrollInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.payroll.submit(id, body, user, actor);
  }

  @Get("payroll-runs/:id/bank-file")
  @RequirePermissions("payroll.pay")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async bankFile(@Param("id", Id) id: string, @Res() res: Response) {
    const f = await this.payroll.bankFile(id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${f.filename}"`,
    );
    res.send(f.csv);
  }

  @Post("payroll-runs/:id/pay")
  @HttpCode(200)
  @RequirePermissions("payroll.pay")
  pay(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(payPayrollSchema)) body: PayPayrollInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.payroll.pay(id, body, user, actor);
  }
}
