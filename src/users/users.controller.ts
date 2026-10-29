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
  createUserSchema,
  setRolesSchema,
  type CreateUserInput,
  type RoleKey,
} from "@cocean/contracts";
import { z } from "zod";
import {
  type Actor,
  CurrentActor,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { UsersService } from "./users.service.js";

const statusSchema = z.object({ status: z.enum(["active", "disabled"]) });

@Controller("users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @RequirePermissions("users.read")
  list() {
    return this.users.list();
  }

  @Post()
  @RequirePermissions("users.manage")
  create(
    @Body(new ZodPipe(createUserSchema)) body: CreateUserInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.users.create(body, actor);
  }

  @Patch(":id/roles")
  @RequirePermissions("users.manage")
  setRoles(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setRolesSchema)) body: { roles: string[] },
    @CurrentActor() actor: Actor,
  ) {
    return this.users.setRoles(id, body.roles as RoleKey[], actor);
  }

  @Patch(":id/status")
  @RequirePermissions("users.manage")
  setStatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(statusSchema)) body: z.infer<typeof statusSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.users.setStatus(id, body.status, actor);
  }
}
