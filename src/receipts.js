function createOperationReceipt({
  operation,
  source,
  target,
  createdIds = {},
  counts = {},
  backupPath = null,
  warnings = [],
  details = {},
}) {
  return {
    operation,
    source,
    target,
    createdIds,
    counts,
    backupPath,
    warnings,
    details,
  };
}

module.exports = {
  createOperationReceipt,
};
