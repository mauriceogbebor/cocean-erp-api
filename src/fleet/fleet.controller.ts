import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import {
  createDriverSchema,
  createVehicleSchema,
  reasonSchema,
  trackerPingsSchema,
  updateDriverSchema,
  vehicleDocumentSchema,
  type CreateDriverInput,
  type CreateVehicleInput,
  type TrackerPingsInput,
  type VehicleDocumentInput,
} from "@qorrix-erp/contracts";
import type { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  Public,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { FleetService } from "./fleet.service.js";
import { TrackingService } from "./tracking.service.js";

const Id = new ParseUUIDPipe();
const reason = new ZodPipe(reasonSchema);

@Controller()
export class FleetController {
  constructor(
    @Inject(FleetService) private readonly fleet: FleetService,
    @Inject(TrackingService) private readonly tracking: TrackingService,
  ) {}

  @Get("vehicles")
  @RequirePermissions("fleet.read")
  vehicles() {
    return this.fleet.listVehicles();
  }

  @Get("vehicles/:id")
  @RequirePermissions("fleet.read")
  vehicle(@Param("id", Id) id: string) {
    return this.fleet.getVehicle(id);
  }

  @Post("vehicles")
  @RequirePermissions("fleet.manage")
  register(
    @Body(new ZodPipe(createVehicleSchema, { plate: "plate" }))
    body: CreateVehicleInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.createVehicle(body, user, actor);
  }

  @Post("vehicles/:id/documents")
  @RequirePermissions("fleet.manage")
  document(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(vehicleDocumentSchema)) body: VehicleDocumentInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.addDocument(id, body, user, actor);
  }

  @Post("vehicles/:id/submit")
  @HttpCode(200)
  @RequirePermissions("fleet.manage", "approvals.request")
  submit(
    @Param("id", Id) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.submit(id, user, actor);
  }

  @Post("vehicles/:id/hold")
  @HttpCode(200)
  @RequirePermissions("fleet.manage")
  hold(
    @Param("id", Id) id: string,
    @Body(reason) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.hold(id, body.reason, actor);
  }

  @Post("vehicles/:id/clear-hold")
  @HttpCode(200)
  @RequirePermissions("fleet.manage")
  clearHold(@Param("id", Id) id: string, @CurrentActor() actor: Actor) {
    return this.fleet.clearHold(id, actor);
  }

  @Get("drivers")
  @RequirePermissions("fleet.read")
  drivers() {
    return this.fleet.listDrivers();
  }

  @Post("drivers")
  @RequirePermissions("fleet.manage")
  createDriver(
    @Body(new ZodPipe(createDriverSchema, { phone: "phone" }))
    body: CreateDriverInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.createDriver(body, actor);
  }

  @Patch("drivers/:id")
  @RequirePermissions("fleet.manage")
  updateDriver(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(updateDriverSchema, { phone: "phone" }))
    body: z.infer<typeof updateDriverSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.updateDriver(id, body, actor);
  }

  @Post("drivers/:id/suspend")
  @HttpCode(200)
  @RequirePermissions("fleet.manage")
  suspend(
    @Param("id", Id) id: string,
    @Body(reason) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.suspend(id, body.reason, actor);
  }

  @Post("drivers/:id/reinstate")
  @HttpCode(200)
  @RequirePermissions("fleet.manage")
  reinstate(
    @Param("id", Id) id: string,
    @Body(reason) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.fleet.reinstate(id, body.reason, actor);
  }

  @Get("tracking")
  @RequirePermissions("fleet.read")
  board() {
    return this.tracking.board();
  }

  /** The tracker provider posts positions here with its shared key. No user account. */
  @Public()
  @Post("tracking/pings")
  @HttpCode(200)
  pings(
    @Body(new ZodPipe(trackerPingsSchema)) body: TrackerPingsInput,
    @Headers("x-tracker-key") key?: string,
  ) {
    return this.tracking.ingest(body, key);
  }
}
