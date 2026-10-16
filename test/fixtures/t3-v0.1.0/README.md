# T3 v0.1.0 fixtures

Reference: https://github.com/pingdotgg/t3code/tree/81493efb71e8e8244f95d3e9f71d8369654ab151 (MIT licensed).

`schema.sql` is the schema emitted by that stock release's SQLite migrations, plus migration bookkeeping and empty projection metadata. Fixture timestamps are fixed. It contains no user data. `events.json` is a synthetic portable thread and two fork-related threads. `projections.json` is their canonical output from the stock projection service after rebuilding from those events. The fixture checks ordinal ordering with tied timestamps, plan preservation and fork cutoffs.

The profile in `src/adapters/t3/profile-v2.json` records `PRAGMA table_info` from this migrated schema. Compatibility changes must be checked against stock contracts and rebuild behavior, not only against these static fixtures; see `test/stock-t3/README.md`.
