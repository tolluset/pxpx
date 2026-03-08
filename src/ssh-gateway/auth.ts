import { createHash } from "node:crypto";
import { utils, type ParsedKey, type PublicKeyAuthContext } from "ssh2";
import type { AuthIdentity } from "./types";

export function getPublicKeyFingerprint(publicKey: Buffer) {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function parsePresentedPublicKey(context: PublicKeyAuthContext) {
  const parsedKey = utils.parseKey(context.key.data);

  if (parsedKey instanceof Error) {
    return null;
  }

  return parsedKey as ParsedKey;
}

export function verifyPublicKey(context: PublicKeyAuthContext, parsedKey: ParsedKey) {
  if (!context.signature || !context.blob) {
    return true;
  }

  return parsedKey.verify(context.blob, context.signature, context.hashAlgo) === true;
}

export function buildIdentity(context: PublicKeyAuthContext): AuthIdentity {
  return {
    fingerprint: getPublicKeyFingerprint(context.key.data),
    sshUsername: context.username,
  };
}
