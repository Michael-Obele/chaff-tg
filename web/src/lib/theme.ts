/**
 * Theme is a class on <html>, applied before first paint by the inline script in
 * app.html so a dark-mode user never sees a white flash.
 */
export type Theme = 'light' | 'dark' | 'system';

const KEY = 'chaff-theme';

export function applyTheme(theme: Theme) {
	const dark =
		theme === 'dark' ||
		(theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.classList.toggle('dark', dark);
	localStorage.setItem(KEY, theme);
}

export function storedTheme(): Theme {
	const raw = localStorage.getItem(KEY);
	return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** Re-apply when the OS flips and the user is on `system`. */
export function watchSystemTheme() {
	const mq = matchMedia('(prefers-color-scheme: dark)');
	const onChange = () => {
		if (storedTheme() === 'system') applyTheme('system');
	};
	mq.addEventListener('change', onChange);
	return () => mq.removeEventListener('change', onChange);
}
