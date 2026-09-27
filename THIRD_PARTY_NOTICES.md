# Third-party code

Code copied into this repository from other projects. Each directory keeps the upstream
licence and every file keeps its original copyright header. Carved code is not edited by
hand: `scripts/thirdparty/carve.sh` reproduces it from a pinned upstream commit, rewriting
import paths and applying the patches in `scripts/thirdparty/patches/<project>/`, each of
which fixes an upstream defect and says which and why.

| Directory | Upstream | Commit | Licence | Packages | Used by a binary |
|---|---|---|---|---|---|
| `third_party/tailscale` | https://github.com/tailscale/tailscale (module `tailscale.com`) | `7d96cf5a62efb0c2f7b0414a81a650ab247ee927` | BSD-3-Clause, plus `PATENTS` | `derp`, `derp/derphttp`, `derp/derpserver`, `net/stun`, `disco` and their dependency closure (see `CARVE_MANIFEST.txt`) | **No.** Carved and tested, not yet wired into `cmd/sovereign-node` or `cmd/sovereign-derp-relay`, which use `pkg/derp`. |

## Status

The Tailscale packages were carved to replace the relay and endpoint-discovery code in
`pkg/derp` and `pkg/nat`. That integration has not been done, so today they add code and
tests but no behaviour. CI runs their upstream tests separately from the project's race
suite.

Patches applied to the Tailscale carve:

- `0001-derpserver-test-count-packets-enqueued-after-pong.patch`: the upstream test
  `TestWriterFloodDoesNotStarveControlFrames` measured its bound in sequence numbers,
  which the queue's drop-oldest policy inflates, and failed about one run in ten with
  the writer behaving correctly. The patch measures the same bound in packets.

To refresh the carve against a newer upstream commit:

```sh
sh scripts/thirdparty/carve.sh tailscale <path-to-tailscale-clone> --commit <sha>
```
