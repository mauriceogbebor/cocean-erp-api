import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  billPaidSchema,
  createPurchaseOrderSchema,
  createVendorSchema,
  goodsReceiptSchema,
  purchaseOrderLinesSchema,
  reasonSchema,
  supplierBillSchema,
  updateVendorSchema,
  vendorBankSchema,
  type BillPaidInput,
  type CreatePurchaseOrderInput,
  type CreateVendorInput,
  type GoodsReceiptInput,
  type SupplierBillInput,
  type VendorBankInput,
} from "@cocean/contracts";
import { z } from "zod";
import {
  type Actor,
  type AuthUser,
  CurrentActor,
  CurrentUser,
  RequirePermissions,
} from "../common/auth-context.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { BillsService } from "./bills.service.js";
import { PurchaseOrdersService } from "./purchase-orders.service.js";
import { VendorsService } from "./vendors.service.js";

const Id = new ParseUUIDPipe();
const reason = new ZodPipe(reasonSchema);
const poQuery = z.object({
  status: z
    .enum([
      "draft",
      "pending",
      "approved",
      "partially_received",
      "received",
      "cancelled",
    ])
    .optional(),
  vendorId: z.uuid().optional(),
});
const billQuery = z.object({
  status: z
    .enum([
      "matched",
      "exception",
      "payment_pending",
      "approved",
      "paid",
      "void",
    ])
    .optional(),
  vendorId: z.uuid().optional(),
});

@Controller()
export class ProcurementController {
  constructor(
    @Inject(VendorsService) private readonly vendors: VendorsService,
    @Inject(PurchaseOrdersService) private readonly pos: PurchaseOrdersService,
    @Inject(BillsService) private readonly bills: BillsService,
  ) {}

  // Suppliers
  @Get("vendors")
  @RequirePermissions("vendors.read")
  listVendors() {
    return this.vendors.list();
  }

  @Get("vendors/:id")
  @RequirePermissions("vendors.read")
  getVendor(@Param("id", Id) id: string) {
    return this.vendors.get(id);
  }

  @Post("vendors")
  @RequirePermissions("vendors.manage")
  createVendor(
    @Body(new ZodPipe(createVendorSchema)) body: CreateVendorInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.vendors.create(body, user, actor);
  }

  @Patch("vendors/:id")
  @RequirePermissions("vendors.manage")
  updateVendor(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(updateVendorSchema))
    body: z.infer<typeof updateVendorSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.vendors.update(id, body, actor);
  }

  @Post("vendors/:id/bank-details")
  @RequirePermissions("vendors.manage", "approvals.request")
  bank(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(vendorBankSchema)) body: VendorBankInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.vendors.requestBank(id, body, user, actor);
  }

  // Purchase orders and goods received
  @Get("purchase-orders")
  @RequirePermissions("purchase_orders.read")
  listPos(@Query(new ZodPipe(poQuery)) q: z.infer<typeof poQuery>) {
    return this.pos.list(q);
  }

  @Get("purchase-orders/:id")
  @RequirePermissions("purchase_orders.read")
  getPo(@Param("id", Id) id: string) {
    return this.pos.get(id);
  }

  @Post("purchase-orders")
  @RequirePermissions("purchase_orders.manage")
  createPo(
    @Body(new ZodPipe(createPurchaseOrderSchema))
    body: CreatePurchaseOrderInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.pos.create(body, user, actor);
  }

  @Put("purchase-orders/:id/lines")
  @RequirePermissions("purchase_orders.manage")
  poLines(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(purchaseOrderLinesSchema))
    body: z.infer<typeof purchaseOrderLinesSchema>,
    @CurrentActor() actor: Actor,
  ) {
    return this.pos.replaceLines(id, body.lines, actor);
  }

  @Post("purchase-orders/:id/submit")
  @HttpCode(200)
  @RequirePermissions("purchase_orders.manage", "approvals.request")
  submitPo(
    @Param("id", Id) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.pos.submit(id, user, actor);
  }

  @Post("purchase-orders/:id/cancel")
  @HttpCode(200)
  @RequirePermissions("purchase_orders.manage")
  cancelPo(
    @Param("id", Id) id: string,
    @Body(reason) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.pos.cancel(id, body.reason, actor);
  }

  @Post("purchase-orders/:id/receipts")
  @RequirePermissions("goods.receive")
  receive(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(goodsReceiptSchema)) body: GoodsReceiptInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.pos.receive(id, body, user, actor);
  }

  // Supplier invoices and payment
  @Get("bills")
  @RequirePermissions("purchase_orders.read")
  listBills(@Query(new ZodPipe(billQuery)) q: z.infer<typeof billQuery>) {
    return this.bills.list(q);
  }

  @Get("bills/:id")
  @RequirePermissions("purchase_orders.read")
  getBill(@Param("id", Id) id: string) {
    return this.bills.get(id);
  }

  @Post("bills")
  @RequirePermissions("bills.manage")
  createBill(
    @Body(new ZodPipe(supplierBillSchema)) body: SupplierBillInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.bills.create(body, user, actor);
  }

  @Post("bills/:id/void")
  @HttpCode(200)
  @RequirePermissions("bills.manage")
  voidBill(
    @Param("id", Id) id: string,
    @Body(reason) body: { reason: string },
    @CurrentActor() actor: Actor,
  ) {
    return this.bills.void(id, body.reason, actor);
  }

  @Post("bills/:id/request-payment")
  @HttpCode(200)
  @RequirePermissions("bills.manage", "approvals.request")
  requestPayment(
    @Param("id", Id) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.bills.requestPayment(id, user, actor);
  }

  @Post("bills/:id/paid")
  @HttpCode(200)
  @RequirePermissions("bills.manage")
  paid(
    @Param("id", Id) id: string,
    @Body(new ZodPipe(billPaidSchema)) body: BillPaidInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.bills.markPaid(id, body, user, actor);
  }

  @Get("payables")
  @RequirePermissions("purchase_orders.read")
  payables() {
    return this.bills.payables();
  }
}
