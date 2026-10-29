import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  confirmDeliverySchema,
  loadLiftingSchema,
  planLiftingSchema,
  reasonSchema,
  resolveDeliverySchema,
  type ConfirmDeliveryInput,
  type LoadLiftingInput,
  type PlanLiftingInput,
} from "@cocean/contracts";
import { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  Public,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { LiftingsService } from "./liftings.service.js";

const listQuery = z.object({
  status: z
    .enum(["planned", "in_transit", "delivered", "exception", "cancelled"])
    .optional(),
  orderId: z.uuid().optional(),
});

@Controller()
export class LiftingsController {
  constructor(
    @Inject(LiftingsService) private readonly liftings: LiftingsService,
  ) {}

  @Get("liftings")
  @RequirePermissions("liftings.read")
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.liftings.list(q);
  }

  @Get("liftings/:id")
  @RequirePermissions("liftings.read")
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.liftings.get(id, undefined, user);
  }

  @Post("liftings")
  @RequirePermissions("liftings.plan")
  plan(
    @Body(new ZodPipe(planLiftingSchema)) body: PlanLiftingInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.liftings.plan(body, user, actor);
  }

  @Post("liftings/:id/cancel")
  @HttpCode(200)
  @RequirePermissions("liftings.plan")
  cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.liftings.cancel(id, body.reason, actor);
  }

  @Post("liftings/:id/load")
  @HttpCode(200)
  @RequirePermissions("liftings.load")
  load(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(loadLiftingSchema)) body: LoadLiftingInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.liftings.load(id, body, user, actor);
  }

  /** The receiver's one-time link. No account: the token is the authority. */
  @Public()
  @Post("deliveries/confirm")
  @HttpCode(200)
  confirm(
    @Body(new ZodPipe(confirmDeliverySchema)) body: ConfirmDeliveryInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.liftings.confirm(body, actor);
  }

  @Post("deliveries/:id/resolve")
  @HttpCode(200)
  @RequirePermissions("deliveries.resolve")
  resolve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolveDeliverySchema)) body: { finding: string },
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.liftings.resolve(id, body.finding, user, actor);
  }
}
