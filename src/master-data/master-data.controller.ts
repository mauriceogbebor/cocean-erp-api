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
  createProductSchema,
  createSiteSchema,
  updateProductSchema,
  updateSiteSchema,
  type CreateSiteInput,
} from "@cocean/contracts";
import type { z } from "zod";
import {
  type Actor,
  CurrentActor,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { MasterDataService } from "./master-data.service.js";

@Controller()
export class MasterDataController {
  constructor(
    @Inject(MasterDataService) private readonly md: MasterDataService,
  ) {}

  @Get("sites")
  @RequirePermissions("sites.read")
  sites() {
    return this.md.listSites();
  }

  @Post("sites")
  @RequirePermissions("sites.manage")
  createSite(
    @Body(new ZodPipe(createSiteSchema)) body: CreateSiteInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.md.createSite(body, actor);
  }

  @Patch("sites/:id")
  @RequirePermissions("sites.manage")
  updateSite(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSiteSchema)) body: z.infer<typeof updateSiteSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.md.updateSite(id, body, actor);
  }

  @Get("products")
  @RequirePermissions("products.read")
  products() {
    return this.md.listProducts();
  }

  @Post("products")
  @RequirePermissions("products.manage")
  createProduct(
    @Body(new ZodPipe(createProductSchema))
    body: z.infer<typeof createProductSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.md.createProduct(body, actor);
  }

  @Patch("products/:code")
  @RequirePermissions("products.manage")
  updateProduct(
    @Param("code") code: string,
    @Body(new ZodPipe(updateProductSchema))
    body: z.infer<typeof updateProductSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.md.updateProduct(code.toUpperCase(), body, actor);
  }
}
