import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Permission } from "@cocean/contracts";
import { AccessService } from "../access/access.service.js";
import { type AppRequest, IS_PUBLIC, PERMISSIONS_KEY } from "./auth-context.js";

/**
 * Every endpoint needs a valid access token unless marked @Public(). The
 * user's roles and permissions are read from the database on each request,
 * so a disabled account or a removed role takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token)
      throw new UnauthorizedException("Sign in first");
    let sub: string;
    try {
      sub = (await this.jwt.verifyAsync<{ sub: string }>(token)).sub;
    } catch {
      throw new UnauthorizedException(
        "Your session has expired. Sign in again.",
      );
    }
    const user = await this.access.loadUser(sub);
    if (!user) throw new UnauthorizedException("This account is not active");
    req.user = user;
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const needed = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!needed?.length) return true;
    const user = ctx.switchToHttp().getRequest<AppRequest>().user;
    const missing = needed.filter((p) => !user?.permissions.includes(p));
    if (missing.length)
      throw new ForbiddenException(
        `You don't have permission to do this (${missing.join(", ")})`,
      );
    return true;
  }
}
