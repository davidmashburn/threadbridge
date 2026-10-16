# Stock T3 acceptance tests

Use a disposable source checkout of https://github.com/pingdotgg/t3code at `81493efb71e8e8244f95d3e9f71d8369654ab151` (v0.1.0), with its dependencies installed using the repository's documented setup. Do not point this at a working checkout with local changes.

```sh
T3_STOCK_ROOT=/absolute/path/to/stock-t3 npm run test:stock-t3
```

The runner checks hashes of the reference contracts, attachment resolver, projection services and provider-test helper. It creates disposable databases, invokes the actual Threadbridge writer, decodes project/thread events with stock services, resolves copied image/file attachments, and compares complete canonical projections before and after a stock rebuild. It then runs a simulated provider continuation through the stock orchestrator, including a negative control without the imported-history marker.

Temporary TypeScript probe/test files are created in the stock checkout so its own dependency resolver and test configuration apply. They are removed on exit. The stock provider-switch test supplies its own adapter helper at runtime; no copied helper implementation is vendored. Test databases and logs remain in the printed temporary artifact directory for inspection. This suite does not contact a real provider or modify user databases.
