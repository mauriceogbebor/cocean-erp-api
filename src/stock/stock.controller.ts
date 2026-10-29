import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  createTankSchema,
  dipSchema,
  type CreateTankInput,
  type DipInput,
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
import { StockService } from "./stock.service.js";

const bySite = z.object({ siteId: z.uuid().optional() });

@Controller("tanks")
export class StockController {
  constructor(@Inject(StockService) private readonly stock: StockService) {}

  @Get()
  @RequirePermissions("stock.read")
  list(@Query(new ZodPipe(bySite)) q: z.infer<typeof bySite>) {
    return this.stock.listTanks(q);
  }

  @Get(":id")
  @RequirePermissions("stock.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.stock.getTank(id);
  }

  @Post()
  @RequirePermissions("tanks.manage")
  create(
    @Body(new ZodPipe(createTankSchema)) body: CreateTankInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.stock.createTank(body, user, actor);
  }

  @Post(":id/dips")
  @RequirePermissions("stock.dip")
  dip(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(dipSchema)) body: DipInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.stock.recordDip(id, body, user, actor);
  }
}
