export const featureFlagDefaults = Object.freeze({
  intake_resubmission: true,
  cycle_administration: true,
  work_tracking_integration: false,
  calendar_integration: false,
  notification_delivery: false
});

export function knownFeatureFlag(key) {
  return Object.hasOwn(featureFlagDefaults, key);
}
