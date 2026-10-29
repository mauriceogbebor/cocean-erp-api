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
  createOrderSchema,
  reasonSchema,
  type CreateOrderInput,
} from "@cocean/contracts";
import { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { OrdersService } from "./orders.service.js";

const listQuery = z.object({
  status: z
    .enum([
      "awaiting_payment",
      "credit_hold",
      "override_pending",
      "released",
      "cancelled",
    ])
    .optional(),
  customerId: z.uuid().optional(),
});

@Controller("orders")
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions("orders.read")
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.orders.list(q);
  }

  @Get(":id")
  @RequirePermissions("orders.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }

  @Post()
  @RequirePermissions("orders.create")
  create(
    @Body(new ZodPipe(createOrderSchema)) body: CreateOrderInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.orders.create(body, user, actor);
  }

  @Post(":id/override")
  @HttpCode(200)
  @RequirePermissions("orders.create", "approvals.request")
  override(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason: string },
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.orders.requestOverride(id, body.reason, user, actor);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermissions("orders.cancel")
  cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.orders.cancel(id, body.reason, actor);
  }
}
