export class CAS {
	private map = new Map<string, Uint8Array>();
	put(hash: string, data: Uint8Array) {
		this.map.set(hash, data);
	}
	has(hash: string) {
		return this.map.has(hash);
	}
	get(hash: string) {
		return this.map.get(hash);
	}
	async hashOf(data: ArrayBuffer): Promise<string> {
		const d = await crypto.subtle.digest("SHA-256", data);
		const hex = Array.from(new Uint8Array(d))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return `sha256:${hex}`;
	}
}
