import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, extname, join, resolve } from "path";
import { BUILD_INFO, type BuildInfo, formatBuildTag, VERSION } from "../config.ts";
import { spawnProcessSync } from "../utils/child-process.ts";
import type { Extension } from "./extensions/types.ts";
import type { PackageSource } from "./settings-manager.ts";

export interface PluginVersionEntry {
	name: string;
	path: string;
	displayPath: string;
	scope: string;
	origin: string;
	source: string;
	packageName?: string;
	packageVersion?: string;
	declaredVersion?: string;
	gitCommit?: string;
	gitDirty?: boolean;
	sha256?: string;
	mtimeUtc?: string;
}

export interface PackageVersionEntry {
	spec: string;
	scope: "global" | "project";
	installedName?: string;
	installedVersion?: string;
	resolvedDir?: string;
}

export interface VersionInfoReport {
	version: string;
	buildTag: string;
	buildInfo: BuildInfo;
	entryPath: string;
	nodeVersion: string;
	plugins: PluginVersionEntry[];
	pluginErrors: Array<{ path: string; error: string }>;
	packages: PackageVersionEntry[];
	counts: {
		skills: number;
		themes: number;
		prompts: number;
	};
}

export interface CollectVersionInfoInput {
	version?: string;
	buildInfo?: BuildInfo;
	entryPath?: string;
	agentDir: string;
	cwd: string;
	extensions: ReadonlyArray<Pick<Extension, "path" | "resolvedPath" | "hidden" | "sourceInfo">>;
	extensionErrors?: ReadonlyArray<{ path: string; error: string }>;
	globalPackages?: ReadonlyArray<PackageSource>;
	projectPackages?: ReadonlyArray<PackageSource>;
	skillCount?: number;
	themeCount?: number;
	promptCount?: number;
}

function shortenHome(p: string): string {
	const home = homedir();
	if (home && (p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`))) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function formatUtcTimestamp(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	return `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** Look for an explicit version annotation in the leading 40 lines of a plugin file. */
export function extractDeclaredVersion(content: string): string | undefined {
	const head = content.split(/\r?\n/, 40).join("\n");
	const commentMatch = head.match(
		/(?:^|\n)\s*(?:\/\/|\/?\*+)\s*@?version\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9._+-]{0,63})/i,
	);
	if (commentMatch) return commentMatch[1];
	const exportMatch = head.match(
		/(?:^|\n)\s*export\s+const\s+(?:VERSION|PLUGIN_VERSION|EXTENSION_VERSION)\s*=\s*["']([^"']{1,64})["']/,
	);
	if (exportMatch) return exportMatch[1];
	return undefined;
}

function findNearestPackageJson(startFile: string, stopDir?: string): { name?: string; version?: string } | undefined {
	let dir = dirname(resolve(startFile));
	const limit = stopDir ? resolve(stopDir) : undefined;
	const home = homedir();
	for (let depth = 0; depth < 8; depth++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown; version?: unknown };
				const name = typeof raw.name === "string" ? raw.name : undefined;
				const version = typeof raw.version === "string" ? raw.version : undefined;
				if (name || version) return { name, version };
			} catch {
				// Ignore unreadable package.json
			}
		}
		if (limit && dir === limit) break;
		if (dir === home) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function probeGitStatusForFile(filePath: string): { commit: string; dirty: boolean } | undefined {
	try {
		const dir = dirname(filePath);
		const tracked = spawnProcessSync("git", ["ls-files", "--error-unmatch", "--", filePath], {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1500,
		});
		if (tracked.status !== 0) return undefined;
		const rev = spawnProcessSync("git", ["rev-parse", "--short=7", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1500,
		});
		const commit = rev.status === 0 ? rev.stdout.trim() : "";
		if (!commit) return undefined;
		const diff = spawnProcessSync("git", ["status", "--porcelain", "--", filePath], {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1500,
		});
		const dirty = diff.status === 0 && diff.stdout.trim().length > 0;
		return { commit, dirty };
	} catch {
		return undefined;
	}
}

function packageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function stripNpmSpecVersion(spec: string): string {
	const raw = spec.startsWith("npm:") ? spec.slice(4) : spec;
	if (raw.startsWith("@")) {
		const slash = raw.indexOf("/");
		if (slash === -1) return raw;
		const at = raw.indexOf("@", slash + 1);
		return at === -1 ? raw : raw.slice(0, at);
	}
	const at = raw.indexOf("@");
	return at === -1 ? raw : raw.slice(0, at);
}

function inspectPackage(
	pkg: PackageSource,
	scope: "global" | "project",
	agentDir: string,
	cwd: string,
): PackageVersionEntry {
	const spec = packageSourceString(pkg);
	const entry: PackageVersionEntry = { spec, scope };
	const roots =
		scope === "global" ? [join(agentDir, "npm", "node_modules")] : [join(cwd, ".pi", "npm", "node_modules")];

	if (spec.startsWith("npm:")) {
		const pkgName = stripNpmSpecVersion(spec);
		for (const root of roots) {
			const pkgJson = join(root, ...pkgName.split("/"), "package.json");
			if (existsSync(pkgJson)) {
				try {
					const raw = JSON.parse(readFileSync(pkgJson, "utf-8")) as { name?: unknown; version?: unknown };
					entry.installedName = typeof raw.name === "string" ? raw.name : pkgName;
					entry.installedVersion = typeof raw.version === "string" ? raw.version : undefined;
					entry.resolvedDir = shortenHome(dirname(pkgJson));
					break;
				} catch {
					// Ignore unreadable package.json
				}
			}
		}
	} else if (!spec.startsWith("git:") && !spec.startsWith("https://") && !spec.startsWith("http://")) {
		const base = scope === "global" ? agentDir : join(cwd, ".pi");
		const candidateDir = resolve(base, spec);
		const pkgJson = join(candidateDir, "package.json");
		if (existsSync(pkgJson)) {
			try {
				const raw = JSON.parse(readFileSync(pkgJson, "utf-8")) as { name?: unknown; version?: unknown };
				entry.installedName = typeof raw.name === "string" ? raw.name : undefined;
				entry.installedVersion = typeof raw.version === "string" ? raw.version : undefined;
				entry.resolvedDir = shortenHome(candidateDir);
			} catch {
				// Ignore
			}
		}
	}

	return entry;
}

/**
 * Lightweight, non-executing scan of `<agentDir>/extensions` and `<cwd>/.pi/extensions`
 * for CLI `--build-info` (inside the TUI, `/version` uses the live loaded extensions).
 */
export function discoverExtensionFiles(
	agentDir: string,
	cwd: string,
): Array<Pick<Extension, "path" | "resolvedPath" | "sourceInfo">> {
	const results: Array<Pick<Extension, "path" | "resolvedPath" | "sourceInfo">> = [];
	const dirs: Array<{ dir: string; scope: "user" | "project" }> = [
		{ dir: join(agentDir, "extensions"), scope: "user" },
		{ dir: join(cwd, ".pi", "extensions"), scope: "project" },
	];
	for (const { dir, scope } of dirs) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const name of entries) {
			if (name.startsWith(".") || name.startsWith("test-")) continue;
			const full = join(dir, name);
			try {
				const st = statSync(full);
				if (st.isFile() && (extname(name) === ".ts" || extname(name) === ".js" || extname(name) === ".mjs")) {
					results.push({
						path: full,
						resolvedPath: full,
						sourceInfo: { path: full, source: "local", scope, origin: "top-level" },
					});
				} else if (st.isDirectory()) {
					const idx = ["index.ts", "index.js", "index.mjs"].map((f) => join(full, f)).find((f) => existsSync(f));
					if (idx) {
						results.push({
							path: idx,
							resolvedPath: idx,
							sourceInfo: { path: idx, source: "local", scope, origin: "top-level", baseDir: full },
						});
					}
				}
			} catch {
				// Ignore unreadable entries
			}
		}
	}
	return results;
}

export function collectVersionInfo(input: CollectVersionInfoInput): VersionInfoReport {
	const version = input.version ?? VERSION;
	const buildInfo = input.buildInfo ?? BUILD_INFO;
	const entryPath = shortenHome(safeRealpath(input.entryPath ?? process.argv[1] ?? ""));

	const plugins: PluginVersionEntry[] = [];
	for (const ext of input.extensions) {
		if (ext.hidden) continue;
		const resolved = ext.resolvedPath || ext.path;
		const isInline = resolved.startsWith("<inline:") || ext.path.startsWith("<inline:");
		const name = isInline ? ext.path : basename(resolved);
		const displayPath = isInline ? ext.path : shortenHome(resolved);

		const plugin: PluginVersionEntry = {
			name,
			path: resolved,
			displayPath,
			scope: ext.sourceInfo?.scope ?? "unknown",
			origin: ext.sourceInfo?.origin ?? "unknown",
			source: ext.sourceInfo?.source ?? "local",
		};

		if (!isInline && existsSync(resolved)) {
			try {
				const real = safeRealpath(resolved);
				const st = statSync(real);
				if (st.isFile()) {
					const bytes = readFileSync(real);
					plugin.sha256 = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
					plugin.mtimeUtc = formatUtcTimestamp(st.mtimeMs);
					plugin.declaredVersion = extractDeclaredVersion(bytes.toString("utf-8"));
				}
				const pkg = findNearestPackageJson(real, ext.sourceInfo?.baseDir);
				if (pkg) {
					plugin.packageName = pkg.name;
					plugin.packageVersion = pkg.version;
				}
				const git = probeGitStatusForFile(real);
				if (git) {
					plugin.gitCommit = git.commit;
					plugin.gitDirty = git.dirty;
				}
			} catch {
				// Leave best-effort metadata unset if file vanished after load
			}
		}

		plugins.push(plugin);
	}

	const packages: PackageVersionEntry[] = [
		...(input.globalPackages ?? []).map((p) => inspectPackage(p, "global", input.agentDir, input.cwd)),
		...(input.projectPackages ?? []).map((p) => inspectPackage(p, "project", input.agentDir, input.cwd)),
	];

	return {
		version,
		buildTag: formatBuildTag(buildInfo),
		buildInfo,
		entryPath,
		nodeVersion: process.version,
		plugins,
		pluginErrors: (input.extensionErrors ?? []).map((e) => ({ path: shortenHome(e.path), error: e.error })),
		packages,
		counts: {
			skills: input.skillCount ?? 0,
			themes: input.themeCount ?? 0,
			prompts: input.promptCount ?? 0,
		},
	};
}

function formatPluginVersionDetails(plugin: PluginVersionEntry): string {
	const parts: string[] = [];
	if (plugin.packageVersion) {
		parts.push(plugin.packageName ? `${plugin.packageName}@${plugin.packageVersion}` : `v${plugin.packageVersion}`);
	}
	if (plugin.declaredVersion) {
		parts.push(`v${plugin.declaredVersion}`);
	}
	if (plugin.gitCommit) {
		parts.push(`git:${plugin.gitCommit}${plugin.gitDirty ? "-dirty" : ""}`);
	}
	if (plugin.sha256) {
		parts.push(`sha256:${plugin.sha256}`);
	}
	if (plugin.mtimeUtc) {
		parts.push(plugin.mtimeUtc);
	}
	return parts.join(" · ");
}

export function formatVersionInfoPlain(report: VersionInfoReport): string {
	const lines: string[] = [];
	const headerVersion = report.buildTag ? `v${report.version} (${report.buildTag})` : `v${report.version}`;
	lines.push(`Pi ${headerVersion}`);
	lines.push(`  Fork:   ${report.buildInfo.fork || "unrecorded (not a tagged fork bundle)"}`);
	if (report.buildInfo.commit) {
		const dirty = report.buildInfo.dirty ? " [dirty]" : "";
		lines.push(`  Commit: ${report.buildInfo.commitShort} (${report.buildInfo.commit})${dirty}`);
	} else {
		lines.push(`  Commit: unrecorded`);
	}
	if (report.buildInfo.commitDate || report.buildInfo.commitSubject) {
		const parts = [report.buildInfo.commitDate, report.buildInfo.commitSubject].filter(Boolean);
		lines.push(`  Head:   ${parts.join(" — ")}`);
	}
	if (report.buildInfo.builtAt) {
		lines.push(`  Built:  ${report.buildInfo.builtAt}`);
	}
	lines.push(`  Entry:  ${report.entryPath || "unknown"} (Node ${report.nodeVersion})`);

	lines.push("");
	lines.push(`Plugins / Extensions (${report.plugins.length})`);
	if (report.plugins.length === 0) {
		lines.push("  (none)");
	} else {
		for (const p of report.plugins) {
			const meta = formatPluginVersionDetails(p);
			const origin = p.origin === "package" ? `${p.scope}/package` : p.scope;
			lines.push(`  ${p.name} [${origin}]${meta ? ` — ${meta}` : ""}`);
			if (p.displayPath !== p.name) {
				lines.push(`    ${p.displayPath}`);
			}
		}
	}

	if (report.pluginErrors.length > 0) {
		lines.push("");
		lines.push(`Extension Load Errors (${report.pluginErrors.length})`);
		for (const err of report.pluginErrors) {
			lines.push(`  ${err.path}: ${err.error}`);
		}
	}

	if (report.packages.length > 0) {
		lines.push("");
		lines.push(`Packages (${report.packages.length})`);
		for (const pkg of report.packages) {
			const ver = pkg.installedVersion ? `v${pkg.installedVersion}` : "version unknown";
			lines.push(`  ${pkg.spec} [${pkg.scope}] — ${ver}`);
		}
	}

	lines.push("");
	lines.push(
		`Resources: ${report.counts.themes} themes, ${report.counts.skills} skills, ${report.counts.prompts} prompt templates`,
	);
	return lines.join("\n");
}

export interface VersionTheme {
	bold(text: string): string;
	fg(color: "accent" | "dim" | "error" | "muted", text: string): string;
}

export function formatVersionInfoThemed(report: VersionInfoReport, theme: VersionTheme): string {
	const lines: string[] = [];
	const tag = report.buildTag ? ` ${theme.fg("accent", `(${report.buildTag})`)}` : "";
	lines.push(`${theme.bold(`Pi v${report.version}`)}${tag}`);
	lines.push(
		`${theme.fg("dim", "Fork:")}   ${report.buildInfo.fork || theme.fg("muted", "unrecorded (not a tagged fork bundle)")}`,
	);
	if (report.buildInfo.commit) {
		const dirty = report.buildInfo.dirty ? theme.fg("error", " [dirty]") : "";
		lines.push(
			`${theme.fg("dim", "Commit:")} ${report.buildInfo.commitShort} ${theme.fg("dim", `(${report.buildInfo.commit})`)}${dirty}`,
		);
	} else {
		lines.push(`${theme.fg("dim", "Commit:")} ${theme.fg("muted", "unrecorded")}`);
	}
	if (report.buildInfo.commitDate || report.buildInfo.commitSubject) {
		const parts = [report.buildInfo.commitDate, report.buildInfo.commitSubject].filter(Boolean);
		lines.push(`${theme.fg("dim", "Head:")}   ${parts.join(" — ")}`);
	}
	if (report.buildInfo.builtAt) {
		lines.push(`${theme.fg("dim", "Built:")}  ${report.buildInfo.builtAt}`);
	}
	lines.push(
		`${theme.fg("dim", "Entry:")}  ${report.entryPath || "unknown"} ${theme.fg("dim", `(Node ${report.nodeVersion})`)}`,
	);

	lines.push("");
	lines.push(theme.bold(`Plugins / Extensions (${report.plugins.length})`));
	if (report.plugins.length === 0) {
		lines.push(`  ${theme.fg("muted", "(none)")}`);
	} else {
		for (const p of report.plugins) {
			const meta = formatPluginVersionDetails(p);
			const origin = p.origin === "package" ? `${p.scope}/package` : p.scope;
			const metaSuffix = meta ? ` ${theme.fg("dim", "—")} ${meta}` : "";
			lines.push(`  ${theme.bold(p.name)} ${theme.fg("dim", `[${origin}]`)}${metaSuffix}`);
			if (p.displayPath !== p.name) {
				lines.push(`    ${theme.fg("muted", p.displayPath)}`);
			}
		}
	}

	if (report.pluginErrors.length > 0) {
		lines.push("");
		lines.push(theme.fg("error", `Extension Load Errors (${report.pluginErrors.length})`));
		for (const err of report.pluginErrors) {
			lines.push(`  ${theme.fg("error", err.path)}: ${err.error}`);
		}
	}

	if (report.packages.length > 0) {
		lines.push("");
		lines.push(theme.bold(`Packages (${report.packages.length})`));
		for (const pkg of report.packages) {
			const ver = pkg.installedVersion ? `v${pkg.installedVersion}` : theme.fg("muted", "version unknown");
			lines.push(`  ${pkg.spec} ${theme.fg("dim", `[${pkg.scope}] —`)} ${ver}`);
		}
	}

	lines.push("");
	lines.push(
		`${theme.fg("dim", "Resources:")} ${report.counts.themes} themes, ${report.counts.skills} skills, ${report.counts.prompts} prompt templates`,
	);
	return lines.join("\n");
}
