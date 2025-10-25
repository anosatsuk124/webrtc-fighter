import { CAS } from "./cas";
import { type InputMask, KeyboardInput } from "./input";
import { createLogger } from "./logger";
import {
	decChunk,
	decInput,
	decManifest,
	decNeedChunks,
	decScriptPush,
	encChunk,
	encGameStart,
	encInput,
	encManifest,
	encNeedChunks,
	encScriptPush,
	encStateHash,
	type Manifest,
	MSG,
} from "./protocol";
import { hashState, Rollback, type State } from "./rollback";
import { ViewerBJS } from "./viewer_babylon";
import { RhaiVM } from "./vm_rhai";
import {
	createAnswer,
	createOffer,
	createPeer,
	onRemoteDataChannel,
	setLocal,
	setRemote,
} from "./webrtc";

const DEFAULT_JSON_ATLAS = "/assets/brawler-girl-atlas.json";
const DEFAULT_PNG_IMAGE = "/assets/brawler-girl-atlas.png";

// Helper to safely query elements with type checking
function getElement<T extends Element>(
	selector: string,
	type?: new (...args: unknown[]) => T,
): T {
	const el = document.querySelector<T>(selector);
	if (!el) throw new Error(`Element not found: ${selector}`);
	if (type && !(el instanceof type))
		throw new Error(`Element ${selector} is not of expected type`);
	return el;
}

const log = createLogger("main");
const statusEl = getElement("#status");
const localSdp = getElement<HTMLTextAreaElement>("#localSdp");
const remoteSdp = getElement<HTMLTextAreaElement>("#remoteSdp");
const btnOffer = getElement<HTMLButtonElement>("#btnOffer");
const btnAnswer = getElement<HTMLButtonElement>("#btnAnswer");
const btnSetRemote = getElement<HTMLButtonElement>("#btnSetRemote");
const fileGlb = getElement<HTMLInputElement>("#fileGlb");
const filePng = getElement<HTMLInputElement>("#filePng");
const fileAtlas = getElement<HTMLInputElement>("#fileAtlas");
const btnSendAsset = getElement<HTMLButtonElement>("#btnSendAsset");
const btnRunLocal = getElement<HTMLButtonElement>("#btnRunLocal");
const btnSendScript = getElement<HTMLButtonElement>("#btnSendScript");
const btnGameStart = getElement<HTMLButtonElement>("#btnGameStart");
const txtRhai = getElement<HTMLTextAreaElement>("#rhaiSrc");
const canvas = getElement<HTMLCanvasElement>("#view");

const cas = new CAS();
const viewer = new ViewerBJS(canvas);
const keys = new KeyboardInput();
const vmGlobal = new RhaiVM();
await vmGlobal.initOnce();

let vmSrc = txtRhai.value;
vmGlobal.loadSource(vmSrc);

let assetsDC: RTCDataChannel | undefined;
let liveDC: RTCDataChannel | undefined;

// Player role determined by WebRTC connection order
let playerRole: 1 | 2 | undefined;

// Game start gating
let gameStarted = false;
let hasAssetsLoaded = false;
let hasScriptLoaded = false;

const ch = createPeer();
onRemoteDataChannel(ch, (dc) => {
	if (dc.label === "assets") {
		assetsDC = dc;
		mountAssetsDC(dc);
		log.info("assetsDC mounted", { state: dc.readyState });
	}
	if (dc.label === "live") {
		liveDC = dc;
		mountLiveDC(dc);
		log.info("liveDC mounted", { state: dc.readyState });
	}
});

btnOffer.onclick = async () => {
	log.info("Create Offer clicked");
	playerRole = 1; // Offerer is Player 1
	const offer = await createOffer(ch);
	// As the offerer, we created our own data channels. Mount them now.
	if (ch.assets) {
		assetsDC = ch.assets;
		mountAssetsDC(ch.assets);
		ch.assets.onopen = () =>
			log.info("assetsDC open", { state: ch.assets?.readyState });
	}
	if (ch.live) {
		liveDC = ch.live;
		mountLiveDC(ch.live);
		ch.live.onopen = () =>
			log.info("liveDC open", { state: ch.live?.readyState });
	}
	await setLocal(ch, offer);
	ch.pc.onicecandidate = () => {
		if (ch.pc.localDescription)
			localSdp.value = JSON.stringify(ch.pc.localDescription);
	};
	localSdp.value = JSON.stringify(ch.pc.localDescription);
};
btnAnswer.onclick = async () => {
	log.info("Create Answer clicked");
	playerRole = 2; // Answerer is Player 2
	ch.pc.ondatachannel = (e) => {
		if (e.channel.label === "assets") {
			assetsDC = e.channel;
			mountAssetsDC(e.channel);
		}
		if (e.channel.label === "live") {
			liveDC = e.channel;
			mountLiveDC(e.channel);
		}
	};
	await ch.pc.setRemoteDescription(JSON.parse(remoteSdp.value));
	const answer = await createAnswer(ch);
	await setLocal(ch, answer);
	ch.pc.onicecandidate = () => {
		if (ch.pc.localDescription)
			localSdp.value = JSON.stringify(ch.pc.localDescription);
	};
	localSdp.value = JSON.stringify(ch.pc.localDescription);
};
btnSetRemote.onclick = async () => {
	log.info("Set Remote clicked");
	await setRemote(ch, remoteSdp.value);
};

function status(s: string) {
	statusEl.textContent = s;
}

// Asset channel handlers
let lastManifest: Manifest | null = null;

function mountAssetsDC(dc: RTCDataChannel) {
	status("assets open");
	dc.binaryType = "arraybuffer";
	dc.onmessage = async (ev) => {
		const type = new Uint8Array(ev.data)[0];
		if (type === MSG.Manifest) {
			const m = decManifest(ev.data);
			log.info("Manifest received", { id: m.id, type: m.type || "mesh" });
			// Always remember the last manifest so that when chunks arrive we can assemble.
			lastManifest = m;
			const need = m.chunks.filter((c) => !cas.has(c.hash)).map((c) => c.hash);
			if (need.length) dc.send(encNeedChunks(need));
			else {
				await tryAssembleAndLoad(m);
			}
		} else if (type === MSG.NeedChunks) {
			const hashes = decNeedChunks(ev.data);
			log.debug("NeedChunks received", { count: hashes.length });
			await streamChunks(hashes, dc);
		} else if (type === MSG.Chunk) {
			const { hash, data } = decChunk(ev.data);
			cas.put(hash, data);
			status(`chunk ${hash.slice(0, 18)}...`);
			log.debug("Chunk stored", { hash });
			if (lastManifest) await tryAssembleAndLoad(lastManifest);
		} else if (type === MSG.ScriptPush) {
			const { name, bytes } = decScriptPush(ev.data);
			const src = new TextDecoder().decode(bytes);
			vmSrc = src;
			const ok = vmGlobal.loadSource(vmSrc);
			// Reset gameplay VMs next tick by creating new Rollback
			resetRollbackWithScript();
			if (ok) status(`script applied: ${name}`);
			else {
				const err = vmGlobal.getLastError?.() ?? "";
				status(
					err
						? `script compile error: ${err}`
						: `script compile error: ${name}`,
				);
			}
			log.info("Script applied (remote)", { name, ok });
			hasScriptLoaded = ok;
		} else if (type === MSG.GameStart) {
			// Peer requested to start the game. Local sim will start when assets+script are ready.
			gameStarted = true;
			status("game start (remote)");
			log.info("GameStart received from peer");
		}
	};
}

async function tryAssembleAndLoad(m: Manifest) {
	lastManifest = m;
	const type = m.type || "mesh";

	if (type === "sprite") {
		// Sprite: check PNG + Atlas JSON
		const pngChunk = m.chunks.find((c) => c.mime === "image/png");
		const atlasHash = m.meta?.atlas;
		if (!pngChunk || !atlasHash) return;
		if (!cas.has(pngChunk.hash) || !cas.has(atlasHash)) return;
		try {
			await viewer.loadFromManifest(m, cas);
			status("sprite loaded");
			log.info("Sprite loaded", { id: m.id });
			hasAssetsLoaded = true;
		} catch (e) {
			log.error("Sprite load failed", { err: String(e) });
			status("sprite load error");
		}
	} else {
		// Mesh: check entry chunk
		const entry = m.chunks[0];
		if (!cas.has(entry.hash)) return;
		try {
			await viewer.loadFromManifest(m, cas);
			status("mesh loaded");
			log.info("Mesh loaded", { id: m.id });
			hasAssetsLoaded = true;
		} catch (e) {
			log.error("Mesh load failed", { err: String(e) });
			status("mesh load error");
		}
	}
}

async function streamChunks(hashes: string[], dc: RTCDataChannel) {
	for (const h of hashes) {
		const data = cas.get(h);
		if (!data) continue;
		dc.send(encChunk(h, 0, data));
		await waitDrain(dc);
	}
}
function waitDrain(dc: RTCDataChannel) {
	return new Promise<void>((res) => {
		if (dc.bufferedAmount < 1 << 20) return res();
		dc.bufferedAmountLowThreshold = 1 << 20;
		const h = () => {
			if (dc.bufferedAmount < 1 << 20) {
				dc.removeEventListener("bufferedamountlow", h);
				res();
			}
		};
		dc.addEventListener("bufferedamountlow", h);
	});
}

// Helper to get selected asset mode
function getAssetMode(): "3d" | "2d" {
	const radio = document.querySelector<HTMLInputElement>(
		'input[name="assetMode"]:checked',
	);
	return (radio?.value as "3d" | "2d") || "3d";
}

// Send Asset button (handles both 3D and 2D)
btnSendAsset.onclick = async () => {
	await sendSelectedAsset();
};

// Script buttons
btnRunLocal.onclick = () => {
	vmSrc = txtRhai.value;
	const ok = vmGlobal.loadSource(vmSrc);
	resetRollbackWithScript();
	if (ok) {
		status("script loaded (local)");
		log.info("Script loaded (local)");
	} else {
		const err = vmGlobal.getLastError?.() ?? "";
		if (typeof err === "string" && err.length)
			status(`script compile error: ${err}`);
		else status("script compile error");
		log.warn("Script compile error");
	}
	hasScriptLoaded = ok;
};
btnSendScript.onclick = () => {
	const u = new TextEncoder().encode(txtRhai.value);
	if (assetsDC && assetsDC.readyState === "open") {
		assetsDC.send(encScriptPush("logic.rhai", u));
		status("script sent");
		log.info("Script sent to peer");
	} else {
		status("script ready locally");
		log.info("Script prepared locally (no peer)");
	}
};

// Helper to send currently selected asset to peer and also load locally
async function sendSelectedAsset() {
	const dcOpen = assetsDC && assetsDC.readyState === "open";
	const mode = getAssetMode();
	if (mode === "3d") {
		const f = fileGlb.files?.[0];
		if (!f) {
			status("Select GLB");
			return false;
		}
		const ab = await f.arrayBuffer();
		const hash = await cas.hashOf(ab);
		cas.put(hash, new Uint8Array(ab));
		const m: Manifest = {
			id: `char:${f.name}`,
			type: "mesh",
			entry: f.name,
			chunks: [
				{ hash, size: ab.byteLength, mime: f.type || "model/gltf-binary" },
			],
		};
		if (dcOpen) assetsDC?.send(encManifest(m));
		lastManifest = m;
		await tryAssembleAndLoad(m);
		status(dcOpen ? "3D manifest sent" : "3D asset loaded locally");
		log.info("Manifest processed (3D)", { id: m.id, sent: !!dcOpen });
		return true;
	} else {
		let pngFile = filePng.files?.[0];
		let atlasFile = fileAtlas.files?.[0];

		if (!pngFile || !atlasFile) {
			// If no files selected, use default assets
			const pngResp = await fetch(DEFAULT_PNG_IMAGE);
			const atlasResp = await fetch(DEFAULT_JSON_ATLAS);
			pngFile = await pngResp
				.blob()
				.then((b) => new File([b], "default-atlas.png", { type: "image/png" }));
			atlasFile = await atlasResp
				.blob()
				.then(
					(b) =>
						new File([b], "default-atlas.json", { type: "application/json" }),
				);
		}

		if (!pngFile || !atlasFile) return false;
		const pngAb = await pngFile.arrayBuffer();
		const atlasAb = await atlasFile.arrayBuffer();
		const pngHash = await cas.hashOf(pngAb);
		const atlasHash = await cas.hashOf(atlasAb);
		cas.put(pngHash, new Uint8Array(pngAb));
		cas.put(atlasHash, new Uint8Array(atlasAb));
		const m: Manifest = {
			id: `char:sprite:${pngFile.name}`,
			type: "sprite",
			entry: pngFile.name,
			chunks: [
				{ hash: pngHash, size: pngAb.byteLength, mime: "image/png" },
				{ hash: atlasHash, size: atlasAb.byteLength, mime: "application/json" },
			],
			meta: { atlas: atlasHash },
		};
		if (dcOpen) assetsDC?.send(encManifest(m));
		lastManifest = m;
		await tryAssembleAndLoad(m);
		status(dcOpen ? "2D sprite manifest sent" : "2D sprite loaded locally");
		log.info("Manifest processed (2D)", { id: m.id, sent: !!dcOpen });
		return true;
	}
}

// Game Start: send asset + script, then arm simulation locally
btnGameStart.onclick = async () => {
	log.info("Game Start clicked");
	const ok = await sendSelectedAsset();
	if (!ok) return;
	// Send script to peer and apply locally
	vmSrc = txtRhai.value;
	const okScript = vmGlobal.loadSource(vmSrc);
	resetRollbackWithScript();
	hasScriptLoaded = okScript;
	const u = new TextEncoder().encode(vmSrc);
	if (assetsDC && assetsDC.readyState === "open") {
		assetsDC.send(encScriptPush("logic.rhai", u));
		// Notify peer to begin simulation once their assets/script are ready
		try {
			assetsDC.send(encGameStart());
		} catch {}
		status("game start armed");
	} else {
		status("game start (local)");
	}
	gameStarted = true;
	log.info("Game Start armed");
};

// Live channel + rollback
let rb = makeRollback();

function makeRollback(): Rollback {
	const seed: State = {
		frame: 0,
		// Spawn near the origin so camera frames both actors
		p1: { x: -1 << 16, vx: 0, hp: 100, anim: 0 },
		p2: { x: 1 << 16, vx: 0, hp: 100, anim: 0 },
	};
	// VM factory: independent instances with same script
	const vmFactory = () => {
		const v = vmGlobal.clone();
		v.loadSource(vmSrc);
		return v;
	};
	return new Rollback(seed, vmFactory, playerRole ?? 1);
}
function resetRollbackWithScript() {
	rb = makeRollback();
}

let _lastRemoteAck = 0;
let _lastSentLocalFrame = 0;
function mountLiveDC(dc: RTCDataChannel) {
	status("live open");
	dc.binaryType = "arraybuffer";
	dc.onmessage = (ev) => {
		const u8 = new Uint8Array(ev.data);
		const t = u8[0];
		if (t === MSG.Input) {
			const { frame, mask, ack } = decInput(ev.data);
			rb.setRemoteInput(frame, mask);
			if (frame <= rb.getLatest().frame) rb.rollbackFrom(frame);
			_lastRemoteAck = ack;
			// Log only when input mask is non-zero; emit sparse heartbeat otherwise
			if (mask !== 0) {
				log.debug("Input received", { frame, ack, mask });
			} else if ((frame & 0x3f) === 0) {
				// heartbeat every 64 frames (~1s) to show liveness without noise
				log.debug("Input heartbeat", { frame, ack, mask });
			}
		} else if (t === MSG.StateHash) {
			// Desync handling could be added here
		}
	};
}

// Game loop: fixed 60Hz by accumulation
const TICK = 1 / 60;
let acc = 0;
let last = performance.now();
function loop(now: number) {
	acc += (now - last) / 1000;
	last = now;
	while (acc >= TICK) {
		// Wait until Game Start and assets+script loaded. Live channel optional (offline OK)
		if (!(gameStarted && hasAssetsLoaded && hasScriptLoaded)) {
			acc = 0; // avoid runaway accumulation while waiting
			break;
		}
		const next = (rb.getLatest().frame + 1) & 0xffff;
		const local = keys.snapshot();
		rb.setLocalInput(next, local);
		// Send input only if live channel is open
		if (liveDC && liveDC.readyState === "open") sendInput(next, local);
		const s = rb.simulateTo(next);
		// Apply to viewer with animation hashes
		viewer.applyState(s.p1.x, s.p2.x, s.p1.anim, s.p2.anim);
		// Lightweight debug pulse: show frame/mask/pos every ~1s
		if ((s.frame & 0x3f) === 0) {
			status(`f=${s.frame} m=${local} x=${(s.p1.x / (1 << 16)).toFixed(2)}`);
		}
		if ((s.frame & 0xf) === 0 && liveDC?.readyState === "open") {
			const h = hashState(s);
			liveDC.send(encStateHash(s.frame, h));
		}
		acc -= TICK;
	}
	requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function sendInput(frame: number, mask: InputMask) {
	if (!liveDC || liveDC.readyState !== "open") return;
	const ack = rb.getLatest().frame & 0xffff;
	_lastSentLocalFrame = frame;
	liveDC.send(encInput(frame, mask, ack));
}

// Expose connection states
ch.pc.oniceconnectionstatechange = () =>
	status(`ice: ${ch.pc.iceConnectionState}`);
ch.pc.onconnectionstatechange = () => status(`pc: ${ch.pc.connectionState}`);
ch.pc.oniceconnectionstatechange = () => {
	log.info("ice state", { state: ch.pc.iceConnectionState });
};
ch.pc.onconnectionstatechange = () => {
	log.info("pc state", { state: ch.pc.connectionState });
};
