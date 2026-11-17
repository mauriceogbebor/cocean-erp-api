import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import {
  updateOrganizationSchema,
  type OrganizationSettings,
} from "@qorrix-erp/contracts";
import { type Actor, CurrentActor, Public } from "../common/auth-context.js";
import { RequirePermissions } from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { OrganizationService } from "./organization.service.js";

@Controller("organization")
export class OrganizationController {
  constructor(
    @Inject(OrganizationService) private readonly org: OrganizationService,
  ) {}

  /** Name, logo and formats for the sign-in page; no account needed. */
  @Get("public")
  @Public()
  publicView() {
    return this.org.publicView();
  }

  /** Everyone signed in reads the settings: forms need the lists and formats. */
  @Get()
  get() {
    return this.org.get();
  }

  @Put()
  @RequirePermissions("settings.manage")
  update(
    @Body(new ZodPipe(updateOrganizationSchema)) body: OrganizationSettings,
    @CurrentActor() actor: Actor,
  ) {
    return this.org.update(body, actor);
  }
}
