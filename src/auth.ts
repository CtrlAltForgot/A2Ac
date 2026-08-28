import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Identity } from "./types.js";

type Credential = Identity & { digest: Buffer };

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function loadCredentials(raw = process.env.A2AC_IDENTITIES ?? "owner:change-me:human") {
  const credentials: Credential[] = [];
  for (const entry of raw.split(",")) {
    const [name, key, role = "agent"] = entry.trim().split(":");
    if (!name || !key || !["human", "agent", "admin"].includes(role)) continue;
    credentials.push({ name, role: role as Identity["role"], digest: digest(key) });
  }
  if (!credentials.length) throw new Error("A2AC_IDENTITIES contains no valid identities");
  return credentials;
}

function presentedKey(req: Request) {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.header("x-api-key")?.trim() ?? "";
}

export function identify(req: Request, credentials: Credential[]): Identity | undefined {
  return identifyKey(presentedKey(req), credentials);
}

export function identifyKey(key: string, credentials: Credential[]): Identity | undefined {
  const candidate = digest(key);
  const match = credentials.find((item) => timingSafeEqual(item.digest, candidate));
  return match && { name: match.name, role: match.role };
}

declare global {
  namespace Express {
    interface Request { identity?: Identity }
  }
}

export function authMiddleware(credentials: Credential[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const identity = identify(req, credentials);
    if (!identity) return res.status(401).json({ error: "A valid Bearer token or x-api-key is required" });
    req.identity = identity;
    next();
  };
}
