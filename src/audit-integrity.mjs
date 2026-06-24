import { createHash } from "node:crypto";

export const auditGenesisHash = "0".repeat(64);

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

export function auditEventHash({ auditSequence, previousHash, actorId, action, entityType, entityId, before, after, createdAt }) {
  return createHash("sha256").update(stable({ auditSequence, previousHash, actorId, action, entityType, entityId, before, after, createdAt })).digest("hex");
}

export function verifyAuditChain(events) {
  let previousHash = auditGenesisHash;
  let expectedSequence = 1;
  for (const event of events) {
    if (event.auditSequence !== expectedSequence || event.previousHash !== previousHash) return { valid: false, checked: expectedSequence - 1, issue: "audit_sequence_gap" };
    const calculated = auditEventHash(event);
    if (event.eventHash !== calculated) return { valid: false, checked: expectedSequence - 1, issue: "audit_hash_mismatch" };
    previousHash = event.eventHash;
    expectedSequence += 1;
  }
  return { valid: true, checked: events.length, issue: null };
}
