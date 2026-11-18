import { z } from "zod";

const isoDate = z.iso.date();
const phone = z
  .string()
  .trim()
  .regex(/^\+?[\d ()-]{7,20}$/, "Enter a phone number");

/** Where a supplier is paid. Changes only through Finance's approval. */
export const vendorBankSchema = z.object({
  bankName: z.string().trim().min(2).max(60),
  /** Checked against the organization's bank account format. */
  accountNumber: z.string().trim().min(4).max(34),
  accountName: z.string().trim().min(3).max(120),
  reason: z
    .string()
    .trim()
    .min(10, "Say why, and how the details were confirmed"),
});
export type VendorBankInput = z.infer<typeof vendorBankSchema>;

export const createVendorSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^VEN-\d{3,6}$/, "Codes look like VEN-031"),
  name: z.string().trim().min(3).max(200),
  /** Checked against the organization's tax ID format. */
  tin: z.string().trim().min(3).max(30).optional(),
  email: z.email().optional(),
  phone: phone.optional(),
  address: z.string().trim().min(5).max(500),
  /** Raised for Finance to verify; the supplier can't be paid until it is. */
  bank: vendorBankSchema.optional(),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = createVendorSchema
  .omit({ code: true, bank: true })
  .partial()
  .extend({
    active: z.boolean().optional(),
    email: z.email().nullable().optional(),
  });

const poLine = z.object({
  /** Stock items name a product; services and spares leave it out. */
  productCode: z.string().trim().toUpperCase().optional(),
  description: z.string().trim().min(3).max(300),
  quantity: z.number().positive().max(1e8),
  unit: z.string().trim().min(1).max(20),
  /** The supplier's quoted price per unit, before VAT. */
  unitPrice: z.number().positive().max(1e11),
  /** Blank takes the organization's default VAT rate. */
  vatRate: z.number().min(0).max(0.5).optional(),
});

export const purchaseOrderLinesSchema = z.object({
  lines: z.array(poLine).min(1).max(50),
});

export const createPurchaseOrderSchema = purchaseOrderLinesSchema.extend({
  vendorId: z.uuid(),
  /** The site the goods are delivered to and received at. */
  siteId: z.uuid(),
  /** Why this is needed: the request, the job card, the stock level. */
  justification: z.string().trim().min(10),
  quoteRef: z.string().trim().max(60).optional(),
});
export type CreatePurchaseOrderInput = z.infer<
  typeof createPurchaseOrderSchema
>;

export const goodsReceiptSchema = z.object({
  receivedOn: isoDate,
  /** The supplier's delivery note or waybill number. */
  deliveryNote: z.string().trim().min(2).max(60),
  lines: z
    .array(
      z.object({
        lineId: z.uuid(),
        quantity: z.number().positive(),
        /** Bulk product goes into a tank at the receiving site. */
        tankId: z.uuid().optional(),
      }),
    )
    .min(1),
  notes: z.string().trim().max(500).optional(),
});
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>;

/** A supplier's invoice, entered as it is printed, then matched. */
export const supplierBillSchema = z.object({
  purchaseOrderId: z.uuid(),
  vendorInvoiceNo: z.string().trim().toUpperCase().min(2).max(60),
  invoiceDate: isoDate,
  /** The total printed on the invoice, including VAT. */
  statedTotal: z.number().positive(),
  lines: z
    .array(
      z.object({
        lineId: z.uuid(),
        quantity: z.number().positive(),
        unitPrice: z.number().positive(),
      }),
    )
    .min(1),
});
export type SupplierBillInput = z.infer<typeof supplierBillSchema>;

export const billPaidSchema = z.object({
  paymentRef: z.string().trim().toUpperCase().min(4).max(60),
  paidOn: isoDate,
});
export type BillPaidInput = z.infer<typeof billPaidSchema>;

/** Currency units either side of the computed total that still counts as a match (rounding). */
export const BILL_TOTAL_TOLERANCE = 1;
