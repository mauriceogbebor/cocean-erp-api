import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from "@nestjs/common";
import type { Permission, RoleKey } from "@cocean/contracts";
import type { Request } from "express";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  roles: RoleKey[];
  permissions: Permission[];
};

export type AppRequest = Request & {
  user?: AuthUser;
  requestId: string;
};

export const IS_PUBLIC = "isPublic";
/** The endpoint can be called without signing in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMISSIONS_KEY = "permissions";
/** The signed-in user must hold every listed permission. */
export const RequirePermissions = (...p: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, p);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AppRequest>().user!,
);

/** Who did it and from where, for the audit trail. */
export type Actor = { userId: string | null; ip?: string; requestId?: string };
export const CurrentActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Actor => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    return {
      userId: req.user?.id ?? null,
      ip: req.ip,
      requestId: req.requestId,
    };
  },
);
