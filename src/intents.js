function normalizeWriteIntent(intent, options = {}) {
  const normalizedIntent = intent || "transcript-only-conversion";
  return {
    type: normalizedIntent,
    title: options.title || null,
    projectId: options.projectId || options.newProjectId || null,
    workspaceRoot: options.workspaceRoot || null,
    provider: options.newProvider || options.provider || null,
    model: options.newModel || options.model || null,
    modelSelection: options.newModelSelection || options.modelSelection || null,
    copyRuntime: options.copyRuntime === true,
    preserveTimestamps: options.preserveTimestamps !== false,
    allowLossyConversion: options.allowLossyConversion === true,
  };
}

module.exports = {
  normalizeWriteIntent,
};
