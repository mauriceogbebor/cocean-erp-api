import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../common/auth-context.js";
import { AccessService } from "./access.service.js";

@Controller()
export class AccessController {
  constructor(@Inject(AccessService) private readonly access: AccessService) {}

  @Get("roles")
  @RequirePermissions("roles.read")
  roles() {
    return this.access.listRoles();
  }

  @Get("permissions")
  @RequirePermissions("roles.read")
  permissions() {
    return this.access.listPermissions();
  }
}
