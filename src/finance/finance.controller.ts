import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  createReceiptSchema,
  reasonSchema,
  receivablesQuerySchema,
  type CreateReceiptInput,
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
import { ReceivablesService } from "./receivables.service.js";

const byCustomer = z.object({ customerId: z.uuid().optional() });

@Controller()
export class FinanceController {
  constructor(
    @Inject(ReceivablesService) private readonly ar: ReceivablesService,
  ) {}

  @Get("receipts")
  @RequirePermissions("finance.read")
  receipts(@Query(new ZodPipe(byCustomer)) q: z.infer<typeof byCustomer>) {
    return this.ar.listReceipts(q);
  }

  @Post("receipts")
  @RequirePermissions("receipts.manage")
  record(
    @Body(new ZodPipe(createReceiptSchema)) body: CreateReceiptInput,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.ar.recordReceipt(body, user, actor);
  }

  @Post("receipts/:id/reverse")
  @HttpCode(200)
  @RequirePermissions("receipts.manage")
  reverse(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: { reason: string },
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.ar.reverseReceipt(id, body.reason, user, actor);
  }

  @Post("orders/:id/invoice")
  @RequirePermissions("invoices.create")
  invoice(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.ar.invoiceOrder(id, user, actor);
  }

  @Post("deliveries/:id/invoice")
  @RequirePermissions("invoices.create")
  invoiceDelivery(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @CurrentActor() actor: Actor,
  ) {
    return this.ar.invoiceDrop(id, user, actor);
  }

  @Get("invoices")
  @RequirePermissions("finance.read")
  invoices(@Query(new ZodPipe(byCustomer)) q: z.infer<typeof byCustomer>) {
    return this.ar.listInvoices(q);
  }

  @Get("invoices/:id")
  @RequirePermissions("finance.read")
  getInvoice(@Param("id", ParseUUIDPipe) id: string) {
    return this.ar.getInvoice(id);
  }

  @Get("customers/:id/statement")
  @RequirePermissions("finance.read")
  statement(@Param("id", ParseUUIDPipe) id: string) {
    return this.ar.statement(id);
  }

  @Get("receivables")
  @RequirePermissions("finance.read")
  receivables(
    @Query(new ZodPipe(receivablesQuerySchema))
    q: z.infer<typeof receivablesQuerySchema>,
  ) {
    return this.ar.receivables(q.asOf);
  }
}
