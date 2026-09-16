# AI Regression Testing Methodology Reference

Testing patterns specifically designed for AI-assisted development, where the same model writes code and reviews it — creating systematic blind spots that only automated tests can catch.

Key Principles:
1. Automated mechanical tests FIRST — don't trust claims.
2. Probe sandbox/production path discrepancies, edge cases, timing attacks, and boundary states.
3. Test where bugs tend to cluster: auth, cryptographic validation, multi-tenant isolation, state transitions, replay handling, and error handling.
4. Independent test execution with concrete assertions.
