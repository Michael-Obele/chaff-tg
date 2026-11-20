/**
 * The browser trace for everything Telegram — the one file in `web/` allowed to
 * print. `TG_TRACE=off` silences it; `verbose` or `?tgdebug` raises mtcute to
 * VERBOSE. Switches are documented in `docs/telegram-setup.md`.
 */

const PREFIX = '[tg]';
const BUFFER_MAX = 600;

/** mtcute's numeric levels, in its own order (`LogManager`). */
const LEVEL_NAMES = ['off', 'error', 'warn', 'info', 'debug', 'verbose'] as const;

const LEVEL_STYLES = [
	'',
	'color:#d32f2f;font-weight:bold',
	'color:#b26a00',
	'color:#1e6fb8',
	'color:#2e7d32',
	'color:#7a5f9d'
];

let started = now();
let seq = 0;
const buffer: string[] = [];

function now(): number {
	return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function clock(): string {
	return `${((now() - started) / 1000).toFixed(3)}s`;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		// Storage throws in a sandboxed iframe.
		return null;
	}
}

export function traceEnabled(): boolean {
	const value = storage()?.getItem('TG_TRACE');
	return value !== 'off' && value !== '0';
}

export function traceVerbose(): boolean {
	const value = storage()?.getItem('TG_TRACE');
	if (value === 'verbose') return true;
	try {
		return typeof location !== 'undefined' && new URL(location.href).searchParams.has('tgdebug');
	} catch {
		return false;
	}
}

function record(line: string): void {
	buffer.push(line);
	if (buffer.length > BUFFER_MAX) buffer.shift();
}

function printable(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return String(value);
		return text.length > 600 ? `${text.slice(0, 600)}…` : text;
	} catch {
		// Cycles, getters that throw, DOM nodes.
		return Object.prototype.toString.call(value);
	}
}

/** `util.format`-style substitution: mtcute's `%s` formats stay readable. */
function format(fmt: string, args: unknown[]): string {
	let index = 0;
	const head = String(fmt).replace(/%[sdifoOjc%]/g, (match) =>
		match === '%%' ? '%' : index < args.length ? printable(args[index++]) : match
	);
	const rest = args.slice(index).map(printable);
	return [head, ...rest].join(' ').trim();
}

/** `data` is logged as an object so DevTools keeps it expandable. */
export function step(scope: string, message: string, data?: unknown): void {
	seq += 1;
	const line = `${PREFIX} #${seq} ${clock()} ${scope} › ${message}`;
	record(data === undefined ? line : `${line} ${printable(data)}`);
	if (!traceEnabled()) return;
	if (data === undefined) console.log(`%c${line}`, 'color:#2e7d32');
	else console.log(`%c${line}`, 'color:#2e7d32', data);
}

export function info(scope: string, message: string, data?: unknown): void {
	seq += 1;
	const line = `${PREFIX} #${seq} ${clock()} ${scope} › ${message}`;
	record(data === undefined ? line : `${line} ${printable(data)}`);
	if (!traceEnabled()) return;
	if (data === undefined) console.log(`%c${line}`, 'color:#1e6fb8');
	else console.log(`%c${line}`, 'color:#1e6fb8', data);
}

export function warn(scope: string, message: string, data?: unknown): void {
	seq += 1;
	const line = `${PREFIX} #${seq} ${clock()} ${scope} › ${message}`;
	record(data === undefined ? line : `${line} ${printable(data)}`);
	if (!traceEnabled()) return;
	if (data === undefined) console.log(`%c${line}`, 'color:#b26a00;font-weight:bold');
	else console.log(`%c${line}`, 'color:#b26a00;font-weight:bold', data);
}

export function failure(scope: string, message: string, error?: unknown): void {
	seq += 1;
	const detail =
		error instanceof Error
			? `${error.name}: ${error.message}`
			: error === undefined
				? ''
				: printable(error);
	const line = `${PREFIX} #${seq} ${clock()} ${scope} › FAILED ${message}${detail ? ` — ${detail}` : ''}`;
	record(line);
	if (!traceEnabled()) return;
	console.log(`%c${line}`, 'color:#d32f2f;font-weight:bold', error);
}

/** The whole trace as plain lines — for `copy(window.__tg.lines())`. */
export function lines(): string[] {
	return [...buffer];
}

export function clear(): void {
	buffer.length = 0;
	seq = 0;
	started = now();
}

/**
 * Take mtcute's logger over: one `[tg]` prefix, and `?tgdebug` can raise its
 * level to VERBOSE without patching the library.
 */
export function attachClientLogs(client: unknown, label: string): void {
	const mgr = (client as { log?: { mgr?: Record<string, unknown> } } | null)?.log?.mgr;
	if (!mgr || typeof mgr !== 'object') {
		warn(label, 'client exposes no `log.mgr`; mtcute lines stay on the platform handler');
		return;
	}

	const verbose = traceVerbose();
	mgr['level'] = verbose ? 5 : 3;
	const previous = mgr['handler'];
	const fallback = typeof previous === 'function' ? (previous as (...a: unknown[]) => void) : null;

	mgr['handler'] = (color: number, level: number, tag: string, fmt: string, args: unknown[]) => {
		const name = LEVEL_NAMES[level] ?? String(level);
		const text = format(fmt, args);
		record(`${PREFIX} mtcute ${label} ${name} [${tag}] ${text}`);
		if (!traceEnabled()) {
			fallback?.(color, level, tag, fmt, args);
			return;
		}
		console.log(`%c${PREFIX} mtcute ${name} [${tag}] ${text}`, LEVEL_STYLES[level] ?? '');
	};

	info(label, `mtcute logging at ${LEVEL_NAMES[mgr['level'] as number]}${verbose ? ' (verbose)' : ''}`);
}

/** `+234••••••098` — enough to recognise the account, not enough to leak it. */
export function maskPhone(phone: string): string {
	const digits = phone.replace(/\s+/g, '');
	if (digits.length <= 6) return '•'.repeat(digits.length || 1);
	return `${digits.slice(0, 4)}${'•'.repeat(Math.max(3, digits.length - 7))}${digits.slice(-3)}`;
}

/** A hash is reported by length: a prefix is still a hint worth withholding. */
export function hashHint(hash: string): string {
	return hash ? `len=${hash.length}` : 'empty';
}

export function maskSecret(value: string): string {
	return '•'.repeat(Math.min(Math.max(value.length, 4), 12));
}

/**
 * The two hooks stay because an unawaited transport failure otherwise leaves
 * the UI on "Connecting…" with nothing in the console.
 */
export function installTrace(): void {
	if (typeof window === 'undefined') return;

	(window as unknown as Record<string, unknown>)['__tg'] = {
		lines,
		clear,
		verbose: () => storage()?.setItem('TG_TRACE', 'verbose'),
		quiet: () => storage()?.setItem('TG_TRACE', 'off'),
		loud: () => storage()?.removeItem('TG_TRACE')
	};

	window.addEventListener('unhandledrejection', (event) => {
		failure('window', 'unhandled promise rejection', event.reason);
	});
	window.addEventListener('error', (event) => {
		const errorEvent = event as ErrorEvent;
		failure('window', 'uncaught error', errorEvent.error ?? errorEvent.message);
	});

	step('boot', 'trace installed — window.__tg.lines() returns this log', {
		verbose: traceVerbose(),
		enabled: traceEnabled()
	});
}

/**
 * `crypto.subtle` needs a secure context, so a LAN IP over plain `http` fails
 * here and looks like a code bug.
 */
export function diagnose(): void {
	const env = globalThis as {
		isSecureContext?: boolean;
		crypto?: { subtle?: unknown };
		indexedDB?: unknown;
		navigator?: { onLine?: boolean };
	};

	step('env', 'browser capabilities', {
		url: typeof location === 'undefined' ? 'n/a' : location.origin,
		secureContext: env.isSecureContext ?? false,
		webCrypto: Boolean(env.crypto?.subtle),
		indexedDb: typeof env.indexedDB !== 'undefined',
		online: env.navigator?.onLine ?? null,
		worker: typeof Worker !== 'undefined'
	});

	if (env.crypto?.subtle === undefined) {
		warn(
			'env',
			'crypto.subtle is missing — @mtcute/web cannot build keys. ' +
				'Open the app over https:// or http://localhost, not a LAN IP.'
		);
	}
	if (env.indexedDB === undefined) {
		warn('env', 'indexedDB is missing — there is nowhere to keep the session between visits.');
	}
}
