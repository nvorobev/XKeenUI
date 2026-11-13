# Routing reference fixtures

`routing-reference.json` records JSON outputs observed through the public interface of
https://xray-routing-generator.netlify.app/ on 2026-11-13 (70 input scenarios).
The catalogue contains 90 choices, tested separately for all three actions.

The implementation preserves AND conditions on QUIC/IP rules instead of reproducing
the reference merge bug. It also supports compressed IPv6 and regex quantifiers.
Geo choices are enabled only when the actual installed database contains the category.

`tests/xray-routing-generator-smoke.py` validates the exported 344 cases using real Xray
and the checksum-pinned official database releases in `tests/routing-geo-assets.json`.
Unavailable categories must be rejected by the core, and are reported separately.
