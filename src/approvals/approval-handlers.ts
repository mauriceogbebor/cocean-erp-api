import { Injectable } from "@nestjs/common";
import type { ApprovalKind } from "@cocean/contracts";
import type { Tx } from "../db/client.js";
import type { approvalRequests } from "../db/schema.js";
import type { Actor } from "../common/auth-context.js";

export type DecidedRequest = typeof approvalRequests.$inferSelect;

/**
 * What a decision does to the record it is about. Runs inside the decision's
 * transaction: if the handler fails, the decision is rolled back too, so a
 * decision and its effect can never disagree.
 */
export type ApprovalHandler = (
  tx: Tx,
  request: DecidedRequest,
  actor: Actor,
) => Promise<void>;

@Injectable()
export class ApprovalHandlers {
  private readonly handlers = new Map<ApprovalKind, ApprovalHandler>();

  register(kind: ApprovalKind, handler: ApprovalHandler) {
    if (this.handlers.has(kind))
      throw new Error(`An approval handler for ${kind} is already registered`);
    this.handlers.set(kind, handler);
  }

  /** Kinds with a handler are raised by their own module, never directly. */
  has(kind: ApprovalKind) {
    return this.handlers.has(kind);
  }

  async run(tx: Tx, request: DecidedRequest, actor: Actor) {
    await this.handlers.get(request.kind as ApprovalKind)?.(tx, request, actor);
  }
}
