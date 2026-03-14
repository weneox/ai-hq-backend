// src/config/featureReport.js

import { getProviderState, getFeatureFlags } from "./features.js";

export function printFeatureReport(logger = console) {
  const providers = getProviderState();
  const features = getFeatureFlags();

  logger.log("[features] providers:");
  logger.log(JSON.stringify(providers, null, 2));

  logger.log("[features] flags:");
  logger.log(JSON.stringify(features, null, 2));

  return {
    providers,
    features,
  };
}