import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { AccessController } from "./access/access.controller.js";
import { AccessService } from "./access/access.service.js";
import { ApprovalHandlers } from "./approvals/approval-handlers.js";
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
import { CustomersController } from "./customers/customers.controller.js";
import { CustomersService } from "./customers/customers.service.js";
import { FinanceController } from "./finance/finance.controller.js";
import { ReceivablesService } from "./finance/receivables.service.js";
import { HealthController } from "./health/health.controller.js";
import { MasterDataController } from "./master-data/master-data.controller.js";
import { MasterDataService } from "./master-data/master-data.service.js";
import { OrdersController } from "./orders/orders.controller.js";
import { OrdersService } from "./orders/orders.service.js";
import { BillsService } from "./procurement/bills.service.js";
import { ProcurementController } from "./procurement/procurement.controller.js";
import { PurchaseOrdersService } from "./procurement/purchase-orders.service.js";
import { VendorsService } from "./procurement/vendors.service.js";
import { LiftingsController } from "./logistics/liftings.controller.js";
import { LiftingsService } from "./logistics/liftings.service.js";
import { StockController } from "./stock/stock.controller.js";
import { StockService } from "./stock/stock.service.js";
import { PricingController } from "./pricing/pricing.controller.js";
import { PricingService } from "./pricing/pricing.service.js";
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
        CustomersController,
        PricingController,
        OrdersController,
        FinanceController,
        ProcurementController,
        StockController,
        LiftingsController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: DB, useValue: db },
        AccessService,
        AuditService,
        AuthService,
        UsersService,
        MasterDataService,
        ApprovalHandlers,
        ApprovalsService,
        CustomersService,
        PricingService,
        OrdersService,
        ReceivablesService,
        VendorsService,
        PurchaseOrdersService,
        BillsService,
        StockService,
        LiftingsService,
        // Order matters: who you are, then what you may do.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    };
  }
}
