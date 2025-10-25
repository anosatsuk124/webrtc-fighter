# CLAUDE.md

## Project Overview

Run a browser-only 2D fighter stack: Babylon.js rendering, two WebRTC DataChannels, chunked glTF delivery, Rhai-in-WASM character logic, input-only sync with rollback.

## Development Commands

*To be added as the project structure is established*


## Architecture

```
Peer A <—SDP—> Peer B
  ├─ DataChannel "assets"  reliable, ordered  (glTF, scripts, manifest)
  └─ DataChannel "live"    unordered, no-retransmit (inputs, state hashes)

App
  ├─ Viewer (Babylon.js)  ← applies latest State
  ├─ Rollback engine      ← deterministic step, Rhai VM x2
  ├─ Rhai VM (WASM)       → returns command list ["move","anim"]
  ├─ CAS (sha256)         → chunk store
  └─ Protocol             → binary messages for assets/live
```

## Protocol summary

Assets:

* `0x01 Manifest`: JSON `{ id, entry, chunks:[{hash,size,mime}] }`
* `0x02 NeedChunks`: list of missing hashes
* `0x03 Chunk`: `[hashLen+hash][offset:u32][payload]` (sample sends as one full chunk)
* `0x20 ScriptPush`: `[nameLen+name][len:u32][rhaiSourceBytes]`

Live:

* `0x10 Input`: `[frame:u16][mask:u16][ack:u16]`
* `0x11 StateHash`: `[frame:u16][xxh32:u32]` (optional now)

## Execution flow

1. Connect via manual SDP exchange.
2. GLB delivery over `assets` using CAS keys. Receiver assembles and loads into Babylon.
3. Rhai script load locally or push to peer.
4. Game loop 60 Hz:

   * Sample local input. Send `Input`.
   * Simulate to next frame with predicted remote input.
   * Apply latest State to viewer.
   * Periodically send `StateHash`.

## Determinism rules

* Use 16.16 fixed-point only.
* Rhai scripts produce commands only. No Date, no randomness, no I/O.
* Fixed processing order: P1, then P2.
* Same script + same inputs → same State.

## Implementation strategy

* Input-only networking. Never send full state.
* `live` is loss-tolerant. Prediction hides loss. Rollback fixes late frames.
* Keep at least 64 snapshots. Tune to `ceil(RTT99 / 16.7 ms) + margin`.
* Apply script changes at frame boundaries by reinitializing the rollback VMs.
* Keep rendering passive. Viewer just reflects State.

## Testing

* Determinism: feed a recorded input trace to both peers. Compare `hashState` each N frames.
* Rollback load: inject 5–20% artificial loss and jitter. Record recompute counts and time.
* Backpressure: verify `bufferedAmountLowThreshold` behavior on large assets.
* Script API: freeze the public Rhai API. Add by extension only.

## Key Patterns and Conventions

- Use English for all code comments and documentation.
- Run `bun format` `bun lint` and `bun build` after any code changes.
