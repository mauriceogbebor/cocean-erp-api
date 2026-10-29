import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { AppRequest } from "./auth-context.js";

/** Tags every request with an id, echoed back and stored on audit events. */
export function requestId(req: AppRequest, res: Response, next: NextFunction) {
  const incoming = req.headers["x-request-id"];
  req.requestId =
    typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
}
