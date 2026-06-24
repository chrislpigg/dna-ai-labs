export const retentionClassification = "program_record";
export const minimumRetentionYears = 7;

export function retentionUntil(from = new Date()) {
  const date = new Date(from);
  date.setUTCFullYear(date.getUTCFullYear() + minimumRetentionYears);
  return date.toISOString();
}

export function retentionExpired(value, reference = new Date()) {
  return !value || new Date(value).getTime() <= new Date(reference).getTime();
}
