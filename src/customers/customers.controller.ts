import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import {
  createCustomerSchema,
  creditTermsSchema,
  customerSiteSchema,
  updateCustomerSchema,
  type CreateCustomerInput,
  type CreditTermsInput,
  type CustomerSiteInput,
} from "@cocean/contracts";
import type { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { CustomersService } from "./customers.service.js";

@Controller("customers")
export class CustomersController {
  constructor(
    @Inject(CustomersService) private readonly customers: CustomersService,
  ) {}

  @Get()
  @RequirePermissions("customers.read")
  list() {
    return this.customers.list();
  }

  @Get(":id")
  @RequirePermissions("customers.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.customers.get(id);
  }

  @Post()
  @RequirePermissions("customers.manage")
  create(
    @Body(new ZodPipe(createCustomerSchema)) body: CreateCustomerInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.customers.create(body, user, actor);
  }

  @Patch(":id")
  @RequirePermissions("customers.manage")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateCustomerSchema))
    body: z.infer<typeof updateCustomerSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.customers.update(id, body, actor);
  }

  /** Raises an approval; the terms change only when it is approved. */
  @Post(":id/credit-terms")
  @RequirePermissions("customers.manage", "approvals.request")
  requestTerms(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(creditTermsSchema)) body: CreditTermsInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.customers.requestTerms(id, body, user, actor);
  }

  @Post(":id/sites")
  @RequirePermissions("customers.manage")
  addSite(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(customerSiteSchema)) body: CustomerSiteInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.customers.addSite(id, body, actor);
  }
}
