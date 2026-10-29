import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { AccessController } from "./access/access.controller.js";
import { AccessService } from "./access/access.service.js";
import { ApprovalsController } from "./approvals/approvals.controller.js";
import { ApprovalsService } from "./approvals/approvals.service.js";
import { AuditController } from "./audit/audit.controller.js";
import { AuditService } from "./audit/audit.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { AuthGuard, PermissionsGuard } from "./common/guards.js";
import { DB, ENV } from "./common/tokens.js";
import type { Env } from "./config/env.js";
import type { Db } from "./db/client.js";
import { HealthController } from "./health/health.controller.js";
import { MasterDataController } from "./master-data/master-data.controller.js";
import { MasterDataService } from "./master-data/master-data.service.js";
import { UsersController } from "./users/users.controller.js";
import { UsersService } from "./users/users.service.js";

/**
 * The foundation every module builds on: identity, permissions, audit,
 * approvals and master data. Business modules (sales, finance, depot…) are
 * added here as they are built.
 */
@Module({})
export class AppModule {
  static register(env: Env, db: Db): DynamicModule {
    return {
      module: AppModule,
      imports: [
        JwtModule.register({
          secret: env.JWT_SECRET,
          signOptions: {
            expiresIn: `${env.ACCESS_TOKEN_MINUTES}m`,
            issuer: "cocean-erp",
          },
          verifyOptions: { issuer: "cocean-erp" },
        }),
      ],
      controllers: [
        HealthController,
        AuthController,
        AccessController,
        UsersController,
        AuditController,
        MasterDataController,
        ApprovalsController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: DB, useValue: db },
        AccessService,
        AuditService,
        AuthService,
        UsersService,
        MasterDataService,
        ApprovalsService,
        // Order matters: who you are, then what you may do.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    };
  }
}
