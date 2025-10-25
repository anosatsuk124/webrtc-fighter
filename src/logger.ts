// Simple env-driven logger for browser (Vite)
// Usage:
//   import { createLogger } from "./logger";
//   const log = createLogger("main");
//   log.debug("hello", { x: 1 });

type LevelName = "off" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LevelName, number> = {
	off: 99,
	error: 40,
	warn: 30,
	info: 20,
	debug: 10,
};

interface ImportMetaEnv {
	readonly VITE_LOG_LEVEL?: string;
	readonly MODE?: string;
	readonly VITE_LOG_NS?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

function getEnvLevel(): LevelName {
	const raw = (import.meta as ImportMeta).env?.VITE_LOG_LEVEL as
		| string
		| undefined;
	if (!raw) {
		// Default: debug in dev, warn in prod
		const mode = (import.meta as ImportMeta).env?.MODE as string | undefined;
		return mode === "production" ? "warn" : "debug";
	}
	const v = raw.toLowerCase() as LevelName;
	return v in LEVELS ? v : "warn";
}

function getNsFilter(): string[] | null {
	const raw = (import.meta as ImportMeta).env?.VITE_LOG_NS as
		| string
		| undefined;
	if (!raw) return null;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function createLogger(ns: string) {
	const level = getEnvLevel();
	const min = LEVELS[level];
	const nsFilter = getNsFilter();
	const nsAllowed =
		!nsFilter || nsFilter.includes("*") || nsFilter.includes(ns);

	const base =
		(lvl: LevelName) =>
		(...args: unknown[]) => {
			if (!nsAllowed) return;
			if (LEVELS[lvl] < min) return;
			const prefix = `[${new Date().toISOString()}][${ns}]`;
			switch (lvl) {
				case "error":
					console.error(prefix, ...args);
					break;
				case "warn":
					console.warn(prefix, ...args);
					break;
				case "info":
					console.info(prefix, ...args);
					break;
				case "debug":
					console.debug(prefix, ...args);
					break;
				default:
					break;
			}
		};

	return {
		level,
		debug: base("debug"),
		info: base("info"),
		warn: base("warn"),
		error: base("error"),
	};
}
