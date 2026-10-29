import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
} from "@nestjs/common";
import { loginSchema, refreshSchema, type LoginInput } from "@cocean/contracts";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  Public,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AuthService } from "./auth.service.js";

const strip = ({
  sessionId: _,
  ...pair
}: { sessionId: string } & Record<string, unknown>) => pair;

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @CurrentActor() actor: Actor,
    @Headers("user-agent") ua?: string,
  ) {
    return strip(await this.auth.login(body, actor, ua));
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Body(new ZodPipe(refreshSchema)) body: { refreshToken: string },
    @CurrentActor() actor: Actor,
    @Headers("user-agent") ua?: string,
  ) {
    return strip(await this.auth.refresh(body.refreshToken, actor, ua));
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Body(new ZodPipe(refreshSchema)) body: { refreshToken: string },
    @CurrentActor() actor: Actor,
  ) {
    await this.auth.logout(body.refreshToken, actor);
  }

  /** Who is signed in, with their roles and permissions. */
  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
