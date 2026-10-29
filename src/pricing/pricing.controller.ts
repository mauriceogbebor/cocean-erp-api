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
import { priceListSchema, type PriceListInput } from "@cocean/contracts";
import { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { PricingService } from "./pricing.service.js";

const linesSchema = z.object({ lines: priceListSchema.shape.lines });
const onDate = z.object({ date: z.iso.date().optional() });

@Controller("price-lists")
export class PricingController {
  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {}

  @Get()
  @RequirePermissions("prices.read")
  list() {
    return this.pricing.list();
  }

  /** The approved list in force today, or on ?date=YYYY-MM-DD. */
  @Get("in-force")
  @RequirePermissions("prices.read")
  async inForce(@Query(new ZodPipe(onDate)) q: z.infer<typeof onDate>) {
    return (await this.pricing.inForce(undefined, q.date)) ?? null;
  }

  @Get(":id")
  @RequirePermissions("prices.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.pricing.get(id);
  }

  @Post()
  @RequirePermissions("prices.manage")
  create(
    @Body(new ZodPipe(priceListSchema)) body: PriceListInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.pricing.create(body, user, actor);
  }

  @Put(":id/lines")
  @RequirePermissions("prices.manage")
  replaceLines(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(linesSchema)) body: z.infer<typeof linesSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.pricing.replaceLines(id, body.lines, actor);
  }

  @Post(":id/submit")
  @HttpCode(200)
  @RequirePermissions("prices.manage", "approvals.request")
  submit(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.pricing.submit(id, user, actor);
  }
}
