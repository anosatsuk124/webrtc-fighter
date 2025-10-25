# AGENTS.md

## Project Overview

Run a browser-only 2D fighter stack: Babylon.js rendering, two WebRTC DataChannels, chunked glTF delivery, Rhai-in-WASM character logic, input-only sync with rollback.

## Development Commands

* `bun run dev` - Start development server
* `bun run build` - Build both WASM and JS
* `bun run lint` - Run linter
* `bun run format` - Format code
* `./scripts/build_sprite_atlas.sh` - Generate sprite atlas from spritesheets (requires ImageMagick)


## Architecture

```
Peer A <—SDP—> Peer B
  ├─ DataChannel "assets"  reliable, ordered  (glTF, scripts, manifest)
  └─ DataChannel "live"    unordered, no-retransmit (inputs, state hashes)

App
  ├─ Viewer (Babylon.js)  ← applies latest State
  │   ├─ ActorRenderer (abstract)
  │   │   ├─ MeshActorRenderer (GLB + ArcRotateCamera)
  │   │   └─ SpriteActorRenderer (PNG Atlas + OrthographicCamera)
  ├─ Rollback engine      ← deterministic step, Rhai VM x2
  ├─ Rhai VM (WASM)       → returns command list ["move","anim"]
  ├─ CAS (sha256)         → chunk store
  └─ Protocol             → binary messages for assets/live
```

## Protocol summary

Assets:

* `0x01 Manifest`: JSON for mesh `{ id, entry, chunks:[{hash,size,mime}] }` or for sprite `{ id, type:"sprite", entry, chunks:[{hash,size,mime}], meta:{atlas:"sha256:..."} }`
* `0x02 NeedChunks`: list of missing hashes
* `0x03 Chunk`: `[hashLen+hash][offset:u32][payload]` (sample sends as one full chunk)
* `0x20 ScriptPush`: `[nameLen+name][len:u32][rhaiSourceBytes]`

Sprite Atlas JSON format:
```json
{
  "cellWidth": 48,
  "cellHeight": 64,
  "anims": {
    "Idle": {"from":0, "to":7, "fps":8, "loop":true},
    "Walk": {"from":8, "to":27, "fps":12, "loop":true},
    "Punch": {"from":28, "to":33, "fps":10, "loop":false}
  }
}
```

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

## Rhai Script API

Scripts implement `fn tick(frame, input_mask)` called at 60Hz.

**Available functions:**
* `move(dx)` - Issue move command (dx: -1=left, 0=stop, 1=right)
* `anim_play(name)` - Play animation ("Idle", "Walk", "Punch", "Kick", "Jump", etc.)

**Input mask constants:**
* `UP = 1`, `DOWN = 2`, `LEFT = 4`, `RIGHT = 8`
* `LP = 16` (Light Punch, A key)
* `HP = 32` (Heavy Punch, S key)
* `LK = 64` (Light Kick, Z key)
* `HK = 128` (Heavy Kick, X key)
* `START = 256` (Enter key)

**Check input:** `if (input_mask & LEFT) != 0 { ... }`

**State persistence:** Use global variables - they persist across ticks via Rhai Scope.

**Example:** See `public/scripts/sample_fighter.rhai`

## Implementation strategy

* Input-only networking. Never send full state.
* `live` is loss-tolerant. Prediction hides loss. Rollback fixes late frames.
* Keep at least 64 snapshots. Tune to `ceil(RTT99 / 16.7 ms) + margin`.
* Apply script changes at frame boundaries by reinitializing the rollback VMs.
* Keep rendering passive. Viewer just reflects State.

## Rendering: Dual System (Mesh vs Sprite)

* **ActorRenderer** abstraction: `{ load(...):Promise<void>; applyState(x, anim?):void }`
  * `MeshActorRenderer` - existing GLB workflow
  * `SpriteActorRenderer` - PNG + Atlas JSON
* **Camera switching**:
  * 3D: `ArcRotateCamera`
  * 2D: `FreeCamera` with `ORTHOGRAPHIC_CAMERA` mode
* **Sprite settings** for pixel-perfect:
  * Sampling: `Texture.NEAREST_SAMPLINGMODE`
  * Mipmaps: `false`
  * Wrap: `CLAMP_ADDRESSMODE`
  * Pixel snap: `Math.round(pos * pxPerUnit) / pxPerUnit`
* **Animation mapping**: `anim_play("Walk")` in Rhai → 3D uses AnimationGroup name, 2D uses Atlas frame range
* **State compatibility**: same State (x, anim) shared between 3D and 2D. Only rendering differs.

## Testing

* Determinism: feed a recorded input trace to both peers. Compare `hashState` each N frames.
* Rollback load: inject 5–20% artificial loss and jitter. Record recompute counts and time.
* Backpressure: verify `bufferedAmountLowThreshold` behavior on large assets.
* Script API: freeze the public Rhai API. Add by extension only.

## Key Patterns and Conventions

- Use English for all code comments and documentation.
- Run `bun run format` `bun run lint (bun run fix)` and `bun run build` after any code changes.
