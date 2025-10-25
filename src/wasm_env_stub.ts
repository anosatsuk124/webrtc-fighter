// Stub module for wasm-bindgen's `import 'env'`.
// Provide minimal functions used by the generated wasm to avoid LinkError.
export function now(): number {
	// Return high-resolution time; wasm expects a callable.
	// WebAssembly will coerce to f64 as needed.
	return typeof performance !== "undefined" && performance.now
		? performance.now()
		: Date.now();
}

// Add other env hooks here if needed in the future, e.g. randomness.
// export function random() { return Math.random(); }
