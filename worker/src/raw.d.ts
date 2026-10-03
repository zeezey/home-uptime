// Vite's `?raw` imports: the file's text, inlined at build time (targets.txt stays the one list).
declare module "*?raw" {
	const text: string;
	export default text;
}
