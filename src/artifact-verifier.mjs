import { WorkflowError } from "./workflow-policy.mjs";

const defaultTimeoutMs = 2000;

function artifactUnavailable(details) {
  return new WorkflowError("ARTIFACT_VERIFICATION_UNAVAILABLE", "The artifact verification service is unavailable.", 503, details);
}

function withTimeout(work, timeoutMs, operation) {
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => setTimeout(() => reject(new WorkflowError("ARTIFACT_VERIFICATION_TIMEOUT", "The artifact verification request timed out.", 503, { operation, timeoutMs })), timeoutMs))
  ]);
}

function normalizeOrigins(origins = []) {
  return new Set(origins.map(value => {
    const text = String(value ?? "").trim();
    const url = new URL(text);
    if (url.protocol !== "https:" || url.origin !== text) throw new TypeError("Approved artifact origins must be HTTPS origins.");
    return url.origin;
  }));
}

function normalizeUrl(value) {
  try { return new URL(value); } catch { throw new WorkflowError("INVALID_EVIDENCE_LINK", "Evidence must be a valid approved URL.", 422); }
}

function verificationMetadata(result = {}, origin) {
  return {
    status: "verified",
    verifiedAt: result.verifiedAt || new Date().toISOString(),
    method: result.method || (result.recordValidated ? "record_validation" : "allow_list"),
    origin
  };
}

function normalizeProviderResult(result, origin) {
  if (result === undefined || result === null || result === true) return verificationMetadata({}, origin);
  if (result === false) throw new WorkflowError("ARTIFACT_VERIFICATION_FAILED", "Artifact link could not be verified in the approved system.", 422, { status: "failed", origin });
  if (typeof result !== "object") throw artifactUnavailable({ operation: "verifyRecord" });
  const status = String(result.status ?? "verified").trim();
  if (status !== "verified") {
    throw new WorkflowError("ARTIFACT_VERIFICATION_FAILED", "Artifact link could not be verified in the approved system.", 422, {
      status: "failed",
      origin,
      reasonCode: String(result.reasonCode ?? "record_not_verified").trim()
    });
  }
  return verificationMetadata({ ...result, recordValidated: true }, origin);
}

export class ArtifactVerifier {
  constructor({ approvedOrigins = ["https://intranet.example"], verifyRecord, verifyRecordSync, timeoutMs = defaultTimeoutMs } = {}) {
    this.approvedOrigins = normalizeOrigins(approvedOrigins);
    this.provider = { verifyRecord, verifyRecordSync };
    this.timeoutMs = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 10000) : defaultTimeoutMs;
  }

  validateAllowedUrl(value) {
    const url = normalizeUrl(value);
    if (!this.approvedOrigins.has(url.origin)) {
      throw new WorkflowError("UNAPPROVED_EVIDENCE_LINK", "Evidence must link to an approved internal system.", 422);
    }
    return url;
  }

  async verifyLink(value, context = {}) {
    const url = this.validateAllowedUrl(value);
    if (typeof this.provider.verifyRecord !== "function") return verificationMetadata({}, url.origin);
    try {
      const result = await withTimeout(() => this.provider.verifyRecord({ url, href: url.href, origin: url.origin, context }), this.timeoutMs, "verifyRecord");
      return normalizeProviderResult(result, url.origin);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw artifactUnavailable({ operation: "verifyRecord" });
    }
  }

  verifyLinkSync(value, context = {}) {
    const url = this.validateAllowedUrl(value);
    if (typeof this.provider.verifyRecordSync !== "function") {
      if (typeof this.provider.verifyRecord === "function") throw artifactUnavailable({ operation: "verifyRecord", mode: "sync" });
      return verificationMetadata({}, url.origin);
    }
    try {
      const result = this.provider.verifyRecordSync({ url, href: url.href, origin: url.origin, context });
      if (result && typeof result.then === "function") throw artifactUnavailable({ operation: "verifyRecord", mode: "sync" });
      return normalizeProviderResult(result, url.origin);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw artifactUnavailable({ operation: "verifyRecord" });
    }
  }
}

export function artifactVerificationFields(verification) {
  return {
    artifactVerificationStatus: verification?.status || null,
    artifactVerifiedAt: verification?.verifiedAt || null,
    artifactVerificationMethod: verification?.method || null
  };
}
