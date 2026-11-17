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
import {
  approvalKinds,
  createApprovalSchema,
  decideApprovalSchema,
  policyBandsSchema,
  type ApprovalKind,
  type PolicyBandsInput,
  type CreateApprovalInput,
  type DecideApprovalInput,
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
import { ApprovalsService } from "./approvals.service.js";

const listQuery = z.object({
  scope: z.enum(["mine", "raised", "all"]).default("mine"),
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional(),
});

@Controller("approvals")
export class ApprovalsController {
  constructor(
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermissions("approvals.read")
  list(
    @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvals.list(user, q.scope, q.status);
  }

  @Get("policies")
  @RequirePermissions("approvals.read")
  policies() {
    return this.approvals.policies();
  }

  @Put("policies/:kind")
  @RequirePermissions("approvals.policies.manage")
  setPolicies(
    @Param("kind", new ZodPipe(z.enum(approvalKinds))) kind: ApprovalKind,
    @Body(new ZodPipe(policyBandsSchema)) body: PolicyBandsInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.approvals.setPolicies(kind, body, actor);
  }

  @Get(":id")
  @RequirePermissions("approvals.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.approvals.get(id);
  }

  @Post()
  @RequirePermissions("approvals.request")
  create(
    @Body(new ZodPipe(createApprovalSchema)) body: CreateApprovalInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.approvals.create(body, user, actor);
  }

  @Post(":id/decide")
  @HttpCode(200)
  @RequirePermissions("approvals.decide")
  decide(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decideApprovalSchema)) body: DecideApprovalInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.approvals.decide(id, body, user, actor);
  }

  @Post(":id/withdraw")
  @HttpCode(200)
  @RequirePermissions("approvals.request")
  withdraw(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.approvals.withdraw(id, user, actor);
  }
}
