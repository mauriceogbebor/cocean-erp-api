import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { RequirePermissions } from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AuditService } from "./audit.service.js";

const query = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.uuid().optional(),
  before: z.coerce.number().int().positive().optional(),
});

@Controller("audit")
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions("audit.read")
  list(@Query(new ZodPipe(query)) q: z.infer<typeof query>) {
    return this.audit.list(q);
  }
}
