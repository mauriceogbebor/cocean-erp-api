import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  bankTakingsSchema,
  closeShiftSchema,
  createCylinderSchema,
  createPumpSchema,
  fillSchema,
  reasonSchema,
  stationReceiptSchema,
  userSitesSchema,
  type BankTakingsInput,
  type CloseShiftInput,
  type CreateCylinderInput,
  type CreatePumpInput,
  type FillInput,
  type StationReceiptInput,
} from "@qorrix-erp/contracts";
import { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { LpgService } from "./lpg.service.js";
import { StationsService } from "./stations.service.js";

const Id = new ParseUUIDPipe();
const shiftQuery = z.object({
  siteId: z.uuid().optional(),
  status: z
    .enum([
      "balanced",
      "variance_pending",
      "variance_accepted",
      "variance_rejected",
      "banked",
    ])
    .optional(),
});
const siteQuery = z.object({ siteId: z.uuid() });

@Controller()
export class StationsController {
  constructor(
    @Inject(StationsService) private readonly stations: StationsService,
    @Inject(LpgService) private readonly lpg: LpgService,
  ) {}

  @Get("stations")
  @RequirePermissions("stations.read")
  overview() {
    return this.stations.overview();
  }

  @Put("users/:id/sites")
  @RequirePermissions("stations.manage")
  userSites(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(userSitesSchema)) body: { siteIds: string[] },
    @CurrentActor() actor: Actor,
  ) {
    return this.stations.setUserSites(id, body.siteIds, actor);
  }

  @Get("pumps")
  @RequirePermissions("stations.read")
  pumps(@Query(new ZodPipe(siteQuery)) q: { siteId: string }) {
    return this.stations.listPumps(q.siteId);
  }

  @Post("pumps")
  @RequirePermissions("stations.manage")
  createPump(
    @Body(new ZodPipe(createPumpSchema)) body: CreatePumpInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.stations.createPump(body, actor);
  }

  @Post("tanks/:id/receipts")
  @RequirePermissions("stations.operate")
  receive(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(stationReceiptSchema)) body: StationReceiptInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.stations.receive(id, body, user, actor);
  }

  @Get("shifts")
  @RequirePermissions("stations.read")
  shifts(@Query(new ZodPipe(shiftQuery)) q: z.infer<typeof shiftQuery>) {
    return this.stations.listShifts(q);
  }

  @Get("shifts/:id")
  @RequirePermissions("stations.read")
  shift(@Param("id", Id) id: string) {
    return this.stations.getShift(id);
  }

  @Post("shifts")
  @RequirePermissions("stations.operate")
  close(
    @Body(new ZodPipe(closeShiftSchema)) body: CloseShiftInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.stations.close(body, user, actor);
  }

  @Post("shifts/:id/bank")
  @HttpCode(200)
  @RequirePermissions("takings.bank")
  bank(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(bankTakingsSchema)) body: BankTakingsInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.stations.bank(id, body, user, actor);
  }

  @Get("cylinders")
  @RequirePermissions("stations.read")
  cylinders() {
    return this.lpg.listCylinders();
  }

  @Post("cylinders")
  @RequirePermissions("stations.operate")
  createCylinder(
    @Body(new ZodPipe(createCylinderSchema)) body: CreateCylinderInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.lpg.createCylinder(body, actor);
  }

  @Post("cylinders/:id/condemn")
  @HttpCode(200)
  @RequirePermissions("stations.operate")
  condemn(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.lpg.condemn(id, body.reason, actor);
  }

  @Get("fills")
  @RequirePermissions("stations.read")
  fills(@Query(new ZodPipe(siteQuery)) q: { siteId: string }) {
    return this.lpg.openFills(q.siteId);
  }

  @Post("fills")
  @RequirePermissions("stations.operate")
  fill(
    @Body(new ZodPipe(fillSchema)) body: FillInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.lpg.fill(body, user, actor);
  }
}
