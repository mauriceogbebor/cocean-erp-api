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
  cancelWorkOrderSchema,
  completeWorkOrderSchema,
  createWorkOrderSchema,
  submitWorkOrderSchema,
  workshopCostsQuerySchema,
  type CancelWorkOrderInput,
  type CompleteWorkOrderInput,
  type CreateWorkOrderInput,
  type SubmitWorkOrderInput,
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
import { WorkshopService } from "./workshop.service.js";

const Id = new ParseUUIDPipe();
const listQuery = z.object({
  state: z.enum(["open", "closed", "all"]).optional(),
  vehicleId: z.string().uuid().optional(),
});

@Controller()
export class WorkshopController {
  constructor(
    @Inject(WorkshopService) private readonly workshop: WorkshopService,
  ) {}

  @Get("work-orders")
  @RequirePermissions("workshop.read")
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.workshop.list(q);
  }

  @Get("work-orders/:id")
  @RequirePermissions("workshop.read")
  get(@Param("id", Id) id: string) {
    return this.workshop.get(id);
  }

  @Post("work-orders")
  @RequirePermissions("workshop.manage")
  create(
    @Body(new ZodPipe(createWorkOrderSchema)) body: CreateWorkOrderInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.workshop.create(body, user, actor);
  }

  @Post("work-orders/:id/submit")
  @HttpCode(200)
  @RequirePermissions("workshop.manage")
  submit(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(submitWorkOrderSchema)) body: SubmitWorkOrderInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.workshop.submit(id, body, user, actor);
  }

  @Post("work-orders/:id/complete")
  @HttpCode(200)
  @RequirePermissions("workshop.manage")
  complete(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(completeWorkOrderSchema)) body: CompleteWorkOrderInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.workshop.complete(id, body, user, actor);
  }

  @Post("work-orders/:id/cancel")
  @HttpCode(200)
  @RequirePermissions("workshop.manage")
  cancel(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(cancelWorkOrderSchema)) body: CancelWorkOrderInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.workshop.cancel(id, body, actor);
  }

  @Get("workshop/costs")
  @RequirePermissions("workshop.read")
  costs(
    @Query(new ZodPipe(workshopCostsQuerySchema))
    q: z.infer<typeof workshopCostsQuerySchema>,
  ) {
    return this.workshop.costs(q);
  }

  @Get("workshop/service")
  @RequirePermissions("workshop.read")
  service() {
    return this.workshop.serviceDue();
  }
}
