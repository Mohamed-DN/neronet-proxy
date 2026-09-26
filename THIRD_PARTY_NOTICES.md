# Third-party code

Code copied into this repository from other projects. Each directory keeps the upstream
licence and every file keeps its original copyright header. Carved code is not edited by
hand: `scripts/thirdparty/carve.sh` reproduces it from a pinned upstream commit, rewriting
only import paths.

| Directory | Upstream | Commit | Licence | Packages | Used by a binary |
|---|---|---|---|---|---|
| `third_party/tailscale` | https://github.com/tailscale/tailscale (module `tailscale.com`) | `7d96cf5a62efb0c2f7b0414a81a650ab247ee927` | BSD-3-Clause, plus `PATENTS` | `derp`, `derp/derphttp`, `derp/derpserver`, `net/stun`, `disco` and their dependency closure (see `CARVE_MANIFEST.txt`) | **No.** Carved and tested, not yet wired into `cmd/sovereign-node` or `cmd/sovereign-derp-relay`, which use `pkg/derp`. |

## Status

The Tailscale packages were carved to replace the relay and endpoint-discovery code in
`pkg/derp` and `pkg/nat`. That integration has not been done, so today they add code and
tests but no behaviour. CI runs their upstream tests separately from the project's race
suite, because several DERP tests assert on write ordering and are sensitive to a loaded
runner.

To refresh the carve against a newer upstream commit:

```sh
sh scripts/thirdparty/carve.sh tailscale <path-to-tailscale-clone> --commit <sha>
```
